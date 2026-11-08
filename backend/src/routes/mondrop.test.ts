import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({
  authenticateApiKey: vi.fn(),
}));
vi.mock('../services/playlists', () => ({
  listPlaylists: vi.fn(),
  getPlaylist: vi.fn(),
}));
vi.mock('../services/playlistResolver', () => ({
  resolveSummaries: vi.fn(async (list: unknown) => list),
  resolveDetail: vi.fn(async (playlist: unknown) => playlist),
}));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(),
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
import { getPlaylist, listPlaylists } from '../services/playlists';
import { resolveDetail, resolveSummaries } from '../services/playlistResolver';
import { logActivity, _resetActivityThrottleForTest } from '../services/activityLog';
import { recordPlayEvents } from '../services/playEvents';
import { recordDeviceEvents } from '../services/deviceEvents';
import {
  buildPlaylistOfflineManifest,
  getTrack,
  preparePlaylist,
  requestSongDownload,
  resolveSongServing,
  setSongSource,
} from '../services/offlineManifest';

function buildApp() {
  const app = Fastify();
  registerMondropRoutes(app);
  return app;
}

describe('mondrop routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects without API key', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/mondrop/playlists' });
    expect(res.statusCode).toBe(401);
  });

  it('lists playlists for keyed user', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: null });
    vi.mocked(listPlaylists).mockResolvedValue([
      { id: 'p1', name: 'Auto', songCount: 2, createdAt: '', updatedAt: '' },
    ]);
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/mondrop/playlists?user=mike',
      headers: { 'x-soundreel-key': 'sr_test', 'x-soundreel-user': 'mike' },
    });
    expect(res.statusCode).toBe(200);
    expect(listPlaylists).toHaveBeenCalledWith({ userId: 'mike', isAdmin: false });
    expect(res.json().playlists[0].name).toBe('Auto');
  });

  it('dynamic playlists come with kind, rule summary and the count of what the rule selects now (docs/mondrop-stats.md §4)', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    const stored = [
      { id: 'p1', name: 'Auto', kind: 'static', songCount: 2, createdAt: '', updatedAt: '' },
      { id: 'd1', name: 'Notte', kind: 'dynamic', songCount: 0, ruleSummary: 'Più ascoltate · 22:00–06:00 · ultimi 90 giorni · max 50', createdAt: '', updatedAt: '' },
    ] as never;
    vi.mocked(listPlaylists).mockResolvedValue(stored);
    vi.mocked(resolveSummaries).mockResolvedValue([
      { id: 'p1', name: 'Auto', kind: 'static', songCount: 2 },
      { id: 'd1', name: 'Notte', kind: 'dynamic', songCount: 37, generatedAt: '2026-11-08T22:00:00.000Z', ruleSummary: 'Più ascoltate · 22:00–06:00 · ultimi 90 giorni · max 50' },
    ] as never);
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/playlists', headers: { 'x-soundreel-key': 'sr_test' } });
    expect(resolveSummaries).toHaveBeenCalledWith(stored, { userId: 'mike', isAdmin: false });
    expect(res.json().playlists[1]).toMatchObject({ kind: 'dynamic', songCount: 37, ruleSummary: expect.stringContaining('22:00–06:00') });
    expect(res.json().playlists[0]).toMatchObject({ kind: 'static', songCount: 2 });
  });

  it('a playlist\'s detail is the live one: a dynamic playlist lists its songs now, not the stored ones', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    vi.mocked(getPlaylist).mockResolvedValue({ id: 'd1', name: 'Notte', kind: 'dynamic', songKeys: [] } as never);
    vi.mocked(resolveDetail).mockResolvedValue({ id: 'd1', name: 'Notte', kind: 'dynamic', songKeys: ['a::b', 'c::d'], songCount: 2, generatedAt: '2026-11-08T22:00:00.000Z' } as never);
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/playlists/d1', headers: { 'x-soundreel-key': 'sr_test' } });
    expect(res.json().playlist).toMatchObject({ songKeys: ['a::b', 'c::d'], generatedAt: '2026-11-08T22:00:00.000Z' });
    expect(resolveDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), { userId: 'mike', isAdmin: false });
  });

  it('key bound to a user overrides client-supplied user hints', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'sara', device: 'iPhone di Sara' } });
    vi.mocked(listPlaylists).mockResolvedValue([]);
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/mondrop/playlists?user=mike',
      headers: { 'x-soundreel-key': 'sr_test', 'x-soundreel-user': 'mike' },
    });
    expect(res.statusCode).toBe(200);
    expect(listPlaylists).toHaveBeenCalledWith({ userId: 'sara', isAdmin: false });
  });

  it('returns offline manifesto', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: null });
    vi.mocked(buildPlaylistOfflineManifest).mockResolvedValue({
      playlistId: 'p1',
      name: 'Auto',
      tracks: [
        {
          songKey: 'a::b',
          title: 'b',
          artist: 'a',
          status: 'ready',
          state: 'ready',
          source: 'library',
          downloadPath: '/api/mondrop/songs/a%3A%3Ab/file',
          mediaUrl: null,
          version: '12-1',
          durationS: null,
          error: null,
          bytes: 12,
          spotifyUrl: null,
          entryId: null,
          canEnqueueSpooty: false,
          coverUrl: null,
          lyrics: null,
        },
      ],
      readyCount: 1,
      missingCount: 0,
      preparingCount: 0,
      failedCount: 0,
    });
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/mondrop/playlists/p1/offline',
      headers: { 'x-soundreel-key': 'sr_test', 'x-soundreel-user': 'mike' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().readyCount).toBe(1);
    expect(res.json().tracks[0].source).toBe('library');
  });
});


