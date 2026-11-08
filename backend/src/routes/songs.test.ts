import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../utils/db', () => ({ listEntries: vi.fn() }));
vi.mock('../services/songMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/songMeta')>();
  return {
    songKey: actual.songKey,
    listSongMeta: vi.fn(),
    patchSongUserMeta: vi.fn(),
    getSongMeta: vi.fn(),
  };
});
vi.mock('../services/songEnrichment', () => ({ resolveDeezerPreviewUrl: vi.fn() }));
vi.mock('../services/musicLibrary', () => ({
  syncDownloadedFlags: vi.fn().mockResolvedValue({ scanned: 0, matched: 0, updated: 0 }),
  scanLibrary: vi.fn().mockResolvedValue([]),
  findLibraryTrack: vi.fn().mockReturnValue(null),
}));
vi.mock('../services/youtubeResolve', () => ({
  resolveYoutubePlaySource: vi.fn(),
}));
vi.mock('../services/songFiles', () => ({ listReadySongKeys: vi.fn().mockResolvedValue(new Set<string>()) }));
vi.mock('../services/songLocation', () => ({ locateSongs: vi.fn().mockResolvedValue(new Map()) }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  resolveSongServing: vi.fn(),
  ORDER_WEB: ['media', 'local'],
  getTrack: vi.fn(),
  requestSongDownload: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerSongsRoutes, _resetSyncThrottleForTest, aggregateSongs } from './songs';
import { listEntries } from '../utils/db';
import { listSongMeta, patchSongUserMeta, getSongMeta } from '../services/songMeta';
import { resolveDeezerPreviewUrl } from '../services/songEnrichment';
import { syncDownloadedFlags, scanLibrary, findLibraryTrack } from '../services/musicLibrary';
import { resolveYoutubePlaySource } from '../services/youtubeResolve';
import { listReadySongKeys } from '../services/songFiles';
import { locateSongs } from '../services/songLocation';
import { logActivity, _resetActivityThrottleForTest } from '../services/activityLog';
import { invalidateUserSongs } from '../services/userSongs';
import { getTrack, requestSongDownload, resolveSongServing } from '../services/offlineManifest';
import { logError } from '../utils/logger';
import type { AggregatedSong, SongMetaRecord } from '../types';

function buildApp() {
  const app = Fastify();
  registerSongsRoutes(app);
  return app;
}

function entry(id: string, createdAt: string, songs: unknown[]) {
  return { id, createdAt, results: { songs } } as never;
}

const BOHEMIAN = {
  title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera',
  youtubeUrl: 'https://youtube.com/results?search_query=x', spotifyUrl: 'https://open.spotify.com/track/1',
};

describe('GET /api/songs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(syncDownloadedFlags).mockResolvedValue({ scanned: 0, matched: 0, updated: 0 });
    _resetSyncThrottleForTest();
  });

  it('dedups mentions of the same song across entries', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-02T00:00:00Z', [BOHEMIAN]),
      entry('e2', '2026-07-01T00:00:00Z', [{ ...BOHEMIAN, title: ' bohemian rhapsody ', artist: ' Queen ' }]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(200);
    const { songs } = res.json();
    expect(songs).toHaveLength(1);
    expect(songs[0].songKey).toBe('queen::bohemian rhapsody');
    expect(songs[0].mentions).toHaveLength(2);
  });

  it('mentions are newest-first', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('newer', '2026-07-02T00:00:00Z', [BOHEMIAN]),
      entry('older', '2026-07-01T00:00:00Z', [BOHEMIAN]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    const { songs } = res.json();
    expect(songs[0].mentions.map((m: { entryId: string }) => m.entryId)).toEqual(['newer', 'older']);
  });

  it('display fields come from the most recent mention and meta is joined', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ ...BOHEMIAN, album: null }]),
      entry('e2', '2026-07-02T00:00:00Z', [BOHEMIAN]),
    ]);
    const meta = {
      songKey: 'queen::bohemian rhapsody', deezerId: 1, itunesId: null, genres: ['Rock'], album: 'A Night at the Opera',
      coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null, enrichedAt: null,
      listened: true, favorite: false, downloaded: false, rating: 'like', score: null,
    };
    vi.mocked(listSongMeta).mockResolvedValue(new Map([['queen::bohemian rhapsody', meta as never]]));
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    const { songs } = res.json();
    expect(songs[0].album).toBe('A Night at the Opera');
    expect(songs[0].meta.rating).toBe('like');
  });

  it('keys a song with a missing artist using an empty-string artist', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ title: 'Untitled', artist: undefined, album: null, youtubeUrl: null, spotifyUrl: null }]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(200);
    const { songs } = res.json();
    expect(songs).toHaveLength(1);
    expect(songs[0].songKey).toBe('::untitled');
    expect(songs[0].artist).toBe('');
  });

  it('skips malformed song objects without failing', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [null, { noTitle: true }, { title: '   ' }, { title: 'X', artist: 5 }, BOHEMIAN]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(200);
    expect(res.json().songs).toHaveLength(1);
  });

  it('tolerates entries with a non-array results.songs', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      { id: 'e1', createdAt: '2026-07-01T00:00:00Z', results: {} } as never,
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(200);
    expect(res.json().songs).toHaveLength(0);
  });

  it('500 and logs when aggregation fails', async () => {
    vi.mocked(listEntries).mockRejectedValue(new Error('db down'));
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(500);
  });

  it('fire-and-forget triggers a background library sync on request', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(syncDownloadedFlags).toHaveBeenCalledTimes(1);
  });

  it('throttles the background sync to once per 10 minutes', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const app = buildApp();

    await app.inject({ method: 'GET', url: '/api/songs' });
    await app.inject({ method: 'GET', url: '/api/songs' });
    await app.inject({ method: 'GET', url: '/api/songs' });

    expect(syncDownloadedFlags).toHaveBeenCalledTimes(1);
  });

  it('triggers again once the throttle window is reset', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const app = buildApp();

    await app.inject({ method: 'GET', url: '/api/songs' });
    _resetSyncThrottleForTest();
    await app.inject({ method: 'GET', url: '/api/songs' });

    expect(syncDownloadedFlags).toHaveBeenCalledTimes(2);
  });

  it('sets inLibrary true when findLibraryTrack matches a scanned file', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [BOHEMIAN]),
      entry('e2', '2026-07-01T00:00:00Z', [{ title: 'Missing', artist: 'Nobody', album: null, youtubeUrl: null, spotifyUrl: null }]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const track = { artist: 'Queen', title: 'Bohemian Rhapsody', album: null, relPath: 'Queen - Bohemian Rhapsody.mp3' };
    vi.mocked(scanLibrary).mockResolvedValue([track]);
    vi.mocked(findLibraryTrack).mockImplementation((_tracks, artist, title) =>
      artist === 'Queen' && title === 'Bohemian Rhapsody' ? track : null,
    );

    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(200);
    const { songs } = res.json() as { songs: AggregatedSong[] };
    const byKey = Object.fromEntries(songs.map((s) => [s.songKey, s]));
    expect(byKey['queen::bohemian rhapsody'].inLibrary).toBe(true);
    expect(byKey['nobody::missing'].inLibrary).toBe(false);
  });

  it('defaults inLibrary to false when the library scan is empty', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [BOHEMIAN]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    vi.mocked(scanLibrary).mockResolvedValue([]);
    vi.mocked(findLibraryTrack).mockReturnValue(null);

    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.json().songs[0].inLibrary).toBe(false);
  });

  it('does not fail the request when the background sync rejects', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    vi.mocked(syncDownloadedFlags).mockRejectedValue(new Error('scan failed'));

    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(200);
    // let the fire-and-forget rejection's .catch handler run before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalledWith('background music library sync failed', expect.objectContaining({ err: expect.any(String) }));
  });
});

