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
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerSongsRoutes, _resetSyncThrottleForTest } from './songs';
import { listEntries } from '../utils/db';
import { listSongMeta, patchSongUserMeta, getSongMeta } from '../services/songMeta';
import { resolveDeezerPreviewUrl } from '../services/songEnrichment';
import { syncDownloadedFlags, scanLibrary, findLibraryTrack } from '../services/musicLibrary';
import { logError } from '../utils/logger';
import type { SongMetaRecord } from '../types';

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

describe('GET /api/songs/:songKey/file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(scanLibrary).mockResolvedValue([]);
    vi.mocked(findLibraryTrack).mockReturnValue(null);
  });

  it('404s for an unknown song', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    vi.mocked(listSongMeta).mockResolvedValue(new Map());
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
