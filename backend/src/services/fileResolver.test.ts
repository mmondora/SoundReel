import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getLibraryTracks: vi.fn(), lookupMediaIndex: vi.fn() }));
vi.mock('./libraryCache', () => ({ getLibraryTracks: m.getLibraryTracks }));
vi.mock('./mediaIndex', async (orig) => ({ ...(await orig<typeof import('./mediaIndex')>()), lookupMediaIndex: m.lookupMediaIndex }));

import { adoptMediaServerFile, findLibraryMatch, findMediaServerMatch, MediaVolumeMissingError } from './fileResolver';
import { MIN_MP3_BYTES } from './musicStore';

let lib: string;

const hit = (over: Record<string, unknown> = {}) =>
  ({ store: 'fritz', relPath: 'Music/Rock/Bishop Briggs - White Flag.mp3', artist: 'Bishop Briggs', title: 'White Flag', album: null, durationS: null, bytes: 5_000_000, normKey: 'k', ...over }) as never;

beforeEach(async () => {
  vi.clearAllMocks();
  lib = await mkdtemp(path.join(tmpdir(), 'res-lib-'));
  process.env.MUSIC_LIBRARY_PATH = lib;
});
afterEach(async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  await rm(lib, { recursive: true, force: true });
});

describe('findLibraryMatch', () => {
  it('finds the library file for a song and returns its real size and mtime', async () => {
    await mkdir(path.join(lib, 'Church of Scars'), { recursive: true });
    await writeFile(path.join(lib, 'Church of Scars', 'Bishop Briggs - White Flag.mp3'), 'abc');
    m.getLibraryTracks.mockResolvedValue([{ artist: 'Bishop Briggs', title: 'White Flag', album: 'Church of Scars', relPath: 'Church of Scars/Bishop Briggs - White Flag.mp3' }]);
    const match = await findLibraryMatch('Bishop Briggs', 'White Flag (Remastered)');
    expect(match).toMatchObject({ relPath: 'Church of Scars/Bishop Briggs - White Flag.mp3', facts: { bytes: 3 } });
  });

  it('ignores a cached entry whose file is gone, and songs it does not know', async () => {
    m.getLibraryTracks.mockResolvedValue([{ artist: 'A', title: 'B', album: null, relPath: 'A - B.mp3' }]);
    expect(await findLibraryMatch('A', 'B')).toBeNull(); // not on disk
    expect(await findLibraryMatch('Nobody', 'Nothing')).toBeNull();
  });
});

describe('findMediaServerMatch', () => {
  it('asks the index and applies the reuse rules (no live cuts)', async () => {
    m.lookupMediaIndex.mockResolvedValue([hit({ title: 'White Flag (Live)' }), hit({ relPath: 'Music/Rock/b.mp3', bytes: 6_000_000 })]);
    const best = await findMediaServerMatch('Bishop Briggs', 'White Flag');
    expect(best?.relPath).toBe('Music/Rock/b.mp3');
    m.lookupMediaIndex.mockResolvedValue([hit({ title: 'White Flag (Live)' })]);
    expect(await findMediaServerMatch('Bishop Briggs', 'White Flag')).toBeNull();
  });
});

describe('adoptMediaServerFile (the song IS the box\'s file: nothing is copied)', () => {
  const url = 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Rock/Bishop%20Briggs%20-%20White%20Flag.mp3';

  it('adopts the original with the size and date the box reports, and touches nothing on disk', async () => {
    const head = vi.fn().mockResolvedValue({ kind: 'ok', bytes: 5_100_000, lastModifiedMs: 1_781_000_000_000 });
    const adopted = await adoptMediaServerFile(hit({ durationS: 201 }), { head });
    expect(head).toHaveBeenCalledWith(url);
    expect(adopted).toEqual({
      bytes: 5_100_000,
      mtimeMs: 1_781_000_000_000,
      durationS: 201,
      original: { relPath: 'Music/Rock/Bishop Briggs - White Flag.mp3', url },
    });
    await expect(readdirSafe(path.join(lib, 'SoundReel'))).resolves.toBe('no store dir'); // no copy, no folder
  });

  it('does not adopt a file that vanished from the box (404 while the rest of the volume answers)', async () => {
    const volumePresent = vi.fn().mockResolvedValue(true);
    expect(await adoptMediaServerFile(hit(), { head: vi.fn().mockResolvedValue({ kind: 'missing' }), volumePresent })).toBeNull();
    expect(volumePresent).toHaveBeenCalledTimes(1);
  });

  it('a 404 is NOT believed when the whole volume is away (USB drive unplugged): the caller must wait, not download a duplicate', async () => {
    const head = vi.fn().mockResolvedValue({ kind: 'missing' });
    await expect(adoptMediaServerFile(hit(), { head, volumePresent: vi.fn().mockResolvedValue(false) })).rejects.toBeInstanceOf(MediaVolumeMissingError);
  });

  it('the control is only asked when there is a 404 to explain', async () => {
    const volumePresent = vi.fn();
    await adoptMediaServerFile(hit(), { head: vi.fn().mockResolvedValue({ kind: 'ok', bytes: 5_100_000, lastModifiedMs: 1 }), volumePresent });
    await adoptMediaServerFile(hit(), { head: vi.fn().mockResolvedValue({ kind: 'unreachable' }), volumePresent });
    expect(volumePresent).not.toHaveBeenCalled();
  });

  it('a box that does not answer is trusted on its catalogue (size from the catalogue, version date 0)', async () => {
    const adopted = await adoptMediaServerFile(hit({ bytes: 4_000_000 }), { head: vi.fn().mockResolvedValue({ kind: 'unreachable' }) });
    expect(adopted).toMatchObject({ bytes: 4_000_000, mtimeMs: 0 });
  });

  it('never adopts a stub (too small to be a song)', async () => {
    expect(await adoptMediaServerFile(hit({ bytes: MIN_MP3_BYTES - 1 }), { head: vi.fn().mockResolvedValue({ kind: 'unreachable' }) })).toBeNull();
    expect(await adoptMediaServerFile(hit({ bytes: null }), { head: vi.fn().mockResolvedValue({ kind: 'unreachable' }) })).toBeNull();
  });
});

async function readdirSafe(dir: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  try {
    await readdir(dir);
    return 'store dir exists';
  } catch {
    return 'no store dir';
  }
}