describe('GET /api/songs/:songKey/youtube', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateUserSongs(); // the per-user song cache is module state
  });

  it('does not rebuild the whole journal on every play: the second request is served from the per-user cache', async () => {
    // Measured on the real data: re-aggregating ~800 songs cost ~0.45 s per call and made "play" feel slow next to the
    // instant preview. The first request builds the map, the next ones (a skip, a retry, the queue) do not.
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [BOHEMIAN])]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    vi.mocked(resolveYoutubePlaySource).mockResolvedValue({ videoId: 'abc123XYZ_', watchUrl: 'https://www.youtube.com/watch?v=abc123XYZ_', source: 'stored_url' });
    const app = buildApp();
    const url = '/api/songs/queen%3A%3Abohemian%20rhapsody/youtube';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(listEntries).toHaveBeenCalledTimes(1);
  });

  it('a song created seconds ago (not in the cache yet) is still found: one fresh lookup, then served', async () => {
    vi.mocked(listEntries).mockResolvedValueOnce([]).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [BOHEMIAN])]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    vi.mocked(resolveYoutubePlaySource).mockResolvedValue({ videoId: 'abc123XYZ_', watchUrl: 'https://www.youtube.com/watch?v=abc123XYZ_', source: 'stored_url' });
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/youtube' });
    expect(res.statusCode).toBe(200);
    expect(listEntries).toHaveBeenCalledTimes(2);
  });

  it('404s for an unknown song', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/nope%3A%3Anothing/youtube' });
    expect(res.statusCode).toBe(404);
  });

  it('returns videoId from resolveYoutubePlaySource', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [BOHEMIAN]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    vi.mocked(resolveYoutubePlaySource).mockResolvedValue({
      videoId: 'abc123XYZ_',
      watchUrl: 'https://www.youtube.com/watch?v=abc123XYZ_',
      source: 'stored_url',
    });
    const res = await buildApp().inject({
      method: 'GET',
      url: '/api/songs/queen%3A%3Abohemian%20rhapsody/youtube',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      videoId: 'abc123XYZ_',
      watchUrl: 'https://www.youtube.com/watch?v=abc123XYZ_',
      source: 'stored_url',
    });
    expect(resolveYoutubePlaySource).toHaveBeenCalledWith(expect.objectContaining({
      songKey: 'queen::bohemian rhapsody',
      artist: 'Queen',
      title: 'Bohemian Rhapsody',
    }));
  });

  it('404s when resolve returns null', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [BOHEMIAN]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    vi.mocked(resolveYoutubePlaySource).mockResolvedValue(null);
    const res = await buildApp().inject({
      method: 'GET',
      url: '/api/songs/queen%3A%3Abohemian%20rhapsody/youtube',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/songs/:songKey/file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(scanLibrary).mockResolvedValue([]);
    vi.mocked(findLibraryTrack).mockReturnValue(null);
    vi.mocked(resolveSongServing).mockResolvedValue({ ok: false, reason: 'file_not_ready' });
  });

  it('404s for an unknown song', async () => {
    vi.mocked(resolveSongServing).mockResolvedValue({ ok: false, reason: 'song_not_found' });
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/nope%3A%3Anothing/file' });
    expect(res.statusCode).toBe(404);
  });

  it('redirects to the Spooty frontend when the file is not in the library', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ title: 'Runaway', artist: 'Kanye West' }]),
    ]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('spooty');
  });

  describe('from the media server (proxied, nothing copied — ADR-0010)', () => {
    const box = (over: Partial<Record<string, string>> = {}) => ({ 'content-length': '10', ...over });
    const servedFromBox = () =>
      vi.mocked(resolveSongServing).mockResolvedValue({
        ok: true,
        served: {
          filename: '01 - 2-01 Nightcall.mp3', version: '10-0', title: 'Nightcall', artist: 'Kavinsky',
          origins: [{ kind: 'media', url: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Kavinsky/Nightcall/01.mp3' }],
        },
      });
    afterEach(() => vi.unstubAllGlobals());

    it('streams the box\'s bytes through the backend, Range included (seek works from the internet)', async () => {
      servedFromBox();
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const wantsRange = (init?.headers as Record<string, string>).Range === 'bytes=2-5';
        return wantsRange
          ? new Response('2345', { status: 206, headers: box({ 'content-length': '4', 'content-range': 'bytes 2-5/10' }) })
          : new Response('0123456789', { status: 200, headers: box() });
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await buildApp().inject({ method: 'GET', url: '/api/songs/kavinsky%3A%3Anightcall/file', headers: { range: 'bytes=2-5' } });
      expect(String(fetchMock.mock.calls[0][0])).toBe('http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Kavinsky/Nightcall/01.mp3');
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 2-5/10');
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['content-disposition']).toBe('inline; filename="01 - 2-01 Nightcall.mp3"');
      expect(res.body).toBe('2345');
    });

    it('with the box asleep and no other origin it falls back to the Spooty redirect, never a 500', async () => {
      servedFromBox();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
      const res = await buildApp().inject({ method: 'GET', url: '/api/songs/kavinsky%3A%3Anightcall/file' });
      expect(res.statusCode).toBe(302);
    });
  });

  describe('with a real file in the library', () => {
    // 10 known bytes so range assertions are byte-exact.
    const FILE_BYTES = Buffer.from('0123456789');
    let libraryDir: string;

    beforeEach(async () => {
      libraryDir = await fs.mkdtemp(join(tmpdir(), 'soundreel-songs-test-'));
      await fs.writeFile(join(libraryDir, 'Kanye West - Runaway.mp3'), FILE_BYTES);
      process.env.MUSIC_LIBRARY_PATH = libraryDir;
      vi.mocked(listEntries).mockResolvedValue([
        entry('e1', '2026-07-01T00:00:00Z', [{ title: 'Runaway', artist: 'Kanye West' }]),
      ]);
      vi.mocked(listSongMeta).mockResolvedValue(new Map());
      vi.mocked(findLibraryTrack).mockReturnValue({
        artist: 'Kanye West', title: 'Runaway', album: null, relPath: 'Kanye West - Runaway.mp3',
      });
      // The recorded / library file the service resolves for the song.
      vi.mocked(resolveSongServing).mockResolvedValue({
        ok: true,
        served: {
          filename: 'Kanye West - Runaway.mp3', version: '10-1', title: 'Runaway', artist: 'Kanye West',
          origins: [{ kind: 'local', absPath: join(libraryDir, 'Kanye West - Runaway.mp3') }],
        },
      });
    });

    afterEach(async () => {
      delete process.env.MUSIC_LIBRARY_PATH;
      await fs.rm(libraryDir, { recursive: true, force: true });
    });

    it('serves the full file inline (playable in-browser, not a forced download)', async () => {
      const res = await buildApp().inject({ method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.headers['content-disposition']).toBe('inline; filename="Kanye West - Runaway.mp3"');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe('10');
      expect(res.body).toBe('0123456789');
    });

    it('honors a bounded Range request with 206 + Content-Range (audio seeking)', async () => {
      const res = await buildApp().inject({
        method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file', headers: { range: 'bytes=2-5' },
      });
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 2-5/10');
      expect(res.headers['content-length']).toBe('4');
      expect(res.body).toBe('2345');
    });

    it('honors an open-ended Range request (bytes=N-)', async () => {
      const res = await buildApp().inject({
        method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file', headers: { range: 'bytes=7-' },
      });
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 7-9/10');
      expect(res.body).toBe('789');
    });

    it('honors a suffix Range request (bytes=-N)', async () => {
      const res = await buildApp().inject({
        method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file', headers: { range: 'bytes=-3' },
      });
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 7-9/10');
      expect(res.body).toBe('789');
    });

    it('rejects an out-of-bounds Range with 416', async () => {
      const res = await buildApp().inject({
        method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file', headers: { range: 'bytes=10-' },
      });
      expect(res.statusCode).toBe(416);
      expect(res.headers['content-range']).toBe('bytes */10');
    });

    it('serves the full file when the Range header is unparsable', async () => {
      const res = await buildApp().inject({
        method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file', headers: { range: 'bytes=zz-5' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('0123456789');
    });

    it('?download=1 switches to attachment disposition (explicit download button)', async () => {
      const res = await buildApp().inject({ method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file?download=1' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="Kanye West - Runaway.mp3"');
    });

    it('?from=fs asks for the disk only, ?from=media for the media server only, nothing for both (media first)', async () => {
      const app = buildApp();
      await app.inject({ method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file?from=fs' });
      await app.inject({ method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file?from=media' });
      await app.inject({ method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file' });
      const orders = vi.mocked(resolveSongServing).mock.calls.map((c) => c[3]);
      expect(orders).toEqual([['local'], ['media'], ['media', 'local']]);
    });

    it('file-info reports the library location and Spooty URL', async () => {
      const res = await buildApp().inject({ method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file-info' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        inLibrary: true,
        relPath: 'Kanye West - Runaway.mp3',
        absPath: join(libraryDir, 'Kanye West - Runaway.mp3'),
        spootyUrl: 'https://spooty.casamon.dev',
      });
    });
  });

  describe('GET /api/songs/:songKey/file-info without a library match', () => {
    beforeEach(() => {
      vi.mocked(listEntries).mockResolvedValue([
        entry('e1', '2026-07-01T00:00:00Z', [{ title: 'Runaway', artist: 'Kanye West' }]),
      ]);
      vi.mocked(listSongMeta).mockResolvedValue(new Map());
      vi.mocked(scanLibrary).mockResolvedValue([]);
      vi.mocked(findLibraryTrack).mockReturnValue(null);
    });

    it('404s for an unknown song', async () => {
      const res = await buildApp().inject({ method: 'GET', url: '/api/songs/nope%3A%3Anothing/file-info' });
      expect(res.statusCode).toBe(404);
    });

    it('reports inLibrary=false with null paths but still hands out the Spooty URL', async () => {
      process.env.MUSIC_LIBRARY_PATH = '/music';
      try {
        const res = await buildApp().inject({ method: 'GET', url: '/api/songs/kanye%20west%3A%3Arunaway/file-info' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          inLibrary: false,
          relPath: null,
          absPath: null,
          spootyUrl: 'https://spooty.casamon.dev',
        });
      } finally {
        delete process.env.MUSIC_LIBRARY_PATH;
      }
    });
  });
});

describe('POST /api/songs/sync-library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(syncDownloadedFlags).mockResolvedValue({ scanned: 0, matched: 0, updated: 0 });
    _resetSyncThrottleForTest();
  });

  it('awaits the sync and returns its counts', async () => {
    vi.mocked(syncDownloadedFlags).mockResolvedValue({ scanned: 12, matched: 5, updated: 3 });
    const res = await buildApp().inject({ method: 'POST', url: '/api/songs/sync-library' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scanned: 12, matched: 5, updated: 3 });
  });

  it('500 and logs when the sync fails', async () => {
    vi.mocked(syncDownloadedFlags).mockRejectedValue(new Error('scan failed'));
    const res = await buildApp().inject({ method: 'POST', url: '/api/songs/sync-library' });
    expect(res.statusCode).toBe(500);
    expect(logError).toHaveBeenCalled();
  });
});

function songMeta(partial: Partial<SongMetaRecord> = {}): SongMetaRecord {
  return {
    songKey: 'queen::bohemian rhapsody',
    deezerId: null,
    itunesId: null,
    genres: [],
    album: null,
    coverUrl: null,
    previewUrl: null,
    deezerUrl: null,
    itunesUrl: null,
    enrichedAt: null,
    listened: false,
    favorite: false,
    downloaded: false,
    rating: null,
    score: null,
    ...partial,
  };
}

describe('GET /api/songs/:songKey/preview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404s when there is no song_meta row', async () => {
    vi.mocked(getSongMeta).mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/preview' });
    expect(res.statusCode).toBe(404);
    expect(resolveDeezerPreviewUrl).not.toHaveBeenCalled();
  });

  it('returns the stored (durable, iTunes-backed) preview URL directly without hitting Deezer', async () => {
    vi.mocked(getSongMeta).mockResolvedValue(
      songMeta({ previewUrl: 'https://audio-ssl.itunes.apple.com/preview333.m4a', deezerId: 111 })
    );
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/preview' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://audio-ssl.itunes.apple.com/preview333.m4a' });
    expect(resolveDeezerPreviewUrl).not.toHaveBeenCalled();
  });

  it('live-resolves a fresh Deezer preview URL when only deezerId is known', async () => {
    vi.mocked(getSongMeta).mockResolvedValue(songMeta({ deezerId: 111, previewUrl: null }));
    vi.mocked(resolveDeezerPreviewUrl).mockResolvedValue('https://cdns-preview.deezer.com/fresh.mp3');
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/preview' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://cdns-preview.deezer.com/fresh.mp3' });
    expect(resolveDeezerPreviewUrl).toHaveBeenCalledWith(111);
  });

  it('404s when neither a stored preview nor a deezerId is available', async () => {
    vi.mocked(getSongMeta).mockResolvedValue(songMeta({ deezerId: null, previewUrl: null }));
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/preview' });
    expect(res.statusCode).toBe(404);
    expect(resolveDeezerPreviewUrl).not.toHaveBeenCalled();
  });

  it('404s when the live Deezer resolution fails/returns empty', async () => {
    vi.mocked(getSongMeta).mockResolvedValue(songMeta({ deezerId: 111, previewUrl: null }));
    vi.mocked(resolveDeezerPreviewUrl).mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/preview' });
    expect(res.statusCode).toBe(404);
  });

  it('500 and logs when getSongMeta throws', async () => {
    vi.mocked(getSongMeta).mockRejectedValue(new Error('db down'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/preview' });
    expect(res.statusCode).toBe(500);
  });
});

describe('PATCH /api/songs/:songKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects invalid rating', async () => {
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/songs/queen%3A%3Abohemian%20rhapsody', payload: { rating: 'meh' },
    });
    expect(res.statusCode).toBe(400);
    expect(patchSongUserMeta).not.toHaveBeenCalled();
  });

  it('rejects out-of-range and non-integer score', async () => {
    const app = buildApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/k', payload: { score: 101 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/k', payload: { score: -1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/k', payload: { score: 1.5 } })).statusCode).toBe(400);
    expect(patchSongUserMeta).not.toHaveBeenCalled();
  });

  it('rejects non-boolean listened/favorite/downloaded', async () => {
    const app = buildApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/k', payload: { listened: 'yes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/k', payload: { favorite: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/k', payload: { downloaded: 'true' } })).statusCode).toBe(400);
    expect(patchSongUserMeta).not.toHaveBeenCalled();
  });

  it('accepts null rating and null score', async () => {
    vi.mocked(patchSongUserMeta).mockResolvedValue({ songKey: 'k' } as never);
    const app = buildApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/songs/k', payload: { rating: null, score: null } })).statusCode).toBe(200);
  });

  it('passes valid patch through and returns updated meta', async () => {
    vi.mocked(patchSongUserMeta).mockResolvedValue({ songKey: 'queen::bohemian rhapsody', listened: true } as never);
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/songs/queen%3A%3Abohemian%20rhapsody',
      payload: { rating: 'like', favorite: true },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(patchSongUserMeta)).toHaveBeenCalledWith('queen::bohemian rhapsody', {
      rating: 'like', favorite: true,
    });
    expect(res.json().meta.listened).toBe(true);
  });

  it('500 and logs when the update fails', async () => {
    vi.mocked(patchSongUserMeta).mockRejectedValue(new Error('db down'));
    const res = await buildApp().inject({ method: 'PATCH', url: '/api/songs/k', payload: { favorite: true } });
    expect(res.statusCode).toBe(500);
  });
});


