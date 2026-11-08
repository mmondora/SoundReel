import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  removeSongFromPlaylist: vi.fn(),
  listPlaylists: vi.fn(),
  getPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  createDynamicPlaylist: vi.fn(),
  updatePlaylistRule: vi.fn(),
  renamePlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addSongToPlaylist: vi.fn(),
  reorderPlaylistSongs: vi.fn(),
  listPlaylistShares: vi.fn(),
  sharePlaylist: vi.fn(),
  unsharePlaylist: vi.fn(),
}));
const res = vi.hoisted(() => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn(), invalidateDynamicPlaylists: vi.fn() }));
const songs = vi.hoisted(() => ({ getUserSongs: vi.fn() }));
const act = vi.hoisted(() => ({ logActivity: vi.fn() }));
vi.mock('../services/playlists', () => svc);
vi.mock('../services/playlistResolver', () => res);
vi.mock('../services/userSongs', () => songs);
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: act.logActivity }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { registerPlaylistsRoutes } from './playlists';
import { PRESETS } from '../services/dynamicRules';

const H = { 'remote-user': 'mike' };
const app = () => {
  const a = Fastify();
  registerPlaylistsRoutes(a);
  return a;
};
const pl = (over: Record<string, unknown> = {}) => ({ id: 'p1', name: 'Road trip', songCount: 2, songKeys: ['a::b', 'c::d'], kind: 'static', ownerUser: 'mike', createdAt: '', updatedAt: '', ...over });
const lines = () => act.logActivity.mock.calls.map((c) => ({ category: c[0], action: c[1], message: c[2], actor: c[3], data: c[4] }));
const night = PRESETS.find((p) => p.id === 'night')!.rule;

beforeEach(() => {
  vi.clearAllMocks();
  res.resolveSummaries.mockImplementation(async (l: unknown) => l);
  res.resolveDetail.mockImplementation(async (p: unknown) => p);
  songs.getUserSongs.mockResolvedValue(new Map([['bishop briggs::white flag', { title: 'White Flag', artist: 'Bishop Briggs' }]]));
});

describe('reading', () => {
  it('lists playlists with the live count of the dynamic ones, and offers the presets', async () => {
    svc.listPlaylists.mockResolvedValue([pl()]);
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/api/playlists', headers: H })).json().playlists).toHaveLength(1);
    expect(res.resolveSummaries).toHaveBeenCalledWith([pl()], { userId: 'mike', isAdmin: false });
    const presets = (await a.inject({ method: 'GET', url: '/api/playlists/dynamic/presets' })).json().presets;
    expect(presets.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['night', 'morning', 'weekend']));
    expect(presets[0]).toMatchObject({ label: expect.any(String), ruleSummary: expect.stringContaining('·') });
  });

  it('a playlist comes back with its live songs; 404 when it is not visible', async () => {
    svc.getPlaylist.mockResolvedValue(pl({ kind: 'dynamic' }));
    res.resolveDetail.mockResolvedValue(pl({ kind: 'dynamic', songKeys: ['x::y'], generatedAt: 't' }));
    expect((await app().inject({ method: 'GET', url: '/api/playlists/p1', headers: H })).json().playlist.songKeys).toEqual(['x::y']);
    svc.getPlaylist.mockResolvedValue(null);
    expect((await app().inject({ method: 'GET', url: '/api/playlists/nope', headers: H })).statusCode).toBe(404);
  });
});

describe('creating — who, when, what', () => {
  it('a static playlist is logged with its name and how many songs it started with', async () => {
    svc.createPlaylist.mockResolvedValue(pl({ songKeys: ['a::b'] }));
    const out = await app().inject({ method: 'POST', url: '/api/playlists', headers: H, payload: { name: 'Road trip', songKeys: ['a::b', 'c::d'] } });
    expect(out.statusCode).toBe(201);
    expect(lines()).toEqual([{
      category: 'playlist', action: 'create', message: 'mike ha creato la playlist «Road trip» con 2 brani',
      actor: { user: 'mike', channel: 'web' }, data: { playlistId: 'p1', name: 'Road trip', kind: 'static', songs: 2 },
    }]);
  });

  it('a dynamic playlist needs a valid rule (400 names the field) and is logged with its rule in words', async () => {
    const a = app();
    svc.createDynamicPlaylist.mockResolvedValue(pl({ id: 'd1', name: 'Notte', kind: 'dynamic', songKeys: [] }));
    const bad = await a.inject({ method: 'POST', url: '/api/playlists', headers: H, payload: { name: 'Notte', kind: 'dynamic', rule: { limit: 999 } } });
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'invalid_rule:limit' }]);
    expect((await a.inject({ method: 'POST', url: '/api/playlists', headers: H, payload: { name: 'Notte', kind: 'dynamic' } })).json()).toEqual({ error: 'rule_required' });
    expect(svc.createDynamicPlaylist).not.toHaveBeenCalled();

    const ok = await a.inject({ method: 'POST', url: '/api/playlists', headers: H, payload: { name: 'Notte', kind: 'dynamic', rule: night } });
    expect(ok.statusCode).toBe(201);
    expect(svc.createDynamicPlaylist).toHaveBeenCalledWith('Notte', night, 'mike');
    expect(lines()[0]).toMatchObject({ action: 'create', message: 'mike ha creato la playlist dinamica «Notte»: Più ascoltate · 22:00–06:00 · ultimi 90 giorni · max 50' });
  });

  it('refuses an unknown kind and a missing name', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/api/playlists', headers: H, payload: { name: 'x', kind: 'smart' } })).json()).toEqual({ error: 'invalid_kind' });
    expect((await a.inject({ method: 'POST', url: '/api/playlists', headers: H, payload: { name: ' ' } })).json()).toEqual({ error: 'name is required' });
    expect(lines()).toEqual([]);
  });
});

