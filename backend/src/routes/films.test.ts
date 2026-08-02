import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({ listEntries: vi.fn() }));
vi.mock('../services/filmMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/filmMeta')>();
  return {
    filmKey: actual.filmKey,
    listFilmMeta: vi.fn(),
    patchFilmUserMeta: vi.fn(),
    upsertArchiveEnrichment: vi.fn(),
    setArchiveDownloadedPath: vi.fn(),
  };
});
vi.mock('../services/streamingAvailability', () => ({
  streamingConfigured: vi.fn(),
}));
vi.mock('../services/streamingRefresher', () => ({
  refreshStreamingForFilm: vi.fn(),
  extractImdbId: vi.fn(),
}));
vi.mock('../services/archiveEnrichment', () => ({
  enrichFilmFromArchive: vi.fn(),
}));
vi.mock('../services/archiveDownloader', () => ({
  downloadArchiveFilm: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerFilmsRoutes } from './films';
import { listEntries } from '../utils/db';
import { listFilmMeta, patchFilmUserMeta, upsertArchiveEnrichment, setArchiveDownloadedPath } from '../services/filmMeta';
import { streamingConfigured } from '../services/streamingAvailability';
import { refreshStreamingForFilm, extractImdbId } from '../services/streamingRefresher';
import { enrichFilmFromArchive } from '../services/archiveEnrichment';
import { downloadArchiveFilm } from '../services/archiveDownloader';
import type { FilmMetaRecord } from '../types';

function buildApp() {
  const app = Fastify();
  registerFilmsRoutes(app);
  return app;
}

function entry(id: string, createdAt: string, films: unknown[]) {
  return { id, createdAt, results: { films } } as never;
}

function filmMeta(overrides: Partial<FilmMetaRecord> = {}): FilmMetaRecord {
  return {
    filmKey: 'metropolis::1927',
    tmdbId: null,
    genres: [],
    overview: null,
    cast: [],
    tmdbScore: null,
    watched: false,
    rating: null,
    score: null,
    availability: {},
    streamingOptions: null,
    streamingCheckedAt: null,
    watchmodeTitleId: null,
    iaIdentifier: null,
    iaTitle: null,
    iaYear: null,
    iaPageUrl: null,
    iaFileUrl: null,
    iaCheckedAt: null,
    iaDownloadedPath: null,
    ...overrides,
  };
}

const HEAT = { title: 'Heat', director: 'Michael Mann', year: '1995', imdbUrl: null, posterUrl: 'p.jpg', streamingUrls: null };

describe('GET /api/films', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dedups mentions of the same film across entries', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [HEAT]),
      entry('e2', '2026-07-02T00:00:00Z', [{ ...HEAT, title: ' heat ' }]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    expect(res.statusCode).toBe(200);
    const { films } = res.json();
    expect(films).toHaveLength(1);
    expect(films[0].filmKey).toBe('heat::1995');
    expect(films[0].mentions).toHaveLength(2);
  });

  it('display fields come from the most recent mention and meta is joined', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ ...HEAT, posterUrl: null }]),
      entry('e2', '2026-07-02T00:00:00Z', [HEAT]),
    ]);
    const meta = { filmKey: 'heat::1995', tmdbId: 949, genres: ['Thriller'], overview: null, cast: [], tmdbScore: 7.9, watched: true, rating: 'fresh', score: null, availability: {} };
    vi.mocked(listFilmMeta).mockResolvedValue(new Map([['heat::1995', meta as never]]));
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    const { films } = res.json();
    expect(films[0].posterUrl).toBe('p.jpg');
    expect(films[0].meta.rating).toBe('fresh');
  });

  it('streaming meta fields (streamingOptions, streamingCheckedAt) pass through from the joined record', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [HEAT])]);
    const meta = {
      filmKey: 'heat::1995', tmdbId: 949, genres: [], overview: null, cast: [], tmdbScore: null,
      watched: false, rating: null, score: null, availability: {},
      streamingOptions: [{ platform: 'Netflix', type: 'SUBSCRIPTION', is_free: false, price: null, url: 'https://netflix.com/1' }],
      streamingCheckedAt: '2026-07-01T00:00:00.000Z',
      watchmodeTitleId: 42,
    };
    vi.mocked(listFilmMeta).mockResolvedValue(new Map([['heat::1995', meta as never]]));
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    const { films } = res.json();
    expect(films[0].meta.streamingOptions).toEqual(meta.streamingOptions);
    expect(films[0].meta.streamingCheckedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('skips malformed film objects without failing', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [null, { noTitle: true }, HEAT]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    expect(res.statusCode).toBe(200);
    expect(res.json().films).toHaveLength(1);
  });

  it('regression: a film with a numeric JSONB year is included, keyed like a string year', async () => {
    // Live prod entries can carry `year` as a JSON number rather than a
    // string (JSONB is not schema-validated on write). filmKey() used to
    // throw on `year.trim()` when year was a number, which turned the whole
    // GET /api/films aggregation into a 500 for any account with one such
    // entry.
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ ...HEAT, title: 'X', year: 1995 }]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    expect(res.statusCode).toBe(200);
    const { films } = res.json();
    expect(films).toHaveLength(1);
    expect(films[0].filmKey).toBe('x::1995');
  });

  it('regression: a film with a non-primitive year is skipped instead of causing a 500', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ ...HEAT, title: 'Weird', year: { nested: true } }, HEAT]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    expect(res.statusCode).toBe(200);
    const { films } = res.json();
    expect(films).toHaveLength(1);
    expect(films[0].title).toBe('Heat');
  });
});

