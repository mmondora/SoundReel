import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../utils/db', () => ({ getMusicFoldersConfig: m.get, setMusicFoldersConfig: m.set }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import {
  MAX_FOLDERS,
  _resetMusicFoldersForTest,
  allowedRoots,
  getFolderStates,
  getLocalFiles,
  libraryDisplayRoot,
  parseTrackName,
  refreshMusicFolders,
  saveMusicFolders,
  scanFolder,
  validateFolders,
} from './musicFolders';

let base: string;
let lib: string; // stands for /music
let extra: string; // stands for /music-extra
let outside: string; // a folder that is NOT mounted for music

const touch = async (rel: string, bytes = 3): Promise<void> => {
  await mkdir(path.dirname(rel), { recursive: true });
  await writeFile(rel, Buffer.alloc(bytes, 1));
};
const env = (): NodeJS.ProcessEnv => ({ MUSIC_LIBRARY_PATH: lib, MUSIC_EXTRA_ROOTS: extra }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  vi.clearAllMocks();
  _resetMusicFoldersForTest();
  base = await mkdtemp(path.join(tmpdir(), 'folders-'));
  lib = path.join(base, 'music');
  extra = path.join(base, 'music-extra');
  outside = path.join(base, 'secrets');
  await mkdir(lib, { recursive: true });
  await mkdir(extra, { recursive: true });
  await mkdir(outside, { recursive: true });
  process.env.MUSIC_LIBRARY_PATH = lib;
  process.env.MUSIC_EXTRA_ROOTS = extra;
  m.get.mockResolvedValue([]);
  m.set.mockResolvedValue(undefined);
});
afterEach(async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  delete process.env.MUSIC_EXTRA_ROOTS;
  await rm(base, { recursive: true, force: true });
});

describe('allowed roots', () => {
  it('are Spooty\'s library (built in) plus the extra roots, defaulting to /music-extra', () => {
    expect(allowedRoots({ MUSIC_LIBRARY_PATH: '/music' } as NodeJS.ProcessEnv)).toEqual([
      { path: '/music', label: 'Libreria (cartella di Spooty)', builtIn: true },
      { path: '/music-extra', label: 'music-extra', builtIn: false },
    ]);
    expect(allowedRoots({ MUSIC_LIBRARY_PATH: '/music', MUSIC_EXTRA_ROOTS: '/a, /b/c ,/a,relative' } as NodeJS.ProcessEnv).map((r) => r.path)).toEqual(['/music', '/a', '/b/c']);
  });

  it('the library shows as ~/Music unless told otherwise', () => {
    expect(libraryDisplayRoot({} as NodeJS.ProcessEnv)).toBe('~/Music');
    expect(libraryDisplayRoot({ MUSIC_LIBRARY_LABEL: 'geekom:~/Music/' } as NodeJS.ProcessEnv)).toBe('geekom:~/Music');
  });
});

