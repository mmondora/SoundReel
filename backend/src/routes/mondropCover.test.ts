import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn(), addSongToPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), buildTracks: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), requestSongDownload: vi.fn(),
  setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(), ORDER_MONDROP: ['local', 'media'], resolveEntryMediaAbs: vi.fn(),
  getSongCover: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));

import { registerMondropRoutes } from './mondrop';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { getSongCover } from '../services/offlineManifest';
import { logError } from '../utils/logger';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const COVER = { bytes: JPEG, contentType: 'image/jpeg' as const, etag: '"c-0123456789abcdef"', source: 'itunes' as const };

const ask = (key = 'bassi maestro::capirai', headers: Record<string, string> = { 'x-soundreel-key': 'sr_test' }) => {
  const app = Fastify();
  registerMondropRoutes(app);
  return app.inject({ method: 'GET', url: `/api/mondrop/songs/${encodeURIComponent(key)}/cover`, headers });
};

describe('GET /api/mondrop/songs/:songKey/cover (ADR-0019: the server finds the cover, the app only asks SoundReel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    vi.mocked(getSongCover).mockResolvedValue(COVER);
  });

  it('needs the API key, and looks for nothing without it', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    expect((await ask()).statusCode).toBe(401);
    expect(getSongCover).not.toHaveBeenCalled();
  });

  it('sends the image, for THE USER OF THE KEY, with a type, an ETag and a private cache', async () => {
    const res = await ask();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers.etag).toBe(COVER.etag);
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.rawPayload.equals(JPEG)).toBe(true);
    expect(getSongCover).toHaveBeenCalledWith('bassi maestro::capirai', 'mike', false);
  });

  it('answers 304 with no body to a client that already has this version', async () => {
    const res = await ask('bassi maestro::capirai', { 'x-soundreel-key': 'sr_test', 'if-none-match': COVER.etag });
    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
    expect(res.headers.etag).toBe(COVER.etag);
  });

  it('says «no cover» (404) when there is none, and «song not found» (404) for a song the user cannot play', async () => {
    vi.mocked(getSongCover).mockResolvedValue(null);
    const none = await ask();
    expect([none.statusCode, none.json()]).toEqual([404, { error: 'no cover' }]);
    vi.mocked(getSongCover).mockResolvedValue(undefined);
    const unknown = await ask('ghost::song');
    expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: 'song not found' }]);
  });

  it('says it failed, not what failed, when something throws', async () => {
    vi.mocked(getSongCover).mockRejectedValue(new Error('disk full: password=hunter2'));
    const res = await ask();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'cover failed' });
    expect(logError).toHaveBeenCalled();
  });
});