describe('PATCH /api/films/:filmKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects invalid rating', async () => {
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/films/heat%3A%3A1995', payload: { rating: 'meh' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects out-of-range score and invalid availability values', async () => {
    const app = buildApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/films/k', payload: { score: 101 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/films/k', payload: { availability: { netflix: 'cheap' } } })).statusCode).toBe(400);
  });

  it('rejects a malformed availability shape instead of throwing', async () => {
    const app = buildApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/films/k', payload: { availability: null } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/films/k', payload: { availability: ['free'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/films/k', payload: { availability: 5 } })).statusCode).toBe(400);
    expect(patchFilmUserMeta).not.toHaveBeenCalled();
  });

  it('passes valid patch through and returns updated meta', async () => {
    vi.mocked(patchFilmUserMeta).mockResolvedValue({ filmKey: 'heat::1995', watched: true } as never);
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/films/heat%3A%3A1995',
      payload: { rating: 'fresh', availability: { primeVideo: 'paid', netflix: null } },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(patchFilmUserMeta)).toHaveBeenCalledWith('heat::1995', {
      rating: 'fresh', availability: { primeVideo: 'paid', netflix: null },
    });
    expect(res.json().meta.watched).toBe(true);
  });
});

describe('POST /api/films/:filmKey/refresh-streaming', () => {
  beforeEach(() => vi.clearAllMocks());

  const HEAT_WITH_IMDB = { ...HEAT, imdbUrl: 'https://www.imdb.com/title/tt0113277/' };

  it('404 when the film is not known', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/nope%3A%3A2000/refresh-streaming' });

    expect(res.statusCode).toBe(404);
    expect(refreshStreamingForFilm).not.toHaveBeenCalled();
  });

  it('404 when the film has no IMDb id', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [HEAT])]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    vi.mocked(extractImdbId).mockReturnValue(null);

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/heat%3A%3A1995/refresh-streaming' });

    expect(res.statusCode).toBe(404);
    expect(refreshStreamingForFilm).not.toHaveBeenCalled();
  });

  it('503 when the streaming provider is not configured', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [HEAT_WITH_IMDB])]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    vi.mocked(extractImdbId).mockReturnValue('tt0113277');
    vi.mocked(streamingConfigured).mockReturnValue(false);

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/heat%3A%3A1995/refresh-streaming' });

    expect(res.statusCode).toBe(503);
    expect(refreshStreamingForFilm).not.toHaveBeenCalled();
  });

  it('200 happy path: refreshes and returns the fresh meta', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [HEAT_WITH_IMDB])]);
    const freshMeta = { filmKey: 'heat::1995', watched: false, streamingOptions: [{ platform: 'Netflix' }] };
    vi.mocked(listFilmMeta)
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map([['heat::1995', freshMeta as never]]));
    vi.mocked(extractImdbId).mockReturnValue('tt0113277');
    vi.mocked(streamingConfigured).mockReturnValue(true);
    vi.mocked(refreshStreamingForFilm).mockResolvedValue([]);

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/heat%3A%3A1995/refresh-streaming' });

    expect(res.statusCode).toBe(200);
    expect(refreshStreamingForFilm).toHaveBeenCalledWith({
      filmKey: 'heat::1995',
      imdbId: 'tt0113277',
      cachedTitleId: null,
    });
    expect(res.json().meta).toEqual(freshMeta);
  });

  it('500 when the refresh call fails', async () => {
    vi.mocked(listEntries).mockResolvedValue([entry('e1', '2026-07-01T00:00:00Z', [HEAT_WITH_IMDB])]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    vi.mocked(extractImdbId).mockReturnValue('tt0113277');
    vi.mocked(streamingConfigured).mockReturnValue(true);
    vi.mocked(refreshStreamingForFilm).mockRejectedValue(new Error('watchmode 500: boom'));

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/heat%3A%3A1995/refresh-streaming' });

    expect(res.statusCode).toBe(500);
  });
});

