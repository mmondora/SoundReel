import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  absFromRel,
  checkMp3,
  fileFacts,
  fileVersion,
  MIN_MP3_BYTES,
  placeIntoStore,
  relFromAbs,
  sanitizeName,
  storeFileName,
  sweepStaleFiles,
} from './musicStore';

let root: string;
let staging: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'store-lib-'));
  staging = await mkdtemp(path.join(tmpdir(), 'store-stage-'));
  delete process.env.MUSIC_STORE_DIR;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

const fakeMp3 = (bytes = MIN_MP3_BYTES + 100): Buffer => {
  const b = Buffer.alloc(bytes, 0x41);
  b.write('ID3', 0, 'latin1');
  return b;
};

describe('file naming (exFAT / NTFS safe, library-scanner compatible)', () => {
  it('strips the characters the stick cannot hold and trailing dots/spaces', () => {
    expect(sanitizeName('AC/DC: Back In Black?')).toBe('AC DC Back In Black');
    expect(sanitizeName('  Why?...  ')).toBe('Why');
    expect(sanitizeName('a\u0000b\tc')).toBe('a b c');
    expect(sanitizeName('x'.repeat(300))).toHaveLength(120);
  });

  it('names files "Artist - Title.mp3" (first " - " is what the scanner splits on) and survives a missing artist', () => {
    expect(storeFileName('Bishop Briggs', 'White Flag')).toBe('Bishop Briggs - White Flag.mp3');
    expect(storeFileName('', 'Intro')).toBe('Intro.mp3');
    expect(storeFileName('Artist', '???')).toBe('Artist - Senza titolo.mp3');
  });
});

describe('library-relative paths never escape the library root', () => {
  it('resolves inside, refuses traversal', () => {
    expect(absFromRel('SoundReel/a.mp3', root)).toBe(path.join(root, 'SoundReel', 'a.mp3'));
    expect(absFromRel('../etc/passwd', root)).toBeNull();
    expect(absFromRel('SoundReel/../../x', root)).toBeNull();
    expect(absFromRel('a.mp3', null)).toBeNull();
  });

  it('turns an absolute path back into a posix relative path, or null when outside', () => {
    expect(relFromAbs(path.join(root, 'SoundReel', 'a.mp3'), root)).toBe('SoundReel/a.mp3');
    expect(relFromAbs('/etc/passwd', root)).toBeNull();
  });
});

describe('checkMp3', () => {
  it('accepts an ID3-tagged file and a bare MPEG frame, refuses stubs, HTML and missing files', async () => {
    const id3 = path.join(staging, 'a.mp3');
    await writeFile(id3, fakeMp3());
    expect(await checkMp3(id3)).toMatchObject({ ok: true });

    const frame = path.join(staging, 'b.mp3');
    const raw = Buffer.alloc(MIN_MP3_BYTES + 10, 0);
    raw[10] = 0xff;
    raw[11] = 0xfb;
    await writeFile(frame, raw);
    expect(await checkMp3(frame)).toMatchObject({ ok: true });

    const tiny = path.join(staging, 'c.mp3');
    await writeFile(tiny, fakeMp3(100));
    expect(await checkMp3(tiny)).toMatchObject({ ok: false, reason: expect.stringContaining('troppo piccolo') });

    const html = path.join(staging, 'd.mp3');
    await writeFile(html, Buffer.from('<html>'.padEnd(MIN_MP3_BYTES + 10, ' ')));
    expect(await checkMp3(html)).toMatchObject({ ok: false, reason: 'non sembra un MP3' });

    expect(await checkMp3(path.join(staging, 'nope.mp3'))).toMatchObject({ ok: false });
  });
});