describe('inLibrary also counts songs with a recorded file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(syncDownloadedFlags).mockResolvedValue({ scanned: 0, matched: 0, updated: 0 });
    vi.mocked(scanLibrary).mockResolvedValue([]);
    vi.mocked(findLibraryTrack).mockReturnValue(null);
    _resetSyncThrottleForTest();
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [BOHEMIAN])]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
  });

  it('flags a song whose MP3 is in song_files even when its file name cannot be matched', async () => {
    vi.mocked(listReadySongKeys).mockResolvedValue(new Set(['queen::bohemian rhapsody']));
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.json().songs[0].inLibrary).toBe(true);
  });

  it('a failing song_files lookup only costs the extra flags, never the list', async () => {
    vi.mocked(listReadySongKeys).mockRejectedValue(new Error('db down'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(200);
    expect(res.json().songs[0].inLibrary).toBe(false);
  });
});

describe('first play: POST /api/songs/:songKey/download and GET /api/songs/:songKey/state', () => {
  const track = { state: 'preparing', source: 'none', version: null, bytes: null, error: null } as never;
  beforeEach(() => vi.clearAllMocks());

  it('"play" asks for the song with priority and does not force a retry of a failed one', async () => {
    vi.mocked(requestSongDownload).mockResolvedValue(track);
    const res = await buildApp().inject({
      method: 'POST', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/download', payload: { priority: 'play' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, state: 'preparing' });
    const [key, , opts] = vi.mocked(requestSongDownload).mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(key).toBe('queen::bohemian rhapsody'); // already decoded by the router
    expect(opts).toMatchObject({ priority: 'play', retry: false });
  });

  it('the request shows in the activity trail — who, which song, priority, outcome — once a minute per song', async () => {
    _resetActivityThrottleForTest();
    vi.mocked(requestSongDownload).mockResolvedValue({ ...(track as object), title: 'Bohemian Rhapsody', artist: 'Queen' } as never);
    const post = () => buildApp().inject({ method: 'POST', url: '/api/songs/queen%3A%3Abohemian%20rhapsody/download', headers: { 'remote-user': 'sara' }, payload: { priority: 'play' } });
    await post();
    await post(); // a second click within the minute
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledWith(
      'download', 'request', 'sara (web) chiede «Bohemian Rhapsody – Queen» (priorità play) → preparing',
      { user: 'sara', device: 'web', channel: 'web' },
      expect.objectContaining({ songKey: 'queen::bohemian rhapsody', priority: 'play', state: 'preparing' }),
    );
  });

  it('an explicit download (no priority) retries a failed song', async () => {
    vi.mocked(requestSongDownload).mockResolvedValue(track);
    await buildApp().inject({ method: 'POST', url: '/api/songs/a%3A%3Ab/download' });
    expect((vi.mocked(requestSongDownload).mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2])
      .toMatchObject({ priority: 'sync', retry: true });
  });

  it('404s for a song the user does not have; 500 when the request fails', async () => {
    vi.mocked(requestSongDownload).mockResolvedValue(null);
    expect((await buildApp().inject({ method: 'POST', url: '/api/songs/x%3A%3Ay/download' })).statusCode).toBe(404);
    vi.mocked(requestSongDownload).mockRejectedValue(new Error('boom'));
    expect((await buildApp().inject({ method: 'POST', url: '/api/songs/x%3A%3Ay/download' })).statusCode).toBe(500);
  });

  it('state reports what the web player needs to decide between the file and the fallback', async () => {
    vi.mocked(getTrack).mockResolvedValue({ state: 'ready', source: 'ytdlp', version: '10-1', bytes: 10, error: null } as never);
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs/x%3A%3Ay/state' });
    // no location known (the lookup came back empty): the legacy answer, `location` null
    expect(res.json()).toEqual({ state: 'ready', source: 'ytdlp', version: '10-1', bytes: 10, error: null, inLibrary: true, location: null });

    vi.mocked(getTrack).mockResolvedValue({ state: 'no_source', source: 'none', version: null, bytes: null, error: 'serve un link' } as never);
    expect((await buildApp().inject({ method: 'GET', url: '/api/songs/x%3A%3Ay/state' })).json())
      .toMatchObject({ state: 'no_source', inLibrary: false, error: 'serve un link' });

    vi.mocked(getTrack).mockResolvedValue(null);
    expect((await buildApp().inject({ method: 'GET', url: '/api/songs/x%3A%3Ay/state' })).statusCode).toBe(404);
  });

  it('state says WHERE the song is (spec W2/W8) and the green dot follows it: fs || mediaServer', async () => {
    vi.mocked(getTrack).mockResolvedValue({ songKey: 'kavinsky::nightcall', artist: 'Kavinsky', title: 'Nightcall', state: 'ready', source: 'existing', version: '10-0', bytes: 10, error: null } as never);
    vi.mocked(locateSongs).mockResolvedValue(new Map([['kavinsky::nightcall', {
      fs: false, mediaServer: true, fsPath: null, mediaPath: 'Music/Kavinsky/Nightcall/01.mp3',
      mediaUrl: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Kavinsky/Nightcall/01.mp3', streamUrl: 'https://www.youtube.com/watch?v=abc',
    }]]));
    const res = (await buildApp().inject({ method: 'GET', url: '/api/songs/kavinsky%3A%3Anightcall/state' })).json();
    expect(res.inLibrary).toBe(true); // only on the box: still a green dot, and the location explains it
    expect(res.location).toEqual({
      fs: false, mediaServer: true, fsPath: null,
      mediaUrl: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Kavinsky/Nightcall/01.mp3', streamUrl: 'https://www.youtube.com/watch?v=abc',
    });

    // a "ready" state without any location is not a green dot: the dot is explained or it is off
    vi.mocked(locateSongs).mockResolvedValue(new Map([['kavinsky::nightcall', { fs: false, mediaServer: false, fsPath: null, mediaUrl: null, mediaPath: null, streamUrl: null }]]));
    expect((await buildApp().inject({ method: 'GET', url: '/api/songs/kavinsky%3A%3Anightcall/state' })).json().inLibrary).toBe(false);
  });
});

describe('GET /api/songs: where each song is, and the green dot (spec W2/W8)', () => {
  const entry = (songs: unknown[]) => ({ id: 'e1', createdAt: '2026-07-01T00:00:00Z', sourcePlatform: 'instagram', results: { songs } }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSyncThrottleForTest();
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
    vi.mocked(scanLibrary).mockResolvedValue([]);
    vi.mocked(listReadySongKeys).mockResolvedValue(new Set<string>());
  });

  it('flags and paths come from the location lookup; inLibrary is EXACTLY fs || mediaServer', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry([
      { title: 'Nightcall', artist: 'Kavinsky' }, { title: 'Foto di gruppo', artist: 'Bassi Maestro' }, { title: 'Ghost', artist: 'Nobody' },
    ])]);
    vi.mocked(locateSongs).mockResolvedValue(new Map([
      ['kavinsky::nightcall', { fs: false, mediaServer: true, fsPath: null, mediaUrl: 'http://box/k.mp3', mediaPath: 'Music/k.mp3', streamUrl: null }],
      ['bassi maestro::foto di gruppo', { fs: true, mediaServer: false, fsPath: '~/Music/Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3', mediaUrl: null, mediaPath: null, streamUrl: null }],
      ['nobody::ghost', { fs: false, mediaServer: false, fsPath: null, mediaUrl: null, mediaPath: null, streamUrl: null }],
    ]));
    const { songs } = (await buildApp().inject({ method: 'GET', url: '/api/songs' })).json() as { songs: Array<Record<string, unknown>> };
    const by = Object.fromEntries(songs.map((s) => [s.songKey as string, s]));
    expect(by['kavinsky::nightcall']).toMatchObject({ inLibrary: true, fs: false, mediaServer: true, fsPath: null, mediaUrl: 'http://box/k.mp3' });
    expect(by['bassi maestro::foto di gruppo']).toMatchObject({ inLibrary: true, fs: true, mediaServer: false, fsPath: '~/Music/Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3', mediaUrl: null });
    expect(by['nobody::ghost']).toMatchObject({ inLibrary: false, fs: false, mediaServer: false });
  });

  it('a failing location lookup costs only the extra fields: the list and the old flags still come', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry([{ title: 'Nightcall', artist: 'Kavinsky' }])]);
    vi.mocked(listReadySongKeys).mockResolvedValue(new Set(['kavinsky::nightcall']));
    vi.mocked(locateSongs).mockRejectedValue(new Error('db down'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/songs' });
    expect(res.statusCode).toBe(200);
    expect(res.json().songs[0]).toMatchObject({ songKey: 'kavinsky::nightcall', inLibrary: true });
    expect(res.json().songs[0].fs).toBeUndefined();
  });
});


