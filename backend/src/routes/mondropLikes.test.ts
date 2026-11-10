import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
// mondrop.ts (where requireMondrop lives) imports a lot that is irrelevant here
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn(), invalidateDynamicPlaylists: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), requestSongDownload: vi.fn(),
  setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(), ORDER_MONDROP: [], resolveEntryMediaAbs: vi.fn(), buildTracks: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarning: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/songStream', () => ({ serveSong: vi.fn() }));
vi.mock('../services/songLikes', async (orig) => ({
  ...(await orig<typeof import('../services/songLikes')>()),
  listLikes: vi.fn(),
  putLike: vi.fn(),
  removeLike: vi.fn(),
}));
vi.mock('../services/likedPlaylist', async (orig) => ({ ...(await orig<typeof import('../services/likedPlaylist')>()), ensureLikedPlaylist: vi.fn() }));
vi.mock('../services/autoPlaylistStore', () => ({ PgAutoPlaylistStore: class { tag = 'the-store'; } }));
vi.mock('../utils/db', () => ({ query: vi.fn(), pool: { query: vi.fn() } }));

import { registerMondropLikesRoutes } from './mondropLikes';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { logError, logWarning } from '../utils/logger';
import { ensureLikedPlaylist } from '../services/likedPlaylist';
import { invalidateDynamicPlaylists } from '../services/playlistResolver';
import { MAX_ENCODED_SONG_KEY, MAX_SONG_KEY, listLikes, putLike, removeLike } from '../services/songLikes';

// The likes of the songs, for the app (ADR-0028, contract docs/mondrop-likes.md): the set of one person, and an idempotent PUT and DELETE of one like. The user is the
// one of the Mondrop key and nothing else; a like never fails because its playlist could not be made.

const KEY = { 'x-soundreel-key': 'sr_test' };
const NOW = new Date('2026-11-10T20:00:00.000Z');
const enc = (key: string): string => encodeURIComponent(key);

/** The app as the server builds it: the router takes a key of any length a like can have (server.ts, checked at the end of this file). */
function buildApp(options: { maxParamLength?: number } = { maxParamLength: MAX_ENCODED_SONG_KEY }) {
  const app = Fastify(options);
  registerMondropLikesRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
  vi.mocked(listLikes).mockResolvedValue([]);
  vi.mocked(putLike).mockImplementation(async (_user, _key, at) => ({ created: true, likedAt: at }));
  vi.mocked(removeLike).mockResolvedValue(true);
  vi.mocked(ensureLikedPlaylist).mockResolvedValue({ status: 'made', id: 'p-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('every like route needs the Mondrop key', () => {
  it.each([
    ['GET', '/api/mondrop/likes'],
    ['PUT', `/api/mondrop/songs/${enc('a::b')}/like`],
    ['DELETE', `/api/mondrop/songs/${enc('a::b')}/like`],
    ['PUT', `/api/mondrop/songs/${enc('   ')}/like`],                    // 401 comes before the check of the key
  ])('%s %s → 401 without a valid key, and nothing is read or written', async (method, url) => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const res = await buildApp().inject({ method: method as 'GET', url });
    expect(res.statusCode).toBe(401);
    expect(listLikes).not.toHaveBeenCalled();
    expect(putLike).not.toHaveBeenCalled();
    expect(removeLike).not.toHaveBeenCalled();
  });
});

describe('GET /api/mondrop/likes', () => {
  it('answers the contract: the user of the key, the total and the likes as the service gives them (the most recent first), never cached', async () => {
    vi.mocked(listLikes).mockResolvedValue([
      { songKey: 'daft punk::one more time', likedAt: '2026-11-10T18:00:00.000Z' },
      { songKey: 'bishop briggs::white flag', likedAt: '2026-11-09T09:00:00.000Z' },
    ]);
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/likes', headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      user: 'mike',
      total: 2,
      likes: [
        { songKey: 'daft punk::one more time', likedAt: '2026-11-10T18:00:00.000Z' },
        { songKey: 'bishop briggs::white flag', likedAt: '2026-11-09T09:00:00.000Z' },
      ],
    });
    expect(listLikes).toHaveBeenCalledTimes(1);
    expect(listLikes).toHaveBeenCalledWith('mike');
  });

  it('a person with no like gets an empty list, not an error', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/likes', headers: KEY });
    expect(res.json()).toEqual({ user: 'mike', total: 0, likes: [] });
  });

  it('is the likes of THE person of the key: another key, another person, and nobody can ask for someone else\'s (query, header, body: nothing picks the user)', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'sara', device: 'iPhone di Sara' } });
    const res = await buildApp().inject({
      method: 'GET', url: '/api/mondrop/likes?user=mike&userId=mike', headers: { ...KEY, 'x-soundreel-user': 'mike' },
    });
    expect(res.json().user).toBe('sara');
    expect(listLikes).toHaveBeenCalledTimes(1);
    expect(listLikes).toHaveBeenCalledWith('sara');
    expect(listLikes).not.toHaveBeenCalledWith('mike');
  });

  it('a failure is a 500 with a fixed word, and what went wrong only in the log', async () => {
    vi.mocked(listLikes).mockRejectedValue(new Error('connection to 10.0.0.5 refused'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/likes', headers: KEY });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'likes_failed' });
    expect(res.body).not.toContain('10.0.0.5');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('GET /api/mondrop/likes'), expect.objectContaining({ err: expect.stringContaining('10.0.0.5') }));
  });
});

