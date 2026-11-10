import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn(), addSongToPlaylist: vi.fn(), removeSongFromPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), buildTracks: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), requestSongDownload: vi.fn(),
  setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(), ORDER_MONDROP: ['local', 'media'], resolveEntryMediaAbs: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));

import { registerMondropRoutes } from './mondrop';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { addSongToPlaylist, removeSongFromPlaylist } from '../services/playlists';
import { getTrack } from '../services/offlineManifest';
import { logActivity } from '../services/activityLog';
import { logError } from '../utils/logger';

const KEY = 'bassi maestro::foto di gruppo';
const post = (id: string, body: unknown, headers: Record<string, string> = { 'x-soundreel-key': 'sr_test' }) => {
  const app = Fastify();
  registerMondropRoutes(app);
  return app.inject({ method: 'POST', url: `/api/mondrop/playlists/${id}/songs`, headers, payload: body as never });
};

describe('POST /api/mondrop/playlists/:id/songs (ADR-0018: a song that is only a file goes in a playlist too)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    vi.mocked(getTrack).mockResolvedValue({ songKey: KEY, title: 'Foto di gruppo', artist: 'Bassi Maestro' } as never);
    vi.mocked(addSongToPlaylist).mockResolvedValue({ id: 'p1', name: 'Rap', kind: 'static', songKeys: ['a::b', KEY] } as never);
  });

  it('needs the API key, and touches nothing without it', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    expect((await post('p1', { songKey: KEY })).statusCode).toBe(401);
    expect(addSongToPlaylist).not.toHaveBeenCalled();
  });

  it('adds the song for THE USER OF THE KEY, who must own the playlist, and says how many songs it has now', async () => {
    const res = await post('p1', { songKey: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, playlist: { id: 'p1', name: 'Rap', songs: 2 }, user: 'mike' });
    expect(addSongToPlaylist).toHaveBeenCalledWith('p1', KEY, 'mike');
    expect(getTrack).toHaveBeenCalledWith(KEY, 'mike', false); // the song he can see: from the journal or a file
  });

  it('writes a line in the activity log, with who and from which device', async () => {
    await post('p1', { songKey: KEY });
    const [category, action, message, actor, data] = vi.mocked(logActivity).mock.calls[0];
    expect([category, action]).toEqual(['playlist', 'add_song']);
    expect(message).toContain('«Foto di gruppo – Bassi Maestro»');
    expect(message).toContain('«Rap»');
    expect(actor).toMatchObject({ user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' });
    expect(data).toMatchObject({ playlistId: 'p1', songKey: KEY, songs: 2 });
  });

  it('refuses a missing, blank, non-text or absurdly long song key with a 400, before looking at anything', async () => {
    for (const body of [{}, { songKey: '' }, { songKey: '   ' }, { songKey: 42 }, { songKey: ['a'] }, { songKey: 'x'.repeat(501) }, undefined]) {
      expect((await post('p1', body)).statusCode).toBe(400);
    }
    expect(getTrack).not.toHaveBeenCalled();
    expect(addSongToPlaylist).not.toHaveBeenCalled();
  });

  it('a song nobody knows (no journal entry, no file) is a 404 and is NOT put in the playlist', async () => {
    vi.mocked(getTrack).mockResolvedValue(null);
    const res = await post('p1', { songKey: 'ghost::song' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'song not found' });
    expect(addSongToPlaylist).not.toHaveBeenCalled();
  });

  it('a playlist that is not his (not found, or only shared with him: read-only) is a 404', async () => {
    vi.mocked(addSongToPlaylist).mockResolvedValue(null);
    const res = await post('somebody-elses', { songKey: KEY });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'playlist not found' });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('a dynamic playlist is a rule, not a list: 409', async () => {
    vi.mocked(addSongToPlaylist).mockRejectedValue(new Error('playlist_is_dynamic'));
    const res = await post('d1', { songKey: KEY });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'playlist_is_dynamic' });
    expect(logError).not.toHaveBeenCalled();
  });

  it('says it failed, not what failed, when something else throws', async () => {
    vi.mocked(addSongToPlaylist).mockRejectedValue(new Error('db down: password=hunter2'));
    const res = await post('p1', { songKey: KEY });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ ok: false, error: 'playlist add song failed' });
  });
});

// ---------------------------------------------------------------------------------------------------------------- the swipe «Togli dalla playlist»
// The mirror of the POST (spec 2026-11-10-mondrop-simplify-playlists-and-song-states-design.md U7): only the owner of a STATIC playlist takes a song out of it,
// the user is only the one of the key, and it is idempotent. `:songKey` arrives already decoded by the router: decoding it again breaks a key that has a `%`.
const MAX_ENCODED_PARAM = 5000;   // what server.ts gives the router (`maxParamLength`)
const del = (id: string, songKey: string, headers: Record<string, string> = { 'x-soundreel-key': 'sr_test' }, query = '') => {
  const app = Fastify({ maxParamLength: MAX_ENCODED_PARAM });
  registerMondropRoutes(app);
  return app.inject({ method: 'DELETE', url: `/api/mondrop/playlists/${id}/songs/${encodeURIComponent(songKey)}${query}`, headers });
};