describe('aggregateSongs facets (what the playlist manager filters on)', () => {
  const ent = (id: string, createdAt: string, platform: string, tags: unknown, songs: unknown[]) =>
    ({ id, createdAt, sourcePlatform: platform, results: { songs, tags } }) as never;
  const song = (source: string | undefined) => ({ title: 'White Flag', artist: 'Bishop Briggs', ...(source ? { source } : {}) });

  it('collects, per song, how it was found, from which platforms and under which tags — sorted, no duplicates', () => {
    const out = aggregateSongs(
      [
        ent('e1', '2026-07-03T00:00:00Z', 'shazam', ['#sera', 'rock'], [song('shazam_link')]),
        ent('e2', '2026-07-02T00:00:00Z', 'instagram', ['rock', '#estate'], [song('ai_analysis')]),
        ent('e3', '2026-07-01T00:00:00Z', 'instagram', [], [song('ai_analysis')]),
      ],
      new Map(),
    );
    const s = out.get('bishop briggs::white flag')!;
    expect(s.sources).toEqual(['ai_analysis', 'shazam_link']);
    expect(s.platforms).toEqual(['instagram', 'shazam']);
    expect(s.tags).toEqual(['#estate', '#sera', 'rock']);
    expect(s.mentions).toHaveLength(3);
  });

  it('tolerates entries without tags, without a source on the song, or with garbage in them', () => {
    const out = aggregateSongs(
      [
        ent('e1', '2026-07-02T00:00:00Z', 'other', undefined, [song(undefined)]),
        ent('e2', '2026-07-01T00:00:00Z', '', [null, 7, '', 'ok'], [song('music_list')]),
      ],
      new Map(),
    );
    const s = out.get('bishop briggs::white flag')!;
    expect(s.sources).toEqual(['music_list']);
    expect(s.platforms).toEqual(['other']);
    expect(s.tags).toEqual(['ok']);
  });
});