describe('mondrop sync endpoints (contract: docs/mondrop-sync.md)', () => {
  const H = { 'x-soundreel-key': 'sr_test', 'x-soundreel-user': 'mike' };
  const track = { songKey: 'bishop briggs::white flag', title: 'White Flag', artist: 'Bishop Briggs', state: 'preparing' } as never;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: null });
  });

  it('every new endpoint wants the API key', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const app = buildApp();
    for (const [method, url] of [
      ['POST', '/api/mondrop/playlists/p1/prepare'], ['GET', '/api/mondrop/songs/a'], ['POST', '/api/mondrop/songs/a/download'],
      ['PUT', '/api/mondrop/songs/a/source'], ['GET', '/api/mondrop/net'], ['GET', '/api/mondrop/songs/a/file'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('manifest: ?lyrics=0 skips the transcripts (a client that only polls progress)', async () => {
    vi.mocked(buildPlaylistOfflineManifest).mockResolvedValue({ playlistId: 'p1', name: 'Auto', tracks: [], readyCount: 0, missingCount: 0, preparingCount: 0, failedCount: 0 });
    const app = buildApp();
    await app.inject({ method: 'GET', url: '/api/mondrop/playlists/p1/offline?lyrics=0', headers: H });
    expect(vi.mocked(buildPlaylistOfflineManifest).mock.calls[0][3]).toEqual({ lyrics: false });
    await app.inject({ method: 'GET', url: '/api/mondrop/playlists/p1/offline', headers: H });
    expect(vi.mocked(buildPlaylistOfflineManifest).mock.calls[1][3]).toEqual({ lyrics: true });
  });

  it('prepare: queues the playlist for the keyed user and returns the manifest (retryFailed is opt-in)', async () => {
    vi.mocked(preparePlaylist).mockResolvedValue({ playlistId: 'p1', name: 'Auto', tracks: [], readyCount: 0, missingCount: 2, preparingCount: 2, failedCount: 0 });
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/mondrop/playlists/p1/prepare', headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ playlistId: 'p1', preparingCount: 2, user: 'mike' });
    expect(preparePlaylist).toHaveBeenCalledWith('p1', 'mike', false, { retryFailed: false, lyrics: false });
    await app.inject({ method: 'POST', url: '/api/mondrop/playlists/p1/prepare', headers: H, payload: { retryFailed: true } });
    expect(vi.mocked(preparePlaylist).mock.calls[1][3]).toMatchObject({ retryFailed: true });
  });

  it('prepare: 404 for a playlist the user cannot see', async () => {
    vi.mocked(preparePlaylist).mockResolvedValue(null);
    expect((await buildApp().inject({ method: 'POST', url: '/api/mondrop/playlists/nope/prepare', headers: H })).statusCode).toBe(404);
  });

  it('one song: same object as the manifest; the key arrives decoded exactly once', async () => {
    vi.mocked(getTrack).mockResolvedValue(track);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag', headers: H });
    expect(res.json()).toMatchObject({ songKey: 'bishop briggs::white flag', state: 'preparing', user: 'mike' });
    expect(vi.mocked(getTrack).mock.calls[0][0]).toBe('bishop briggs::white flag');
    // a slash in a song name ("AC/DC") travels as %2F and must reach the handler as one path parameter
    await app.inject({ method: 'GET', url: '/api/mondrop/songs/ac%2Fdc%3A%3Aback%20in%20black', headers: H });
    expect(vi.mocked(getTrack).mock.calls[1][0]).toBe('ac/dc::back in black');
    // a literal % in a song name must survive (it used to be decoded twice)
    await app.inject({ method: 'GET', url: '/api/mondrop/songs/50%25%20off%3A%3Asong', headers: H });
    expect(vi.mocked(getTrack).mock.calls[2][0]).toBe('50% off::song');
    vi.mocked(getTrack).mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: '/api/mondrop/songs/x', headers: H })).statusCode).toBe(404);
  });

  it('download: "play" jumps the queue without forcing a retry; the default retries', async () => {
    vi.mocked(requestSongDownload).mockResolvedValue(track);
    const app = buildApp();
    const play = await app.inject({ method: 'POST', url: '/api/mondrop/songs/a/download', headers: H, payload: { priority: 'play' } });
    expect(play.json()).toMatchObject({ ok: true, state: 'preparing' });
    expect(vi.mocked(requestSongDownload).mock.calls[0]).toEqual(['a', 'mike', { priority: 'play', retry: false }]);
    await app.inject({ method: 'POST', url: '/api/mondrop/songs/a/download', headers: H });
    expect(vi.mocked(requestSongDownload).mock.calls[1]).toEqual(['a', 'mike', { priority: 'sync', retry: true }]);
    vi.mocked(requestSongDownload).mockResolvedValue(null);
    expect((await app.inject({ method: 'POST', url: '/api/mondrop/songs/a/download', headers: H })).statusCode).toBe(404);
  });

  it('source: accepts a YouTube link, rejects others (400) and unknown songs (404)', async () => {
    const app = buildApp();
    vi.mocked(setSongSource).mockResolvedValue({ ok: true });
    const ok = await app.inject({ method: 'PUT', url: '/api/mondrop/songs/a/source', headers: H, payload: { youtubeUrl: 'https://youtu.be/syhBqULC99I' } });
    expect(ok.json()).toEqual({ ok: true });
    expect(setSongSource).toHaveBeenCalledWith('a', 'mike', 'https://youtu.be/syhBqULC99I');
    vi.mocked(setSongSource).mockResolvedValue({ ok: false, reason: 'bad_url' });
    expect((await app.inject({ method: 'PUT', url: '/api/mondrop/songs/a/source', headers: H, payload: { youtubeUrl: 'https://evil.example/x' } })).statusCode).toBe(400);
    vi.mocked(setSongSource).mockResolvedValue({ ok: false, reason: 'song_not_found' });
    expect((await app.inject({ method: 'PUT', url: '/api/mondrop/songs/a/source', headers: H, payload: {} })).statusCode).toBe(404);
  });

  it('net: at home unless the request came through the Cloudflare tunnel', async () => {
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/mondrop/net', headers: H })).json()).toEqual({ viaCloudflare: false, home: true });
    expect((await app.inject({ method: 'GET', url: '/api/mondrop/net', headers: { ...H, 'cf-ray': '8a1b2c3d4e5f-MXP' } })).json())
      .toEqual({ viaCloudflare: true, home: false });
    expect((await app.inject({ method: 'GET', url: '/api/mondrop/net', headers: { ...H, 'cf-connecting-ip': '1.2.3.4' } })).json().home).toBe(false);
  });

  describe('file', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'mondrop-file-'));
      await writeFile(path.join(dir, 'a.mp3'), Buffer.from('0123456789'));
      vi.mocked(resolveSongServing).mockResolvedValue({
        ok: true,
        served: { filename: 'a.mp3', version: '10-1', title: 'White Flag', artist: 'Bishop Briggs', origins: [{ kind: 'local', absPath: path.join(dir, 'a.mp3') }] },
      });
    });
    afterEach(async () => {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    });

    it('asks for the disk first and the media server second (Mondrop downloads to the phone)', async () => {
      await buildApp().inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: H });
      expect(vi.mocked(resolveSongServing).mock.calls[0][3]).toEqual(['local', 'media']);
    });

    it('a song that is only on the media server is relayed from there, with Range (no copy on the disk)', async () => {
      vi.mocked(resolveSongServing).mockResolvedValue({
        ok: true,
        served: { filename: 'n.mp3', version: '10-0', title: 'Nightcall', artist: 'Kavinsky', origins: [{ kind: 'media', url: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/K/n.mp3' }] },
      });
      const fetchMock = vi.fn(async () => new Response('2345', { status: 206, headers: { 'content-length': '4', 'content-range': 'bytes 2-5/10' } }));
      vi.stubGlobal('fetch', fetchMock);
      const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: { ...H, range: 'bytes=2-5' } });
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 2-5/10');
      expect(res.headers.etag).toBe('"10-0"');
      expect(res.body).toBe('2345');
    });

    it('streams the MP3 with its version as ETag and honours Range', async () => {
      const app = buildApp();
      const full = await app.inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: H });
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toBe('audio/mpeg');
      expect(full.headers.etag).toBe('"10-1"');
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.body).toBe('0123456789');
      const part = await app.inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: { ...H, range: 'bytes=2-5' } });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 2-5/10');
      expect(part.body).toBe('2345');
    });

    it('answers 304 to a client that already has this version, but never to a Range request', async () => {
      const app = buildApp();
      const same = await app.inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: { ...H, 'if-none-match': '"10-1"' } });
      expect(same.statusCode).toBe(304);
      const ranged = await app.inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: { ...H, 'if-none-match': '"10-1"', range: 'bytes=0-1' } });
      expect(ranged.statusCode).toBe(206);
      const stale = await app.inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: { ...H, 'if-none-match': '"9-1"' } });
      expect(stale.statusCode).toBe(200);
    });

    it('404 JSON (never a redirect) while the file is not ready', async () => {
      vi.mocked(resolveSongServing).mockResolvedValue({ ok: false, reason: 'file_not_ready' });
      const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: H });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'file not ready' });
    });
  });
});


