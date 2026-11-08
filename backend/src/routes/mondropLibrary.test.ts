import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(),
  buildTracks: vi.fn(),
  preparePlaylist: vi.fn(),
  getTrack: vi.fn(),
  requestSongDownload: vi.fn(),
  setSongSource: vi.fn(),
  enqueueSongToSpooty: vi.fn(),
  resolveSongServing: vi.fn(),
  ORDER_MONDROP: ['local', 'media'],
  resolveEntryMediaAbs: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));

import { registerMondropRoutes } from './mondrop';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { getUserSongs } from '../services/userSongs';
import { buildTracks } from '../services/offlineManifest';
import type { AggregatedSong } from '../types';

function song(artist: string, title: string, album: string | null, genres: string[], year: number | null): AggregatedSong {
  const key = `${artist.toLowerCase()}::${title.toLowerCase()}`;
  return {
    songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null, mentions: [{ entryId: 'e', createdAt: '2026-01-01' }], inLibrary: false,
    meta: { songKey: key, deezerId: null, itunesId: null, genres, album, releaseYear: year, coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null,
      enrichedAt: null, listened: false, favorite: false, downloaded: false, rating: null, score: null },
  };
}

const LIBRARY = [
  song('Michael Jackson', 'Billie Jean', 'Thriller', ['Pop'], 1982),
  song('Michael Jackson', 'Beat It', 'Thriller', ['Pop', 'Rock'], 1982),
  song('Madonna', 'Like a Prayer', 'Like a Prayer', ['Pop'], 1989),
  song('Daft Punk', 'One More Time', 'Discovery', ['Electronic'], 2001),
  song('Unknown', 'Mystery', null, [], null),
];

const HEADERS = { 'x-soundreel-key': 'sr_test' };
const get = (url: string) => {
  const app = Fastify();
  registerMondropRoutes(app);
  return app.inject({ method: 'GET', url, headers: HEADERS });
};

describe('GET /api/mondrop/library (ADR-0013)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    vi.mocked(getUserSongs).mockResolvedValue(new Map(LIBRARY.map((s) => [s.songKey, s])));
    vi.mocked(buildTracks).mockImplementation(async (songs) => songs.map((s) => ({ songKey: s.songKey, title: s.title })) as never);
  });

  it('needs the API key', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const res = await get('/api/mondrop/library');
    expect(res.statusCode).toBe(401);
    expect(getUserSongs).not.toHaveBeenCalled();
  });

  it('lists the songs of THIS user (never admin scope), sorted by artist then title, with the headings', async () => {
    const res = await get('/api/mondrop/library');
    expect(res.statusCode).toBe(200);
    expect(getUserSongs).toHaveBeenCalledWith('mike', false);
    const body = res.json();
    expect(body.user).toBe('mike');
    expect(body.total).toBe(5);
    expect(body.songs.map((s: { title: string }) => s.title)).toEqual(['One More Time', 'Like a Prayer', 'Beat It', 'Billie Jean', 'Mystery']);
    expect(body.facets.decades).toEqual([
      { value: 1980, label: 'Anni 80', count: 3 },
      { value: 2000, label: 'Anni 2000', count: 1 },
      { value: 'none', label: 'Senza anno', count: 1 },
    ]);
    expect(body.facets.genres[0]).toEqual({ value: 'Pop', label: 'Pop', count: 3 });
    expect(body.facets.albums[0]).toEqual({ value: 'Thriller', label: 'Thriller', count: 2 });
    expect(body.facets.artists[0]).toEqual({ value: 'Michael Jackson', label: 'Michael Jackson', count: 2 });
  });

  it('builds the tracks (state, version, plays) of the page only, for this user, without lyrics', async () => {
    await get('/api/mondrop/library?limit=2&offset=1');
    const [songs, user, options] = vi.mocked(buildTracks).mock.calls[0];
    expect(songs.map((s) => s.title)).toEqual(['Like a Prayer', 'Beat It']);
    expect(user).toBe('mike');
    expect(options ?? {}).not.toMatchObject({ lyrics: true });
  });

  it('pages: total is the whole result, offset and limit are echoed', async () => {
    const res = await get('/api/mondrop/library?limit=2&offset=4');
    const body = res.json();
    expect(body).toMatchObject({ total: 5, offset: 4, limit: 2 });
    expect(body.songs.map((s: { title: string }) => s.title)).toEqual(['Mystery']);
  });

  it('"anni 80": filters by decade', async () => {
    const res = await get('/api/mondrop/library?decade=1980');
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.songs.map((s: { title: string }) => s.title).sort()).toEqual(['Beat It', 'Billie Jean', 'Like a Prayer']);
    // the decade heading ignores its own filter, so the other decades are still on offer
    expect(body.facets.decades.map((d: { value: unknown }) => d.value)).toEqual([1980, 2000, 'none']);
  });

  it('combines genre, album, artist and text', async () => {
    const res = await get('/api/mondrop/library?genre=Rock&album=thriller&artist=Michael%20Jackson&q=beat');
    expect(res.json().songs.map((s: { title: string }) => s.title)).toEqual(['Beat It']);
    expect((await get('/api/mondrop/library?genre=Rock&decade=2000')).json().total).toBe(0);
  });

  it('"Senza anno": the songs no provider dated', async () => {
    const res = await get('/api/mondrop/library?decade=none');
    expect(res.json().songs.map((s: { title: string }) => s.title)).toEqual(['Mystery']);
  });

  it('leaves the headings out when asked (paging does not need them again)', async () => {
    const res = await get('/api/mondrop/library?facets=0&limit=1');
    expect(res.statusCode).toBe(200);
    expect(res.json().facets).toBeUndefined();
    expect(res.json().total).toBe(5);
  });

  it('refuses a malformed query with 400 naming the field, and does no work', async () => {
    for (const [url, field] of [
      ['/api/mondrop/library?decade=1985', 'decade'],
      ['/api/mondrop/library?limit=0', 'limit'],
      ['/api/mondrop/library?limit=501', 'limit'],
      ['/api/mondrop/library?offset=-3', 'offset'],
      [`/api/mondrop/library?q=${'x'.repeat(201)}`, 'q'],
      ['/api/mondrop/library?genre=Pop&genre=Rock', 'genre'],
    ] as const) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_query', field });
    }
    expect(getUserSongs).not.toHaveBeenCalled();
    expect(buildTracks).not.toHaveBeenCalled();
  });

  it('an empty library answers with an empty page, not an error', async () => {
    vi.mocked(getUserSongs).mockResolvedValue(new Map());
    const res = await get('/api/mondrop/library');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ songs: [], total: 0, facets: { genres: [], albums: [], artists: [], decades: [] } });
  });

  it('a key bound to another user reads that user\'s songs', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'sara', device: 'iPhone di Sara' } });
    await get('/api/mondrop/library?user=mike');
    expect(getUserSongs).toHaveBeenCalledWith('sara', false);
  });

  it('answers 500 with a short message when something breaks', async () => {
    vi.mocked(getUserSongs).mockRejectedValue(new Error('db down'));
    const res = await get('/api/mondrop/library');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'library failed' });
  });
});
