import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../utils/db', () => ({ listEntries: vi.fn() }));
vi.mock('./songMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./songMeta')>();
  return {
    songKey: actual.songKey,
    listSongMeta: vi.fn(),
    patchSongUserMeta: vi.fn(),
  };
});
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import { scanLibrary, normalizeForMatch, libraryHasSong, syncDownloadedFlags } from './musicLibrary';
import { listEntries } from '../utils/db';
import { listSongMeta, patchSongUserMeta } from './songMeta';
import { logWarning } from '../utils/logger';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'musiclib-'));
}

async function writeFile(root: string, relPath: string, content = ''): Promise<void> {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

describe('scanLibrary', () => {
  const originalEnv = process.env.MUSIC_LIBRARY_PATH;
  let tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDirs = [];
  });

  afterEach(async () => {
    process.env.MUSIC_LIBRARY_PATH = originalEnv;
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('returns [] and logs a warning when MUSIC_LIBRARY_PATH is unset and no root is passed', async () => {
    delete process.env.MUSIC_LIBRARY_PATH;
    const result = await scanLibrary();
    expect(result).toEqual([]);
    expect(logWarning).toHaveBeenCalledTimes(1);
  });

  it('returns [] and logs a warning when the root is missing/unreadable', async () => {
    const result = await scanLibrary('/nonexistent/path/for/soundreel-test');
    expect(result).toEqual([]);
    expect(logWarning).toHaveBeenCalledTimes(1);
  });

  it('parses "Artist - Title.mp3" at the root, album null', async () => {
    const dir = await mkTmpDir();
    tmpDirs.push(dir);
    await writeFile(dir, 'Queen - Bohemian Rhapsody.mp3');

    const result = await scanLibrary(dir);
    expect(result).toEqual([{ artist: 'Queen', title: 'Bohemian Rhapsody', album: null }]);
  });

  it('splits on the FIRST " - " only, keeping remaining dashes in the title', async () => {
    const dir = await mkTmpDir();
    tmpDirs.push(dir);
    await writeFile(dir, 'Patty Pravo & Federico Scavo - La bambola - Federico Scavo Remix.mp3');

    const result = await scanLibrary(dir);
    expect(result).toEqual([
      { artist: 'Patty Pravo & Federico Scavo', title: 'La bambola - Federico Scavo Remix', album: null },
    ]);
  });

  it('treats a file with no " - " as title-only, artist empty', async () => {
    const dir = await mkTmpDir();
    tmpDirs.push(dir);
    await writeFile(dir, 'JustATitle.mp3');

    const result = await scanLibrary(dir);
    expect(result).toEqual([{ artist: '', title: 'JustATitle', album: null }]);
  });

  it('uses the immediate parent directory as album for nested files', async () => {
    const dir = await mkTmpDir();
    tmpDirs.push(dir);
    await writeFile(dir, path.join('Arabic Indie Electronic', 'Bedouin Burger, Zeid Hamdan - Some Track.mp3'));
    await writeFile(dir, path.join('Big Calm', 'Kanye West - Runaway.mp3'));

    const result = await scanLibrary(dir);
    expect(result).toEqual(
      expect.arrayContaining([
        { artist: 'Bedouin Burger, Zeid Hamdan', title: 'Some Track', album: 'Arabic Indie Electronic' },
        { artist: 'Kanye West', title: 'Runaway', album: 'Big Calm' },
      ])
    );
  });

  it('only matches .mp3 files, case-insensitively, ignoring other extensions', async () => {
    const dir = await mkTmpDir();
    tmpDirs.push(dir);
    await writeFile(dir, 'Artist - Track.MP3');
    await writeFile(dir, 'notes.txt');
    await writeFile(dir, 'Artist - Other.wav');

    const result = await scanLibrary(dir);
    expect(result).toEqual([{ artist: 'Artist', title: 'Track', album: null }]);
  });
});

describe('normalizeForMatch', () => {
  it('lowercases and collapses internal whitespace', () => {
    expect(normalizeForMatch('  Hello   World  ')).toBe('hello world');
  });

  it('strips a single trailing (...) group', () => {
    expect(normalizeForMatch('Where Is My Mind? (2007 Remaster)')).toBe(normalizeForMatch('Where Is My Mind?'));
    expect(normalizeForMatch('Where Is My Mind? (2007 Remaster)')).toBe('where is my mind?');
  });

  it('strips trailing (...) and [...] groups repeatedly', () => {
    expect(normalizeForMatch('Title (Live) [Remaster]')).toBe('title');
  });

  it('does not strip a non-trailing parenthetical', () => {
    expect(normalizeForMatch('Song (feat. X) Extended')).toBe('song (feat. x) extended');
  });
});

describe('libraryHasSong', () => {
  const tracks = [
    { artist: 'Kanye West', title: 'Runaway', album: null },
    { artist: 'Bedouin Burger, Zeid Hamdan', title: 'Some Track', album: 'Arabic Indie Electronic' },
    { artist: '', title: 'Where Is My Mind?', album: null },
  ];

  it('matches exact title and artist, case-insensitively', () => {
    expect(libraryHasSong(tracks, 'kanye west', 'RUNAWAY')).toBe(true);
  });

  it('matches when the DB artist is a substring of a multi-credit file artist', () => {
    expect(libraryHasSong(tracks, 'Bedouin Burger', 'Some Track')).toBe(true);
  });

  it('matches when the file artist is a substring of a multi-credit DB artist', () => {
    expect(libraryHasSong(tracks, 'Kanye West, Pusha T', 'Runaway')).toBe(true);
  });

  it('matches when the file has no artist (title-only filename)', () => {
    expect(libraryHasSong(tracks, 'Pixies', 'Where Is My Mind? (2007 Remaster)')).toBe(true);
  });

  it('does not match when the title differs', () => {
    expect(libraryHasSong(tracks, 'Kanye West', 'Stronger')).toBe(false);
  });

  it('does not match when both artists are non-empty and unrelated', () => {
    const withUnrelated = [{ artist: 'Some Other Artist', title: 'Runaway', album: null }];
    expect(libraryHasSong(withUnrelated, 'Kanye West', 'Runaway')).toBe(false);
  });
});

function entry(id: string, createdAt: string, songs: unknown[]) {
  return { id, createdAt, results: { songs } } as never;
}

describe('syncDownloadedFlags', () => {
  const originalEnv = process.env.MUSIC_LIBRARY_PATH;
  let tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDirs = [];
  });

  afterEach(async () => {
    process.env.MUSIC_LIBRARY_PATH = originalEnv;
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('returns all-zero counts without touching the DB when the library is empty/unavailable', async () => {
    delete process.env.MUSIC_LIBRARY_PATH;

    const result = await syncDownloadedFlags();
    expect(result).toEqual({ scanned: 0, matched: 0, updated: 0 });
    expect(listEntries).not.toHaveBeenCalled();
    expect(patchSongUserMeta).not.toHaveBeenCalled();
  });

  it('marks a matching, not-yet-downloaded song as downloaded (false -> true only)', async () => {
    const dir = await mkTmpDir();
    tmpDirs.push(dir);
    await writeFile(dir, 'Queen - Bohemian Rhapsody.mp3');
    await writeFile(dir, 'Already Downloaded Artist - Already Downloaded Song.mp3');
    await writeFile(dir, 'Nomatch Artist - Nomatch Song.mp3');
    process.env.MUSIC_LIBRARY_PATH = dir;

    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [
        { title: 'Bohemian Rhapsody', artist: 'Queen', album: null, youtubeUrl: null, spotifyUrl: null },
        {
          title: 'Already Downloaded Song', artist: 'Already Downloaded Artist',
          album: null, youtubeUrl: null, spotifyUrl: null,
        },
        { title: 'Not In Library', artist: 'Nobody', album: null, youtubeUrl: null, spotifyUrl: null },
      ]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(
      new Map([
        [
          'already downloaded artist::already downloaded song',
          { downloaded: true } as never,
        ],
      ])
    );
    vi.mocked(patchSongUserMeta).mockResolvedValue({} as never);

    const result = await syncDownloadedFlags();

    expect(result).toEqual({ scanned: 3, matched: 2, updated: 1 });
    expect(patchSongUserMeta).toHaveBeenCalledTimes(1);
    expect(patchSongUserMeta).toHaveBeenCalledWith('queen::bohemian rhapsody', { downloaded: true });
  });
});