describe('validateFolders — a path typed in a form must never reach beyond the mounted roots', () => {
  const ok = async (input: unknown) => validateFolders(input, env());

  it('accepts a folder inside an extra root, with its real path, a stable id and a label', async () => {
    await mkdir(path.join(extra, 'Vecchi MP3'), { recursive: true });
    const res = await ok([{ path: path.join(extra, 'Vecchi MP3'), label: '  Vecchi   MP3 ' }]);
    expect(res).toMatchObject({ ok: true, folders: [{ path: path.join(extra, 'Vecchi MP3'), label: 'Vecchi MP3', enabled: true }] });
    const again = await ok([{ path: path.join(extra, 'Vecchi MP3') }]);
    expect(again.ok && again.folders[0].id).toBe(res.ok && res.folders[0].id);
    expect(again.ok && again.folders[0].label).toBe('Vecchi MP3'); // default = folder name
  });

  it('refuses anything outside the roots: another folder, `..`, and a symlink that points out', async () => {
    await mkdir(path.join(extra, 'ok'), { recursive: true });
    expect(await ok([{ path: outside }])).toMatchObject({ ok: false, error: 'folder_outside_roots', index: 0 });
    expect(await ok([{ path: path.join(extra, '..', 'secrets') }])).toMatchObject({ ok: false, error: 'folder_outside_roots' });
    await symlink(outside, path.join(extra, 'sneaky'));
    expect(await ok([{ path: path.join(extra, 'sneaky') }])).toMatchObject({ ok: false, error: 'folder_outside_roots' });
    expect(await ok([{ path: '/etc' }])).toMatchObject({ ok: false, error: 'folder_outside_roots' });
  });

  it('refuses what is not a usable folder', async () => {
    await touch(path.join(extra, 'file.mp3'));
    expect(await ok([{ path: path.join(extra, 'nope') }])).toMatchObject({ ok: false, error: 'folder_missing' });
    expect(await ok([{ path: path.join(extra, 'file.mp3') }])).toMatchObject({ ok: false, error: 'folder_not_directory' });
    expect(await ok([{ path: 'relative/dir' }])).toMatchObject({ ok: false, error: 'invalid_folder' });
    expect(await ok([{}])).toMatchObject({ ok: false, error: 'invalid_folder' });
    expect(await ok('not a list')).toMatchObject({ ok: false, error: 'invalid_folder' });
  });

  it('the library itself (and anything inside it) is already searched: no second copy of it', async () => {
    await mkdir(path.join(lib, 'Bassi Maestro'), { recursive: true });
    expect(await ok([{ path: lib }])).toMatchObject({ ok: false, error: 'already_included' });
    expect(await ok([{ path: path.join(lib, 'Bassi Maestro') }])).toMatchObject({ ok: false, error: 'already_included' });
  });

  it('folds duplicates, keeps the switch, and caps the number of folders', async () => {
    await mkdir(path.join(extra, 'a'), { recursive: true });
    const res = await ok([{ path: path.join(extra, 'a') }, { path: path.join(extra, 'a', '..', 'a'), enabled: false }]);
    expect(res.ok && res.folders).toHaveLength(1);
    await mkdir(path.join(extra, 'b'), { recursive: true });
    const off = await ok([{ path: path.join(extra, 'b'), enabled: false }]);
    expect(off.ok && off.folders[0].enabled).toBe(false);
    expect(await ok(Array.from({ length: MAX_FOLDERS + 1 }, () => ({ path: extra })))).toMatchObject({ ok: false, error: 'too_many_folders' });
  });

  it('with no mounted roots nothing is allowed', async () => {
    expect(await validateFolders([{ path: extra }], { MUSIC_LIBRARY_PATH: path.join(base, 'absent'), MUSIC_EXTRA_ROOTS: path.join(base, 'absent2') } as NodeJS.ProcessEnv))
      .toMatchObject({ ok: false, error: 'folder_outside_roots' });
  });
});

describe('parseTrackName', () => {
  it.each([
    ['Bassi Maestro - Foto di gruppo.mp3', { artist: 'Bassi Maestro', title: 'Foto di gruppo', album: null }],
    ['Bassi Maestro/Bassi Maestro, Fabri Fibra - Non muovono il collo.mp3', { artist: 'Bassi Maestro, Fabri Fibra', title: 'Non muovono il collo', album: 'Bassi Maestro' }],
    ['Kavinsky/Nightcall/01 - Nightcall.mp3', { artist: 'Kavinsky', title: 'Nightcall', album: 'Nightcall' }],
    ['Kavinsky/OutRun/1-02 Odd Look.flac', { artist: 'Kavinsky', title: 'Odd Look', album: 'OutRun' }],
    ['Mix/07 - Daft Punk - Digital Love.mp3', { artist: 'Daft Punk', title: 'Digital Love', album: 'Mix' }],
    ['2 Unlimited - No Limit.mp3', { artist: '2 Unlimited', title: 'No Limit', album: null }],
    ['Mix/Daft Punk/07 Digital Love.mp3', { artist: 'Mix', title: 'Digital Love', album: 'Daft Punk' }],
    ['Intro.mp3', { artist: '', title: 'Intro', album: null }],
  ])('%s', (rel, expected) => {
    expect(parseTrackName(rel)).toEqual(expected);
  });
});