describe('PUT /api/mondrop/songs/:key/like', () => {
  const put = (key: string, body?: unknown, headers: Record<string, string> = KEY) =>
    buildApp().inject({
      method: 'PUT', url: `/api/mondrop/songs/${enc(key)}/like`,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });

  it('puts the like of the person of the key, on the key as the app wrote it (percent-decoded), and answers the contract', async () => {
    const res = await put('daft punk::one more time', { at: '2026-11-10T17:58:00.000Z' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ songKey: 'daft punk::one more time', liked: true, likedAt: '2026-11-10T17:58:00.000Z' });
    expect(putLike).toHaveBeenCalledTimes(1);
    expect(putLike).toHaveBeenCalledWith('mike', 'daft punk::one more time', new Date('2026-11-10T17:58:00.000Z'));
  });

  it('keeps the accents, the punctuation and the spaces inside the key exactly', async () => {
    const res = await put('beyoncé::halo (live)');
    expect(res.json().songKey).toBe('beyoncé::halo (live)');
    expect(vi.mocked(putLike).mock.calls[0][1]).toBe('beyoncé::halo (live)');
  });

  it('with no body the moment is now', async () => {
    const res = await put('a::b');
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(putLike).mock.calls[0][2]).toEqual(NOW);
    expect(res.json().likedAt).toBe(NOW.toISOString());
  });

  it('never puts a like in the future: the moment is the earlier of the one the app says and now', async () => {
    await put('a::b', { at: '2031-01-01T00:00:00.000Z' });
    expect(vi.mocked(putLike).mock.calls[0][2]).toEqual(NOW);
  });

  it('a moment that is not a date, or a body that is not an object, is ignored: now, and never an error', async () => {
    for (const body of [{ at: 'banana' }, { at: 12 }, { at: null }, {}, [], 'x', 7, true]) {
      vi.mocked(putLike).mockClear();
      const res = await put('a::b', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      expect(vi.mocked(putLike).mock.calls[0][2]).toEqual(NOW);
    }
  });

  it('answers with the FIRST date when the like was already there (idempotent), and makes nothing', async () => {
    vi.mocked(putLike).mockResolvedValue({ created: false, likedAt: new Date('2026-11-01T10:00:00.000Z') });
    const res = await put('a::b', { at: '2026-11-10T17:58:00.000Z' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ songKey: 'a::b', liked: true, likedAt: '2026-11-01T10:00:00.000Z' });
    expect(ensureLikedPlaylist).not.toHaveBeenCalled();
    expect(invalidateDynamicPlaylists).not.toHaveBeenCalled();
  });

  it('makes the playlist «Mi piace» of the person at a NEW like, with the moment of the server, and the lists of dynamic playlists are made again', async () => {
    await put('a::b', { at: '2026-11-10T17:58:00.000Z' });
    expect(ensureLikedPlaylist).toHaveBeenCalledTimes(1);
    expect(ensureLikedPlaylist).toHaveBeenCalledWith(expect.anything(), { owner: 'mike', at: NOW });
    expect(invalidateDynamicPlaylists).toHaveBeenCalledTimes(1);
  });

  it('is the playlist of the person of the key, whoever the body names', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'sara', device: 'iPhone di Sara' } });
    const res = await put('a::b', { at: '2026-11-10T17:58:00.000Z', user: 'mike', userId: 'mike' });
    expect(res.statusCode).toBe(200);
    expect(putLike).toHaveBeenCalledWith('sara', 'a::b', expect.any(Date));
    expect(ensureLikedPlaylist).toHaveBeenCalledWith(expect.anything(), { owner: 'sara', at: NOW });
  });

  it('a like never fails because of its playlist: a warning in the log, the like stands, the answer is 200', async () => {
    vi.mocked(ensureLikedPlaylist).mockRejectedValue(new Error('playlists table locked'));
    const res = await put('a::b');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ songKey: 'a::b', liked: true });
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('Mi piace'), expect.objectContaining({ user: 'mike', err: expect.stringContaining('playlists table locked') }));
    expect(logError).not.toHaveBeenCalled();
    expect(invalidateDynamicPlaylists).toHaveBeenCalled();
  });

  it('an empty key, a key of spaces or a key longer than the limit is a 400 invalid_song_key, and nothing is written', async () => {
    for (const key of [' ', '   ', 'k'.repeat(MAX_SONG_KEY + 1)]) {
      const res = await put(key);
      expect(res.statusCode, key.slice(0, 10)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_song_key' });
    }
    expect(putLike).not.toHaveBeenCalled();
    expect(ensureLikedPlaylist).not.toHaveBeenCalled();
  });

  it('a key of exactly the limit is fine, even when every character takes nine characters once percent-encoded (the router accepts it)', async () => {
    const worst = '日'.repeat(MAX_SONG_KEY);
    expect(enc(worst).length).toBe(MAX_ENCODED_SONG_KEY);
    const res = await buildApp().inject({ method: 'PUT', url: `/api/mondrop/songs/${enc(worst)}/like`, headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(putLike).mock.calls[0][1]).toBe(worst);
  });

  it('a failure of the database is a 500 with a fixed word, the error only in the log, and no playlist is made', async () => {
    vi.mocked(putLike).mockRejectedValue(new Error('deadlock detected'));
    const res = await put('a::b');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'likes_failed' });
    expect(res.body).not.toContain('deadlock');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('PUT /api/mondrop/songs/:songKey/like'), expect.objectContaining({ err: expect.stringContaining('deadlock') }));
    expect(ensureLikedPlaylist).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/mondrop/songs/:key/like', () => {
  const del = (key: string) => buildApp().inject({ method: 'DELETE', url: `/api/mondrop/songs/${enc(key)}/like`, headers: KEY });

  it('removes the like of the person of the key and answers the contract', async () => {
    const res = await del('daft punk::one more time');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ songKey: 'daft punk::one more time', liked: false });
    expect(removeLike).toHaveBeenCalledTimes(1);
    expect(removeLike).toHaveBeenCalledWith('mike', 'daft punk::one more time');
    expect(invalidateDynamicPlaylists).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a like that was not there is fine, the same answer, and nothing changed so nothing is made again', async () => {
    vi.mocked(removeLike).mockResolvedValue(false);
    const res = await del('a::b');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ songKey: 'a::b', liked: false });
    expect(invalidateDynamicPlaylists).not.toHaveBeenCalled();
  });

  it('never makes a playlist: removing a like is not a reason', async () => {
    await del('a::b');
    expect(ensureLikedPlaylist).not.toHaveBeenCalled();
  });

  it('is the like of THE person of the key', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'sara', device: 'iPhone di Sara' } });
    await del('a::b');
    expect(removeLike).toHaveBeenCalledWith('sara', 'a::b');
    expect(removeLike).not.toHaveBeenCalledWith('mike', expect.anything());
  });

  it('a key that is empty or too long is a 400 invalid_song_key, and nothing is removed', async () => {
    for (const key of ['  ', 'k'.repeat(MAX_SONG_KEY + 1)]) {
      const res = await del(key);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_song_key' });
    }
    expect(removeLike).not.toHaveBeenCalled();
  });

  it('a failure of the database is a 500 with a fixed word, the error only in the log', async () => {
    vi.mocked(removeLike).mockRejectedValue(new Error('too many connections'));
    const res = await del('a::b');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'likes_failed' });
    expect(res.body).not.toContain('connections');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('DELETE /api/mondrop/songs/:songKey/like'), expect.objectContaining({ err: expect.stringContaining('too many connections') }));
  });
});

