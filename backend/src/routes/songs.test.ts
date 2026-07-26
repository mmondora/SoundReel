import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

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
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerSongsRoutes } from './songs';
import { listEntries } from '../utils/db';
import { listSongMeta, patchSongUserMeta, getSongMeta } from '../services/songMeta';
import { resolveDeezerPreviewUrl } from '../services/songEnrichment';
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
  beforeEach(() => vi.clearAllMocks());

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
