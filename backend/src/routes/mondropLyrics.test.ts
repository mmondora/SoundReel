import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn(), addSongToPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/mondropHome', () => ({ buildHome: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), buildTracks: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), getSongCover: vi.fn(), getSongLyrics: vi.fn(),
  requestSongDownload: vi.fn(), setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(),
  ORDER_MONDROP: ['local', 'media'], resolveEntryMediaAbs: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));

import { registerMondropRoutes } from './mondrop';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { getSongLyrics } from '../services/offlineManifest';
import { logError } from '../utils/logger';

const KEY = 'artist::song (feat. x)';
const url = `/api/mondrop/songs/${encodeURIComponent(KEY)}/lyrics`;
const HEADERS = { 'x-soundreel-key': 'sr_test' };

function get(path = url, headers: Record<string, string> = HEADERS) {
  const app = Fastify();
  registerMondropRoutes(app);
  return app.inject({ method: 'GET', url: path, headers });
}

describe('GET /api/mondrop/songs/:key/lyrics (ADR-0021)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
  });

  it('answers the words the server has, with where they come from, for the user the key belongs to', async () => {
    vi.mocked(getSongLyrics).mockResolvedValue({ text: 'the words', source: 'internet', instrumental: false });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ songKey: KEY, lyrics: 'the words', source: 'internet', instrumental: false });
    expect(getSongLyrics).toHaveBeenCalledWith(KEY, 'mike', false);          // the key is decoded; another user's key is never used
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
  });

  it('says «transcript» when it is the transcript of the post', async () => {
    vi.mocked(getSongLyrics).mockResolvedValue({ text: 'what the video says', source: 'transcript', instrumental: false });
    expect((await get()).json()).toMatchObject({ lyrics: 'what the video says', source: 'transcript' });
  });

  it('an instrumental is a 200 with no text, so the app can say so', async () => {
    vi.mocked(getSongLyrics).mockResolvedValue({ text: '', source: 'internet', instrumental: true });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lyrics: '', instrumental: true });
  });

  it('is 404 for a song nobody knows and 404 for a song with no lyrics, and the two say different things', async () => {
    vi.mocked(getSongLyrics).mockResolvedValueOnce(undefined);
    const unknown = await get();
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'song not found' });
    vi.mocked(getSongLyrics).mockResolvedValueOnce(null);
    const nothing = await get();
    expect(nothing.statusCode).toBe(404);
    expect(nothing.json()).toEqual({ error: 'no lyrics' });
  });

  it('needs a valid key', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null as never);
    const res = await get(url, {});
    expect(res.statusCode).toBe(401);
    expect(getSongLyrics).not.toHaveBeenCalled();
  });

  it('is a read: a write is not found', async () => {
    const app = Fastify();
    registerMondropRoutes(app);
    expect((await app.inject({ method: 'POST', url, headers: HEADERS })).statusCode).toBe(404);
  });

  it('says «lyrics failed» and logs it when it breaks', async () => {
    vi.mocked(getSongLyrics).mockRejectedValue(new Error('boom'));
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'lyrics failed' });
    expect(logError).toHaveBeenCalledWith('GET /api/mondrop/songs/:songKey/lyrics failed', expect.anything());
  });

  it('names no store and no address', async () => {
    vi.mocked(getSongLyrics).mockResolvedValue({ text: 'the words', source: 'internet', instrumental: false });
    expect(JSON.stringify((await get()).json())).not.toMatch(/fritz|192\.168|dlna|lrclib|http/i);
  });
});