describe('songs ↔ playlist — the association is logged', () => {
  it('adding says which song went into which playlist', async () => {
    svc.addSongToPlaylist.mockResolvedValue(pl({ songKeys: ['bishop briggs::white flag'] }));
    await app().inject({ method: 'POST', url: '/api/playlists/p1/songs', headers: H, payload: { songKey: 'bishop briggs::white flag' } });
    expect(lines()).toEqual([expect.objectContaining({
      action: 'add_song', message: 'mike ha aggiunto «White Flag – Bishop Briggs» alla playlist «Road trip»',
      data: expect.objectContaining({ playlistId: 'p1', songKey: 'bishop briggs::white flag', songs: 1 }),
    })]);
  });

  it('a song unknown to the journal is still labelled (from its key) and a failing lookup never blocks the action', async () => {
    svc.addSongToPlaylist.mockResolvedValue(pl());
    songs.getUserSongs.mockRejectedValue(new Error('db down'));
    const r = await app().inject({ method: 'POST', url: '/api/playlists/p1/songs', headers: H, payload: { songKey: 'ghost::track' } });
    expect(r.statusCode).toBe(200);
    expect(lines()[0].message).toBe('mike ha aggiunto «track – ghost» alla playlist «Road trip»');
  });

  it('removing and reordering are logged too, with the song count', async () => {
    svc.removeSongFromPlaylist.mockResolvedValue(pl({ songKeys: ['c::d'] }));
    svc.reorderPlaylistSongs.mockResolvedValue(pl());
    const a = app();
    await a.inject({ method: 'DELETE', url: '/api/playlists/p1/songs/bishop%20briggs%3A%3Awhite%20flag', headers: H });
    await a.inject({ method: 'PUT', url: '/api/playlists/p1/songs', headers: H, payload: { songKeys: ['c::d', 'a::b'] } });
    expect(lines().map((l) => [l.action, l.message])).toEqual([
      ['remove_song', 'mike ha tolto «White Flag – Bishop Briggs» dalla playlist «Road trip»'],
      ['reorder', 'mike ha riordinato la playlist «Road trip» (2 brani)'],
    ]);
  });

  it('nothing is logged when the playlist is not the caller\'s (404)', async () => {
    svc.addSongToPlaylist.mockResolvedValue(null);
    svc.removeSongFromPlaylist.mockResolvedValue(null);
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/api/playlists/x/songs', headers: H, payload: { songKey: 'a::b' } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'DELETE', url: '/api/playlists/x/songs/a%3A%3Ab', headers: H })).statusCode).toBe(404);
    expect(lines()).toEqual([]);
  });

  it('hand edits of a dynamic playlist are refused with 409 and leave no line', async () => {
    svc.addSongToPlaylist.mockRejectedValue(new Error('playlist_is_dynamic'));
    svc.removeSongFromPlaylist.mockRejectedValue(new Error('playlist_is_dynamic'));
    svc.reorderPlaylistSongs.mockRejectedValue(new Error('playlist_is_dynamic'));
    const a = app();
    for (const r of [
      await a.inject({ method: 'POST', url: '/api/playlists/d1/songs', headers: H, payload: { songKey: 'a::b' } }),
      await a.inject({ method: 'DELETE', url: '/api/playlists/d1/songs/a%3A%3Ab', headers: H }),
      await a.inject({ method: 'PUT', url: '/api/playlists/d1/songs', headers: H, payload: { songKeys: ['a::b'] } }),
    ]) {
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'playlist_is_dynamic' }]);
    }
    expect(lines()).toEqual([]);
  });

  it('the song key reaches the service decoded exactly once (a literal % in a name survives; so does a slash)', async () => {
    svc.removeSongFromPlaylist.mockResolvedValue(pl());
    const a = app();
    await a.inject({ method: 'DELETE', url: '/api/playlists/p1/songs/50%25%20off%3A%3Asong', headers: H });
    await a.inject({ method: 'DELETE', url: '/api/playlists/p1/songs/ac%2Fdc%3A%3Aback%20in%20black', headers: H });
    expect(svc.removeSongFromPlaylist.mock.calls.map((c) => c.slice(0, 2))).toEqual([['p1', '50% off::song'], ['p1', 'ac/dc::back in black']]);
  });
});