describe('scanFolder', () => {
  it('lists audio files only, skips hidden entries and AppleDouble shadows, and does not follow symlinks', async () => {
    await touch(path.join(lib, 'Bassi Maestro', 'Bassi Maestro - Foto di gruppo.mp3'), 100);
    await touch(path.join(lib, 'Bassi Maestro', '._Bassi Maestro - Foto di gruppo.mp3'), 4096);
    await touch(path.join(lib, 'Bassi Maestro', '.DS_Store'));
    await touch(path.join(lib, 'Bassi Maestro', 'cover.jpg'));
    await touch(path.join(lib, '.hidden', 'Secret - Song.mp3'));
    await touch(path.join(lib, 'live.FLAC'));
    await touch(path.join(outside, 'Outside - Song.mp3'));
    await symlink(outside, path.join(lib, 'link'));
    await symlink(path.join(outside, 'Outside - Song.mp3'), path.join(lib, 'file-link.mp3'));

    const res = await scanFolder(lib);
    expect(res.files.map((f) => f.relPath)).toEqual(['live.FLAC', 'Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3']);
    expect(res.files[1]).toMatchObject({ artist: 'Bassi Maestro', title: 'Foto di gruppo', bytes: 100 });
    expect(res.truncated).toBe(false);
  });

  it('stops at the depth and file caps and says so', async () => {
    await touch(path.join(lib, 'a', 'b', 'c', 'deep.mp3'));
    await touch(path.join(lib, 'one.mp3'));
    await touch(path.join(lib, 'two.mp3'));
    await touch(path.join(lib, 'three.mp3'));
    expect((await scanFolder(lib, { maxDepth: 1 })).files.map((f) => f.relPath)).not.toContain('a/b/c/deep.mp3');
    const capped = await scanFolder(lib, { maxFiles: 2 });
    expect(capped.files).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
});

describe('the in-memory state (what the search reads)', () => {
  it('indexes Spooty\'s library and the enabled extra folders, each file tagged with where it came from', async () => {
    await touch(path.join(lib, 'Bassi Maestro', 'Bassi Maestro - Foto di gruppo.mp3'));
    await touch(path.join(extra, 'Vecchi', 'Old Band - Old Song.mp3'));
    await touch(path.join(extra, 'Spenta', 'Off - Off.mp3'));
    m.get.mockResolvedValue([
      { id: 'e1', path: path.join(extra, 'Vecchi'), label: 'Vecchi MP3', enabled: true },
      { id: 'e2', path: path.join(extra, 'Spenta'), label: 'Spenta', enabled: false },
      { id: 'e3', path: path.join(extra, 'Sparita'), label: 'Sparita', enabled: true },
    ]);

    await refreshMusicFolders();

    expect(getLocalFiles().map((f) => [f.folderId, f.folderLabel, f.builtIn, f.relPath])).toEqual([
      ['library', 'Libreria (cartella di Spooty)', true, 'Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3'],
      ['e1', 'Vecchi MP3', false, 'Old Band - Old Song.mp3'],
    ]);
    expect(getFolderStates().map((s) => [s.id, s.status, s.files])).toEqual([['library', 'ok', 1], ['e1', 'ok', 1], ['e2', 'off', 0], ['e3', 'missing', 0]]);
  });

  it('a saved change is stored and rescanned in the background; removed folders disappear from the index', async () => {
    await touch(path.join(extra, 'Vecchi', 'Old Band - Old Song.mp3'));
    m.get.mockResolvedValue([{ id: 'e1', path: path.join(extra, 'Vecchi'), label: 'Vecchi', enabled: true }]);
    await refreshMusicFolders();
    expect(getLocalFiles().some((f) => f.folderId === 'e1')).toBe(true);

    m.get.mockResolvedValue([]);
    await saveMusicFolders([]);
    expect(m.set).toHaveBeenCalledWith([]);
    await vi.waitFor(() => expect(getLocalFiles().some((f) => f.folderId === 'e1')).toBe(false));
  });

  it('a stored folder that was later replaced by a link to somewhere else is never walked', async () => {
    await touch(path.join(outside, 'Secret - Song.mp3'));
    await touch(path.join(extra, 'Vecchi', 'Old Band - Old Song.mp3'));
    m.get.mockResolvedValue([{ id: 'e1', path: path.join(extra, 'Vecchi'), label: 'Vecchi', enabled: true }]);
    await refreshMusicFolders();
    expect(getLocalFiles().some((f) => f.folderId === 'e1')).toBe(true);

    await rm(path.join(extra, 'Vecchi'), { recursive: true, force: true });
    await symlink(outside, path.join(extra, 'Vecchi')); // same path, now pointing out of the roots
    await refreshMusicFolders();
    expect(getLocalFiles().some((f) => f.folderId === 'e1')).toBe(false);
    expect(getFolderStates().find((s) => s.id === 'e1')).toMatchObject({ status: 'missing', files: 0 });
  });

  it('an unreadable configuration never breaks the library scan', async () => {
    await touch(path.join(lib, 'A - B.mp3'));
    m.get.mockRejectedValue(new Error('db down'));
    await refreshMusicFolders();
    expect(getLocalFiles().map((f) => f.relPath)).toEqual(['A - B.mp3']);
  });
});
