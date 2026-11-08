import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), buildTracks: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), requestSongDownload: vi.fn(),
  setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(), ORDER_MONDROP: ['local', 'media'], resolveEntryMediaAbs: vi.fn(),
}));
vi.mock('../services/mondropSearch', async (orig) => ({ ...(await orig<typeof import('../services/mondropSearch')>()), searchEverything: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));

import { registerMondropRoutes } from './mondrop';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { searchEverything } from '../services/mondropSearch';

const ANSWER = { q: 'bassi maestro', tracks: [{ songKey: 'bassi maestro::capirai', title: 'Capirai' }], artists: [{ name: 'Bassi Maestro', tracks: 1 }], albums: [], total: 1, offset: 0, limit: 30 };
const get = (url: string, headers: Record<string, string> = { 'x-soundreel-key': 'sr_test' }) => {
  const app = Fastify();
  registerMondropRoutes(app);
  return app.inject({ method: 'GET', url, headers });
};

describe('GET /api/mondrop/search (ADR-0018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    vi.mocked(searchEverything).mockResolvedValue(ANSWER as never);
  });

  it('needs the API key, and searches nothing without it', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    expect((await get('/api/mondrop/search?q=bassi')).statusCode).toBe(401);
    expect(searchEverything).not.toHaveBeenCalled();
  });

  it('answers with the tracks, artists and albums, for THE USER OF THE KEY', async () => {
    const res = await get('/api/mondrop/search?q=bassi%20maestro');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ q: 'bassi maestro', total: 1, user: 'mike', artists: [{ name: 'Bassi Maestro', tracks: 1 }] });
    expect(searchEverything).toHaveBeenCalledWith({ q: 'bassi maestro', artist: null, album: null, limit: 30, offset: 0, sections: true, userId: 'mike' });
  });

  it('passes the filters and the paging of the artist and album pages', async () => {
    await get('/api/mondrop/search?artist=Bassi%20Maestro&album=Background&limit=50&offset=50&sections=0');
    expect(searchEverything).toHaveBeenCalledWith({ q: '', artist: 'Bassi Maestro', album: 'Background', limit: 50, offset: 50, sections: false, userId: 'mike' });
  });

  it('refuses an empty search and a malformed parameter with a 400 that names it', async () => {
    expect((await get('/api/mondrop/search')).json()).toEqual({ error: 'invalid_query', field: 'q' });
    const bad = await get('/api/mondrop/search?q=x&limit=500');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_query', field: 'limit' });
    expect(searchEverything).not.toHaveBeenCalled();
  });

  it('says it failed, not what failed, when the search throws', async () => {
    vi.mocked(searchEverything).mockRejectedValue(new Error('db down: password=hunter2'));
    const res = await get('/api/mondrop/search?q=x');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'search failed' });
  });
});