describe('renaming, changing a rule, deleting, sharing', () => {
  it('rename logs old → new; the same name logs nothing', async () => {
    svc.getPlaylist.mockResolvedValue(pl());
    svc.renamePlaylist.mockResolvedValueOnce(pl({ name: 'Viaggio' })).mockResolvedValueOnce(pl());
    const a = app();
    await a.inject({ method: 'PATCH', url: '/api/playlists/p1', headers: H, payload: { name: 'Viaggio' } });
    await a.inject({ method: 'PATCH', url: '/api/playlists/p1', headers: H, payload: { name: 'Road trip' } });
    expect(lines()).toEqual([expect.objectContaining({ action: 'rename', message: 'mike ha rinominato la playlist «Road trip» in «Viaggio»' })]);
  });

  it('changing a rule: validated, 404 when not yours, 409 on a static playlist, logged in words', async () => {
    const a = app();
    svc.getPlaylist.mockResolvedValue(pl({ kind: 'dynamic' }));
    expect((await a.inject({ method: 'PATCH', url: '/api/playlists/d1', headers: H, payload: { rule: { order: 'loudest' } } })).json()).toEqual({ error: 'invalid_rule:order' });
    svc.updatePlaylistRule.mockResolvedValueOnce(null).mockResolvedValueOnce('not_dynamic').mockResolvedValueOnce(pl({ id: 'd1', name: 'Notte', kind: 'dynamic' }));
    expect((await a.inject({ method: 'PATCH', url: '/api/playlists/d1', headers: H, payload: { rule: night } })).statusCode).toBe(404);
    const stat = await a.inject({ method: 'PATCH', url: '/api/playlists/s1', headers: H, payload: { rule: night } });
    expect([stat.statusCode, stat.json()]).toEqual([409, { error: 'playlist_is_static' }]);
    const ok = await a.inject({ method: 'PATCH', url: '/api/playlists/d1', headers: H, payload: { rule: night } });
    expect(ok.statusCode).toBe(200);
    expect(res.invalidateDynamicPlaylists).toHaveBeenCalled();
    expect(lines()).toEqual([expect.objectContaining({ action: 'rule_update', message: 'mike ha cambiato la regola di «Notte»: Più ascoltate · 22:00–06:00 · ultimi 90 giorni · max 50' })]);
  });

  it('a PATCH with nothing to change is a 400', async () => {
    const a = app();
    expect((await a.inject({ method: 'PATCH', url: '/api/playlists/p1', headers: H, payload: {} })).json()).toEqual({ error: 'name_or_rule_required' });
    expect((await a.inject({ method: 'PATCH', url: '/api/playlists/p1', headers: H, payload: { name: '  ' } })).json()).toEqual({ error: 'name is required' });
  });

  it('delete logs the name and size it had, read before it was gone', async () => {
    svc.getPlaylist.mockResolvedValue(pl({ songCount: 12 }));
    svc.deletePlaylist.mockResolvedValue(true);
    await app().inject({ method: 'DELETE', url: '/api/playlists/p1', headers: H });
    expect(lines()).toEqual([expect.objectContaining({ action: 'delete', message: 'mike ha eliminato la playlist «Road trip» (12 brani)' })]);
    vi.clearAllMocks();
    svc.deletePlaylist.mockResolvedValue(false);
    expect((await app().inject({ method: 'DELETE', url: '/api/playlists/x', headers: H })).statusCode).toBe(404);
    expect(lines()).toEqual([]);
  });

  it('sharing and unsharing say with whom', async () => {
    svc.getPlaylist.mockResolvedValue(pl());
    svc.sharePlaylist.mockResolvedValue(['sara']);
    svc.unsharePlaylist.mockResolvedValue([]);
    const a = app();
    await a.inject({ method: 'POST', url: '/api/playlists/p1/share', headers: H, payload: { with: ['sara', 'mike', 'stranger'] } });
    await a.inject({ method: 'DELETE', url: '/api/playlists/p1/share?with=sara', headers: H });
    expect(lines().map((l) => l.message)).toEqual(['mike ha condiviso «Road trip» con sara', 'mike ha smesso di condividere «Road trip» con sara']);
  });
});
