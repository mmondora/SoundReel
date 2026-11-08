import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn(), addSongToPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/mondropHome', () => ({ buildHome: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), buildTracks: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), getSongCover: vi.fn(),
  requestSongDownload: vi.fn(), setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(),
  ORDER_MONDROP: ['local', 'media'], resolveEntryMediaAbs: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));

import { registerMondropRoutes } from './mondrop';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { buildHome } from '../services/mondropHome';
import { logError } from '../utils/logger';

const HOME = {
  user: 'mike',
  displayName: 'Michele',
  sections: [{ id: 'playlists', title: 'Le tue playlist', kind: 'playlists', playlists: [] }],
};

function app() {
  const server = Fastify();
  registerMondropRoutes(server);
  return server;
}

describe('GET /api/mondrop/home (ADR-0020)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    vi.mocked(buildHome).mockResolvedValue(HOME as never);
  });

  it('answers the sections of the user the key belongs to', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/mondrop/home', headers: { 'x-soundreel-key': 'sr_test' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(HOME);
    expect(buildHome).toHaveBeenCalledWith('mike');
  });

  it('ignores a user named in the query: the key decides (a key issued for Michele never reads Sara\'s Home)', async () => {
    await app().inject({ method: 'GET', url: '/api/mondrop/home?user=sara', headers: { 'x-soundreel-key': 'sr_test', 'x-soundreel-user': 'sara' } });
    expect(buildHome).toHaveBeenCalledWith('mike');
  });

  it('needs a valid key', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null as never);
    const res = await app().inject({ method: 'GET', url: '/api/mondrop/home' });
    expect(res.statusCode).toBe(401);
    expect(buildHome).not.toHaveBeenCalled();
  });

  it('is a read: it does not accept a write', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/mondrop/home', headers: { 'x-soundreel-key': 'sr_test' } });
    expect(res.statusCode).toBe(404);
  });

  it('says «home failed» (and logs it) when the whole Home cannot be built', async () => {
    vi.mocked(buildHome).mockRejectedValue(new Error('boom'));
    const res = await app().inject({ method: 'GET', url: '/api/mondrop/home', headers: { 'x-soundreel-key': 'sr_test' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'home failed' });
    expect(logError).toHaveBeenCalledWith('GET /api/mondrop/home failed', expect.anything());
  });
});
