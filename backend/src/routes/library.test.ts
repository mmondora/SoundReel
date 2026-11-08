import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ searchLibrary: vi.fn(), getCfg: vi.fn(), setCfg: vi.fn() }));
vi.mock('../services/librarySearch', async (orig) => ({ ...(await orig<typeof import('../services/librarySearch')>()), searchLibrary: m.searchLibrary }));
vi.mock('../utils/db', async (orig) => ({
  ...(await orig<typeof import('../utils/db')>()),
  getMusicFoldersConfig: m.getCfg,
  setMusicFoldersConfig: m.setCfg,
}));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { registerConfigRoutes } from './config';
import { registerLibraryRoutes } from './library';
import { _resetMusicFoldersForTest } from '../services/musicFolders';

const USER = { 'remote-user': 'sara' };
const ADMIN = { 'remote-user': 'mike', 'remote-groups': 'admins,family' };
const app = () => {
  const a = Fastify();
  registerLibraryRoutes(a);
  registerConfigRoutes(a);
  return a;
};

describe('GET /api/library/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.searchLibrary.mockResolvedValue({ q: 'maestro bassi', scope: 'all', counts: { songs: 0, media: 1, local: 2 }, results: [] });
  });

  it('needs a signed-in user, and any signed-in user may search', async () => {
    expect((await app().inject({ method: 'GET', url: '/api/library/search?q=bassi' })).statusCode).toBe(401);
    const res = await app().inject({ method: 'GET', url: '/api/library/search?q=Maestro%20Bassi', headers: USER });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(m.searchLibrary).toHaveBeenCalledWith({ q: 'Maestro Bassi', scope: 'all', limit: undefined, userId: 'sara', isAdmin: false });
  });

  it('passes the scope and the limit; the admin sees the admin view of the journal', async () => {
    await app().inject({ method: 'GET', url: '/api/library/search?q=bassi&scope=media&limit=20', headers: ADMIN });
    expect(m.searchLibrary).toHaveBeenCalledWith({ q: 'bassi', scope: 'media', limit: 20, userId: 'mike', isAdmin: true });
  });

  it('rejects a query that is too short, an unknown scope and a nonsense limit', async () => {
    expect((await app().inject({ method: 'GET', url: '/api/library/search?q=b', headers: USER })).json()).toEqual({ error: 'query_too_short' });
    expect((await app().inject({ method: 'GET', url: '/api/library/search', headers: USER })).statusCode).toBe(400);
    expect((await app().inject({ method: 'GET', url: '/api/library/search?q=bassi&scope=disk', headers: USER })).json()).toEqual({ error: 'invalid_scope' });
    expect((await app().inject({ method: 'GET', url: '/api/library/search?q=bassi&limit=abc', headers: USER })).json()).toEqual({ error: 'invalid_limit' });
    expect(m.searchLibrary).not.toHaveBeenCalled();
  });

  it('a failure is a 500 with a plain error, not a stack', async () => {
    m.searchLibrary.mockRejectedValue(new Error('db down'));
    const res = await app().inject({ method: 'GET', url: '/api/library/search?q=bassi', headers: USER });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'library search failed' });
  });
});