describe('POST /api/films/:filmKey/archive-lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-08-01T00:00:00Z', [{ title: 'Metropolis', year: '1927' }]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
  });

  it('404s for an unknown film', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/nope%3A%3A1999/archive-lookup' });
    expect(res.statusCode).toBe(404);
  });

  it('persists a hit and returns the refreshed meta', async () => {
    vi.mocked(enrichFilmFromArchive).mockResolvedValue({
      status: 'hit',
      result: {
        identifier: 'metropolis',
        title: 'Metropolis',
        year: '1927',
        pageUrl: 'https://archive.org/details/metropolis',
        fileUrl: 'https://archive.org/download/metropolis/m.mp4',
      },
    });
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-lookup' });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(upsertArchiveEnrichment)).toHaveBeenCalledWith(
      expect.objectContaining({ filmKey: 'metropolis::1927' })
    );
  });

  it('persists a miss as a null result', async () => {
    vi.mocked(enrichFilmFromArchive).mockResolvedValue({ status: 'miss' });
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-lookup' });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(upsertArchiveEnrichment)).toHaveBeenCalledWith({
      filmKey: 'metropolis::1927',
      result: null,
    });
  });

  it('502s on a provider error without writing anything', async () => {
    vi.mocked(enrichFilmFromArchive).mockResolvedValue({ status: 'error' });
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-lookup' });
    expect(res.statusCode).toBe(502);
    expect(vi.mocked(upsertArchiveEnrichment)).not.toHaveBeenCalled();
  });
});

describe('POST /api/films/:filmKey/archive-download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-08-01T00:00:00Z', [{ title: 'Metropolis', year: '1927' }]),
    ]);
  });

  it('409s when the film has no archive file url', async () => {
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-download' });
    expect(res.statusCode).toBe(409);
    expect(vi.mocked(downloadArchiveFilm)).not.toHaveBeenCalled();
  });

  it('downloads and records the path', async () => {
    vi.mocked(listFilmMeta).mockResolvedValue(
      new Map([['metropolis::1927', filmMeta({ iaFileUrl: 'https://archive.org/download/metropolis/m.mp4' })]])
    );
    vi.mocked(downloadArchiveFilm).mockResolvedValue('/films/Metropolis (1927).mp4');

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-download' });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(setArchiveDownloadedPath)).toHaveBeenCalledWith(
      'metropolis::1927',
      '/films/Metropolis (1927).mp4'
    );
  });

  it('500s and records nothing when the download throws', async () => {
    vi.mocked(listFilmMeta).mockResolvedValue(
      new Map([['metropolis::1927', filmMeta({ iaFileUrl: 'https://archive.org/download/metropolis/m.mp4' })]])
    );
    vi.mocked(downloadArchiveFilm).mockRejectedValue(new Error('boom'));

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-download' });
    expect(res.statusCode).toBe(500);
    expect(vi.mocked(setArchiveDownloadedPath)).not.toHaveBeenCalled();
  });
});