describe('placeIntoStore', () => {
  it('moves the download into <library>/SoundReel under its final name, leaves no .part and no staging file', async () => {
    const src = path.join(staging, 'job-1.mp3');
    await writeFile(src, fakeMp3());

    const placed = await placeIntoStore(src, 'Bishop Briggs', 'White Flag', { libRoot: root });

    expect(placed.relPath).toBe('SoundReel/Bishop Briggs - White Flag.mp3');
    expect(placed.absPath).toBe(path.join(root, 'SoundReel', 'Bishop Briggs - White Flag.mp3'));
    expect(placed.bytes).toBe(MIN_MP3_BYTES + 100);
    expect(await readdir(path.join(root, 'SoundReel'))).toEqual(['Bishop Briggs - White Flag.mp3']);
    expect(await readdir(staging)).toEqual([]);
    expect((await readFile(placed.absPath)).subarray(0, 3).toString('latin1')).toBe('ID3');
  });

  it('never overwrites a file that belongs to another song: numbers the new one', async () => {
    await mkdir(path.join(root, 'SoundReel'), { recursive: true });
    await writeFile(path.join(root, 'SoundReel', 'A - B.mp3'), 'other song');
    const src = path.join(staging, 'j.mp3');
    await writeFile(src, fakeMp3());

    const placed = await placeIntoStore(src, 'A', 'B', { libRoot: root });

    expect(placed.relPath).toBe('SoundReel/A - B (2).mp3');
    expect(await readFile(path.join(root, 'SoundReel', 'A - B.mp3'), 'utf8')).toBe('other song');
  });

  it('replaces the song’s own previous file when asked to (a better version)', async () => {
    const first = path.join(staging, '1.mp3');
    await writeFile(first, fakeMp3());
    const a = await placeIntoStore(first, 'A', 'B', { libRoot: root });

    const second = path.join(staging, '2.mp3');
    await writeFile(second, fakeMp3(MIN_MP3_BYTES + 5000));
    const b = await placeIntoStore(second, 'A', 'B', { libRoot: root, replaceRelPath: a.relPath });

    expect(b.relPath).toBe(a.relPath);
    expect(b.bytes).toBe(MIN_MP3_BYTES + 5000);
    expect(await readdir(path.join(root, 'SoundReel'))).toEqual(['A - B.mp3']);
  });

  it('fails cleanly (no half file) when the staging file is missing', async () => {
    await expect(placeIntoStore(path.join(staging, 'gone.mp3'), 'A', 'B', { libRoot: root })).rejects.toThrow();
    expect(await readdir(path.join(root, 'SoundReel'))).toEqual([]);
  });

  it('honours MUSIC_STORE_DIR and refuses to run without a library root', async () => {
    process.env.MUSIC_STORE_DIR = 'Incoming/Songs';
    const src = path.join(staging, 'x.mp3');
    await writeFile(src, fakeMp3());
    const placed = await placeIntoStore(src, 'A', 'B', { libRoot: root });
    expect(placed.relPath).toBe('Incoming/Songs/A - B.mp3');

    const prev = process.env.MUSIC_LIBRARY_PATH;
    delete process.env.MUSIC_LIBRARY_PATH;
    await expect(placeIntoStore(src, 'A', 'B')).rejects.toThrow('MUSIC_LIBRARY_PATH');
    if (prev !== undefined) process.env.MUSIC_LIBRARY_PATH = prev;
  });
});

describe('file identity', () => {
  it('version changes with size or mtime, facts are null for missing files and directories', async () => {
    const f = path.join(staging, 'v.mp3');
    await writeFile(f, 'abc');
    const facts = await fileFacts(f);
    expect(facts).not.toBeNull();
    expect(fileVersion(facts!)).toBe(`${facts!.bytes}-${facts!.mtimeMs}`);
    expect(fileVersion({ bytes: 1, mtimeMs: 2 })).not.toBe(fileVersion({ bytes: 1, mtimeMs: 3 }));
    expect(await fileFacts(path.join(staging, 'none'))).toBeNull();
    expect(await fileFacts(staging)).toBeNull();
  });
});

describe('sweepStaleFiles (what interrupted work leaves behind)', () => {
  const age = async (p: string, ms: number): Promise<void> => {
    const t = new Date(Date.now() - ms);
    await utimes(p, t, t);
  };

  it('removes old matching files and directories, keeps recent ones and everything that does not match', async () => {
    await writeFile(path.join(staging, 'old.mp3.part'), 'x');
    await writeFile(path.join(staging, 'new.mp3.part'), 'x');
    await writeFile(path.join(staging, 'old-keep.mp3'), 'x');
    await mkdir(path.join(staging, '.work-sf-1'));
    await writeFile(path.join(staging, '.work-sf-1', 'audio.mp3'), 'x');
    await age(path.join(staging, 'old.mp3.part'), 3 * 3600_000);
    await age(path.join(staging, 'old-keep.mp3'), 3 * 3600_000);
    await age(path.join(staging, '.work-sf-1'), 3 * 3600_000);

    const removed = await sweepStaleFiles(staging, {
      maxAgeMs: 3600_000,
      match: (n) => n.endsWith('.part') || n.startsWith('.work-'),
    });

    expect(removed.sort()).toEqual(['.work-sf-1', 'old.mp3.part']);
    expect((await readdir(staging)).sort()).toEqual(['new.mp3.part', 'old-keep.mp3']);
  });

  it('a folder that does not exist yet is nothing to clean', async () => {
    expect(await sweepStaleFiles(path.join(staging, 'nope'), { maxAgeMs: 1, match: () => true })).toEqual([]);
  });
});