describe('/api/config/music-folders (admin only: it decides what the backend reads)', () => {
  let base: string;
  let lib: string;
  let extra: string;
  let outside: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetMusicFoldersForTest();
    base = await mkdtemp(path.join(tmpdir(), 'cfg-folders-'));
    lib = path.join(base, 'music');
    extra = path.join(base, 'extra');
    outside = path.join(base, 'outside');
    for (const d of [lib, path.join(extra, 'Vecchi'), path.join(extra, 'Altro'), outside]) await mkdir(d, { recursive: true });
    await writeFile(path.join(extra, 'Vecchi', 'Old Band - Old Song.mp3'), 'x');
    process.env.MUSIC_LIBRARY_PATH = lib;
    process.env.MUSIC_EXTRA_ROOTS = extra;
    m.getCfg.mockResolvedValue([]);
    m.setCfg.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    delete process.env.MUSIC_LIBRARY_PATH;
    delete process.env.MUSIC_EXTRA_ROOTS;
    await rm(base, { recursive: true, force: true });
  });

  it('nobody but the admin may read or change it', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/api/config/music-folders' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/config/music-folders', headers: USER })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/config/music-folders', headers: USER, payload: { folders: [] } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/config/music-folders/browse', headers: USER })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/config/music-folders/rescan', headers: USER })).statusCode).toBe(403);
    expect(m.setCfg).not.toHaveBeenCalled();
  });

  it('GET lists the allowed roots and the folders with their state', async () => {
    m.getCfg.mockResolvedValue([{ id: 'e1', path: path.join(extra, 'Vecchi'), label: 'Vecchi', enabled: true }]);
    const res = await app().inject({ method: 'GET', url: '/api/config/music-folders', headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json().roots).toEqual([
      { path: lib, label: 'Libreria (cartella di Spooty)', builtIn: true },
      { path: extra, label: 'extra', builtIn: false },
    ]);
    expect(res.json().folders).toEqual([expect.objectContaining({ id: 'e1', label: 'Vecchi', status: 'pending', files: 0, builtIn: false })]);
  });

  it('POST validates, saves the real path and answers with the new list', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/config/music-folders', headers: ADMIN, payload: { folders: [{ path: path.join(extra, 'Vecchi'), label: 'Vecchi MP3' }] } });
    expect(res.statusCode).toBe(200);
    expect(m.setCfg).toHaveBeenCalledWith([expect.objectContaining({ path: path.join(extra, 'Vecchi'), label: 'Vecchi MP3', enabled: true })]);
  });

  it.each([
    ['outside the mounted roots', () => outside, 'folder_outside_roots'],
    ['a path that climbs out with ..', () => path.join(extra, '..', 'outside'), 'folder_outside_roots'],
    ['a folder that does not exist', () => path.join(extra, 'nope'), 'folder_missing'],
    ['Spooty\'s own library', () => lib, 'already_included'],
  ])('POST refuses %s and stores nothing', async (_name, pick, error) => {
    const res = await app().inject({ method: 'POST', url: '/api/config/music-folders', headers: ADMIN, payload: { folders: [{ path: pick() }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error, index: 0 });
    expect(m.setCfg).not.toHaveBeenCalled();
  });

  it('the picker lists subfolders of the extra roots only, and cannot be talked out of them', async () => {
    const a = app();
    const top = await a.inject({ method: 'GET', url: '/api/config/music-folders/browse', headers: ADMIN });
    expect(top.json()).toEqual({ path: null, parent: null, dirs: [{ name: 'extra', path: extra }] }); // the built-in library is not offered

    const inRoot = await a.inject({ method: 'GET', url: `/api/config/music-folders/browse?path=${encodeURIComponent(extra)}`, headers: ADMIN });
    expect(inRoot.json()).toEqual({ path: extra, parent: null, dirs: [{ name: 'Altro', path: path.join(extra, 'Altro') }, { name: 'Vecchi', path: path.join(extra, 'Vecchi') }] });
    const deeper = await a.inject({ method: 'GET', url: `/api/config/music-folders/browse?path=${encodeURIComponent(path.join(extra, 'Vecchi'))}`, headers: ADMIN });
    expect(deeper.json()).toMatchObject({ parent: extra, dirs: [] });

    await symlink(outside, path.join(extra, 'sneaky'));
    for (const bad of [outside, '/etc', path.join(extra, '..'), path.join(extra, 'sneaky')]) {
      const res = await a.inject({ method: 'GET', url: `/api/config/music-folders/browse?path=${encodeURIComponent(bad)}`, headers: ADMIN });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().dirs).toBeUndefined();
    }
    expect((await a.inject({ method: 'GET', url: `/api/config/music-folders/browse?path=${encodeURIComponent(path.join(extra, 'nope'))}`, headers: ADMIN })).json()).toEqual({ error: 'folder_missing' });
  });

  it('a root that is not mounted in this container is not offered (no dead ends in the picker)', async () => {
    process.env.MUSIC_EXTRA_ROOTS = `${extra},${path.join(base, 'not-mounted')}`;
    const a = app();
    const cfg = (await a.inject({ method: 'GET', url: '/api/config/music-folders', headers: ADMIN })).json();
    expect(cfg.roots.map((r: { path: string }) => r.path)).toEqual([lib, extra]);
    const top = (await a.inject({ method: 'GET', url: '/api/config/music-folders/browse', headers: ADMIN })).json();
    expect(top.dirs).toEqual([{ name: 'extra', path: extra }]);
  });

  it('rescan is accepted and answers at once', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/config/music-folders/rescan', headers: ADMIN });
    expect(res.statusCode).toBe(202);
  });
});