describe('activity trail and listening/device events (docs/mondrop-stats.md)', () => {
  const DEVICE_KEY = { owner: { user: 'mike', device: 'iPhone di Michele' } } as never;
  const H = { 'x-soundreel-key': 'sr_test' };
  const manifest = { playlistId: 'p1', name: 'Road trip', tracks: [{}, {}, {}], readyCount: 1, missingCount: 2, preparingCount: 1, failedCount: 1 } as never;
  const lines = () => vi.mocked(logActivity).mock.calls.map((c) => ({ category: c[0], action: c[1], message: c[2], actor: c[3], data: c[4] }));

  beforeEach(() => {
    vi.clearAllMocks();
    _resetActivityThrottleForTest();
    vi.mocked(authenticateApiKey).mockResolvedValue(DEVICE_KEY);
  });

  it('prepare = the sync request of a device: who, which device, which playlist, what state', async () => {
    vi.mocked(preparePlaylist).mockResolvedValue(manifest);
    await buildApp().inject({ method: 'POST', url: '/api/mondrop/playlists/p1/prepare', headers: H, payload: { retryFailed: true } });
    expect(lines()).toEqual([{
      category: 'sync', action: 'prepare',
      message: 'mike (iPhone di Michele) ha avviato il sync di «Road trip» (riprova anche i falliti): 1 pronti, 1 in preparazione, 1 da cercare o in errore, 3 brani',
      actor: { user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' },
      data: expect.objectContaining({ playlistId: 'p1', name: 'Road trip', total: 3, ready: 1, preparing: 1, failed: 1, retryFailed: true }),
    }]);
  });

  it('manifest reads leave one line per device and playlist every 10 minutes, not one per poll', async () => {
    vi.mocked(buildPlaylistOfflineManifest).mockResolvedValue(manifest);
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) await app.inject({ method: 'GET', url: '/api/mondrop/playlists/p1/offline?lyrics=0', headers: H });
    expect(lines().filter((l) => l.action === 'manifest')).toHaveLength(1);
    expect(lines()[0].message).toBe('mike (iPhone di Michele) ha letto «Road trip»: 1 pronti su 3');
    await app.inject({ method: 'GET', url: '/api/mondrop/playlists/OTHER/offline', headers: H }); // another playlist: its own line
    expect(lines().filter((l) => l.action === 'manifest')).toHaveLength(2);
  });

  it('a download request says who wants which song, how urgently, and what state it is in', async () => {
    vi.mocked(requestSongDownload).mockResolvedValue({ title: 'White Flag', artist: 'Bishop Briggs', state: 'preparing', source: 'none' } as never);
    await buildApp().inject({ method: 'POST', url: '/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/download', headers: H, payload: { priority: 'play' } });
    expect(lines()).toEqual([expect.objectContaining({
      category: 'download', action: 'request',
      message: 'mike (iPhone di Michele) chiede «White Flag – Bishop Briggs» (priorità play) → preparing',
      data: expect.objectContaining({ songKey: 'bishop briggs::white flag', priority: 'play', state: 'preparing' }),
    })]);
  });

  it('a chosen YouTube video is logged with its link', async () => {
    vi.mocked(setSongSource).mockResolvedValue({ ok: true });
    await buildApp().inject({ method: 'PUT', url: '/api/mondrop/songs/a%3A%3Ab/source', headers: H, payload: { youtubeUrl: 'https://youtu.be/syhBqULC99I' } });
    expect(lines()[0]).toMatchObject({ category: 'download', action: 'override', data: { songKey: 'a::b', youtubeUrl: 'https://youtu.be/syhBqULC99I' } });
  });

  it('a failed request leaves no activity line', async () => {
    vi.mocked(requestSongDownload).mockResolvedValue(null);
    vi.mocked(preparePlaylist).mockResolvedValue(null);
    const app = buildApp();
    await app.inject({ method: 'POST', url: '/api/mondrop/songs/ghost/download', headers: H });
    await app.inject({ method: 'POST', url: '/api/mondrop/playlists/nope/prepare', headers: H });
    expect(lines()).toEqual([]);
  });

  describe('file pulls', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'mondrop-act-'));
      await writeFile(path.join(dir, 'a.mp3'), Buffer.alloc(5_720_510));
      vi.mocked(resolveSongServing).mockResolvedValue({
        ok: true,
        served: { filename: 'a.mp3', version: '5720510-1', title: 'White Flag', artist: 'Bishop Briggs', origins: [{ kind: 'local', absPath: path.join(dir, 'a.mp3') }] },
      });
    });
    afterEach(async () => rm(dir, { recursive: true, force: true }));

    it('logs the start of a transfer once (retries and Range chunks of the same song do not repeat it)', async () => {
      const app = buildApp();
      await app.inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: H });
      await app.inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: { ...H, range: 'bytes=0-' } }); // a retry within 30 s
      await app.inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: { ...H, range: 'bytes=100-199' } }); // a later chunk
      expect(lines()).toEqual([expect.objectContaining({
        category: 'download', action: 'file', message: 'mike (iPhone di Michele) scarica «White Flag – Bishop Briggs» (5,5 MB, dal disco)',
        data: expect.objectContaining({ songKey: 'a', bytes: 5_720_510, version: '5720510-1', origin: 'local' }),
      })]);
    });

    it('a chunk from the middle never logs by itself', async () => {
      await buildApp().inject({ method: 'GET', url: '/api/mondrop/songs/a/file', headers: { ...H, range: 'bytes=100-199' } });
      expect(lines()).toEqual([]);
    });
  });

  it('plays: stored for the keyed user and device, one summary line when something new arrived', async () => {
    vi.mocked(recordPlayEvents).mockResolvedValue({ ok: true, counted: 2, result: { accepted: 3, duplicates: 1, rejected: [] } });
    const res = await buildApp().inject({ method: 'POST', url: '/api/mondrop/plays', headers: H, payload: { events: [{}] } });
    expect(res.json()).toEqual({ accepted: 3, duplicates: 1, rejected: [] });
    expect(vi.mocked(recordPlayEvents).mock.calls[0].slice(0, 2)).toEqual(['mike', 'iPhone di Michele']);
    expect(lines()).toEqual([expect.objectContaining({ category: 'device', action: 'plays', message: 'mike (iPhone di Michele) ha inviato 3 ascolti (2 contati)' })]);
  });

  it('plays: a batch with nothing new is silent; bad bodies keep their status', async () => {
    vi.mocked(recordPlayEvents).mockResolvedValueOnce({ ok: true, counted: 0, result: { accepted: 0, duplicates: 4, rejected: [] } });
    const app = buildApp();
    await app.inject({ method: 'POST', url: '/api/mondrop/plays', headers: H, payload: { events: [{}] } });
    expect(lines()).toEqual([]);
    vi.mocked(recordPlayEvents).mockResolvedValueOnce({ ok: false, status: 413, error: 'too_many_events' });
    const big = await app.inject({ method: 'POST', url: '/api/mondrop/plays', headers: H, payload: { events: [] } });
    expect([big.statusCode, big.json()]).toEqual([413, { error: 'too_many_events' }]);
  });

  it('legacy keys have no device: the app can name it in X-SoundReel-Device', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: null });
    vi.mocked(recordPlayEvents).mockResolvedValue({ ok: true, counted: 1, result: { accepted: 1, duplicates: 0, rejected: [] } });
    await buildApp().inject({ method: 'POST', url: '/api/mondrop/plays?user=mike', headers: { ...H, 'x-soundreel-user': 'mike', 'x-soundreel-device': 'iPad' }, payload: { events: [{}] } });
    expect(vi.mocked(recordPlayEvents).mock.calls[0].slice(0, 2)).toEqual(['mike', 'iPad']);
  });

  it('device events: passed through with the key\'s user and device, auth required', async () => {
    vi.mocked(recordDeviceEvents).mockResolvedValue({ ok: true, result: { accepted: 1, duplicates: 0, rejected: [] } });
    const res = await buildApp().inject({ method: 'POST', url: '/api/mondrop/device-events', headers: H, payload: { events: [{}] } });
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    expect(vi.mocked(recordDeviceEvents).mock.calls[0].slice(0, 2)).toEqual(['mike', 'iPhone di Michele']);
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    expect((await buildApp().inject({ method: 'POST', url: '/api/mondrop/device-events', payload: {} })).statusCode).toBe(401);
    expect((await buildApp().inject({ method: 'POST', url: '/api/mondrop/plays', payload: {} })).statusCode).toBe(401);
  });
});