describe('DELETE /api/mondrop/playlists/:id/songs/:songKey (the swipe «Togli dalla playlist»)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    vi.mocked(getTrack).mockResolvedValue({ songKey: KEY, title: 'Foto di gruppo', artist: 'Bassi Maestro' } as never);
    vi.mocked(removeSongFromPlaylist).mockResolvedValue({ id: 'p1', name: 'Rap', kind: 'static', songKeys: ['a::b'] } as never);
  });

  it('needs the API key (401 before anything, even before the key of the song is looked at), and touches nothing without it', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    expect((await del('p1', KEY)).statusCode).toBe(401);
    expect((await del('p1', '   ')).statusCode).toBe(401);
    expect(removeSongFromPlaylist).not.toHaveBeenCalled();
    expect(getTrack).not.toHaveBeenCalled();
  });

  it('takes the song out for THE USER OF THE KEY, who must own the playlist, and says how many songs it has now', async () => {
    const res = await del('p1', KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, playlist: { id: 'p1', name: 'Rap', songs: 1 }, user: 'mike' });
    expect(removeSongFromPlaylist).toHaveBeenCalledTimes(1);
    expect(removeSongFromPlaylist).toHaveBeenCalledWith('p1', KEY, 'mike');
  });

  it('is the user of the key and nothing else: another key is another person, and the query and the headers choose nobody', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'sara', device: 'iPhone di Sara' } });
    const res = await del('p1', KEY, { 'x-soundreel-key': 'sr_test', 'x-soundreel-user': 'mike' }, '?user=mike');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toBe('sara');
    expect(removeSongFromPlaylist).toHaveBeenCalledWith('p1', KEY, 'sara');
    expect(removeSongFromPlaylist).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'mike');
  });

  it('gets the key already decoded and does not decode it again: a key with a «%» (or a «%41» that is not an A) reaches the playlist as it is', async () => {
    for (const key of ['100% pure::love', 'ac%41dc::back in black', 'a::b (50% live)', 'beyoncé::halo']) {
      vi.mocked(removeSongFromPlaylist).mockClear();
      expect((await del('p1', key)).statusCode).toBe(200);
      expect(removeSongFromPlaylist).toHaveBeenCalledWith('p1', key, 'mike');
    }
  });

  it('trims the key, like the POST that stored it', async () => {
    const res = await del('p1', `  ${KEY}  `);
    expect(res.statusCode).toBe(200);
    expect(removeSongFromPlaylist).toHaveBeenCalledWith('p1', KEY, 'mike');
  });

  it('is idempotent: a song that is not there (or a playlist that no longer has it, or a song that no longer exists anywhere) is not an error, the same 200', async () => {
    vi.mocked(getTrack).mockResolvedValue(null);
    const res = await del('p1', 'ghost::song');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, playlist: { id: 'p1', name: 'Rap', songs: 1 }, user: 'mike' });
  });

  it('writes a line in the activity log like the POST, with who and from which device, and with the label of the song when it is known', async () => {
    await del('p1', KEY);
    const [category, action, message, actor, data] = vi.mocked(logActivity).mock.calls[0];
    expect([category, action]).toEqual(['playlist', 'remove_song']);
    expect(message).toContain('«Foto di gruppo – Bassi Maestro»');
    expect(message).toContain('«Rap»');
    expect(actor).toMatchObject({ user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' });
    expect(data).toEqual({ playlistId: 'p1', name: 'Rap', songKey: KEY, songs: 1 });
  });

  it('writes the line with a readable fallback when the song is unknown, and even when looking it up fails (removing must not depend on it)', async () => {
    vi.mocked(getTrack).mockRejectedValue(new Error('library down'));
    const res = await del('p1', 'ghost::lost song');
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(logActivity).mock.calls[0][2]).toContain('«lost song – ghost»');
  });

  it('refuses a blank or absurdly long song key with a 400, before looking at anything', async () => {
    for (const key of ['   ', 'x'.repeat(501)]) {
      const res = await del('p1', key);
      expect(res.statusCode, key.slice(0, 5)).toBe(400);
      expect(res.json()).toEqual({ error: 'songKey is required' });
    }
    expect(getTrack).not.toHaveBeenCalled();
    expect(removeSongFromPlaylist).not.toHaveBeenCalled();
  });

  it('accepts a key of exactly 500 characters (the limit of the POST)', async () => {
    const res = await del('p1', 'k'.repeat(500));
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(removeSongFromPlaylist).mock.calls[0][1]).toBe('k'.repeat(500));
  });

  it('a playlist that is not his (not found, or only shared with him: read-only) is a 404, and nothing is written in the log', async () => {
    vi.mocked(removeSongFromPlaylist).mockResolvedValue(null);
    const res = await del('somebody-elses', KEY);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'playlist not found' });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('a dynamic playlist is a rule, not a list: 409, and it is not an error of the server', async () => {
    vi.mocked(removeSongFromPlaylist).mockRejectedValue(new Error('playlist_is_dynamic'));
    const res = await del('d1', KEY);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'playlist_is_dynamic' });
    expect(logError).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('says it failed, not what failed, when something else throws; the error only in the log', async () => {
    vi.mocked(removeSongFromPlaylist).mockRejectedValue(new Error('db down: password=hunter2'));
    const res = await del('p1', KEY);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ ok: false, error: 'playlist remove song failed' });
    expect(res.body).not.toContain('hunter2');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('DELETE /api/mondrop/playlists/:id/songs/:songKey'), expect.objectContaining({ id: 'p1', err: expect.stringContaining('hunter2') }));
    expect(logActivity).not.toHaveBeenCalled();
  });
});
