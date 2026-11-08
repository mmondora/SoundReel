import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ markMediaOnly: vi.fn(), logActivity: vi.fn(), invalidate: vi.fn() }));
vi.mock('./songFiles', () => ({ listLegacyCopies: vi.fn(), markMediaOnly: m.markMediaOnly }));
vi.mock('./fileResolver', () => ({ findMediaServerMatch: vi.fn() }));
vi.mock('./libraryCache', () => ({ invalidateLibraryTracks: m.invalidate }));
vi.mock('./activityLog', async (orig) => ({ ...(await orig<typeof import('./activityLog')>()), logActivity: m.logActivity }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { retireMediaServerCopies } from './retireCopies';

let lib: string;
const BYTES = 1234;

const row = (over: Record<string, unknown> = {}) =>
  ({ songKey: 'kavinsky::nightcall', artist: 'Kavinsky', title: 'Nightcall', relPath: 'SoundReel/Kavinsky - Nightcall.mp3', mediaRelPath: null, ...over }) as never;

const put = async (rel: string, bytes = BYTES): Promise<string> => {
  const abs = path.join(lib, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.alloc(bytes, 1));
  return abs;
};
const ok = (bytes = BYTES) => vi.fn().mockResolvedValue({ kind: 'ok', bytes, lastModifiedMs: 1_781_000_000_000 });
const hit = (bytes: number | null = BYTES) => vi.fn().mockResolvedValue({ relPath: 'Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3', bytes });

beforeEach(async () => {
  vi.clearAllMocks();
  lib = await mkdtemp(path.join(tmpdir(), 'retire-'));
  process.env.MUSIC_LIBRARY_PATH = lib;
});
afterEach(async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  await rm(lib, { recursive: true, force: true });
});

describe('retireMediaServerCopies (ADR-0010: the song IS the box file, the 2.7.0 copy goes)', () => {
  it('removes a copy whose byte-identical original answers on the box, and turns the row into a media-only one', async () => {
    const abs = await put('SoundReel/Kavinsky - Nightcall.mp3');
    const res = await retireMediaServerCopies({ list: async () => [row()], head: ok(), findOriginal: hit() });

    expect(res).toEqual({ retired: 1, kept: 0 });
    expect(existsSync(abs)).toBe(false);
    expect(m.markMediaOnly).toHaveBeenCalledWith('kavinsky::nightcall', {
      bytes: BYTES,
      mtimeMs: 1_781_000_000_000,
      original: {
        relPath: 'Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3',
        url: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3',
      },
    });
    expect(m.logActivity).toHaveBeenCalledWith('download', 'retire_copy', expect.stringContaining('Nightcall'), expect.anything(), expect.objectContaining({ removed: 'SoundReel/Kavinsky - Nightcall.mp3' }));
  });

  it('uses the recorded original when the row has one (no catalogue lookup needed)', async () => {
    await put('SoundReel/Kavinsky - Nightcall.mp3');
    const findOriginal = vi.fn();
    const res = await retireMediaServerCopies({
      list: async () => [row({ mediaRelPath: 'Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3' })],
      head: ok(),
      findOriginal,
    });
    expect(res.retired).toBe(1);
    expect(findOriginal).not.toHaveBeenCalled();
  });

  it.each([
    ['the box does not answer (asleep)', { head: vi.fn().mockResolvedValue({ kind: 'unreachable' }), findOriginal: hit() }],
    ['the original is gone from the box', { head: vi.fn().mockResolvedValue({ kind: 'missing' }), findOriginal: hit() }],
    ['the original has a different size (not the file the copy came from)', { head: ok(BYTES + 1), findOriginal: hit() }],
    ['the catalogue hit has a different size', { head: ok(), findOriginal: hit(BYTES + 1) }],
    ['no original is known at all', { head: ok(), findOriginal: vi.fn().mockResolvedValue(null) }],
  ])('keeps the copy when %s', async (_name, deps) => {
    const abs = await put('SoundReel/Kavinsky - Nightcall.mp3');
    const res = await retireMediaServerCopies({ list: async () => [row()], ...deps });
    expect(res).toEqual({ retired: 0, kept: 1 });
    expect(existsSync(abs)).toBe(true);
    expect(m.markMediaOnly).not.toHaveBeenCalled();
  });

  it('never deletes outside the store folder, whatever the row says', async () => {
    const abs = await put('Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3');
    const res = await retireMediaServerCopies({
      list: async () => [row({ relPath: 'Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3' }), row({ relPath: '../escape.mp3' })],
      head: ok(),
      findOriginal: hit(),
    });
    expect(res).toEqual({ retired: 0, kept: 2 });
    expect(existsSync(abs)).toBe(true);
  });

  it('a copy that is already gone from the disk is left to the normal handling', async () => {
    const res = await retireMediaServerCopies({ list: async () => [row()], head: ok(), findOriginal: hit() });
    expect(res).toEqual({ retired: 0, kept: 1 });
  });

  it('does nothing without a library', async () => {
    delete process.env.MUSIC_LIBRARY_PATH;
    expect(await retireMediaServerCopies({ list: async () => [row()] })).toEqual({ retired: 0, kept: 0 });
  });
});