// ---------------------------------------------------------------------------------------------------------------- server.ts
const raw = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
// comments do not count: a registration that is commented out is no registration
const server = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('server.ts and the likes', () => {
  it('registers the routes once, next to the other /api/mondrop ones (they have the key, Traefik bypasses Authelia there)', () => {
    expect(server).toContain("import { registerMondropLikesRoutes } from './routes/mondropLikes';");
    expect(server.match(/registerMondropLikesRoutes\(app\);/g)).toHaveLength(1);
    const at = server.indexOf('registerMondropLikesRoutes(app);');
    expect(at).toBeGreaterThan(server.indexOf('registerMondropInboxRoutes(app);'));
    expect(at).toBeLessThan(server.indexOf('registerMeRoute(app);'));            // the routes behind Authelia come after
  });

  it('lets the router take the longest key a like can have (500 characters, nine each once percent-encoded): the default of 100 would answer 404 to a long title of classical music, and the app would take it for an old server', () => {
    expect(server).toContain("import { MAX_ENCODED_SONG_KEY } from './services/songLikes';");
    const at = server.indexOf('maxParamLength: MAX_ENCODED_SONG_KEY');
    expect(at).toBeGreaterThan(server.indexOf('Fastify({'));
    expect(at).toBeLessThan(server.indexOf('await app.register(fastifyCors'));      // inside the options of the server, not somewhere else
    expect(MAX_ENCODED_SONG_KEY).toBe(MAX_SONG_KEY * 9);
  });
});
