import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({ listEntries: vi.fn() }));
vi.mock('../services/filmMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/filmMeta')>();
  return {
    filmKey: actual.filmKey,
    listFilmMeta: vi.fn(),
    patchFilmUserMeta: vi.fn(),
  };
});
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerFilmsRoutes } from './films';
import { listEntries } from '../utils/db';
import { listFilmMeta, patchFilmUserMeta } from '../services/filmMeta';

function buildApp() {
  const app = Fastify();
  registerFilmsRoutes(app);
  return app;
}

function entry(id: string, createdAt: string, films: unknown[]) {
  return { id, createdAt, results: { films } } as never;
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

  it('skips malformed film objects without failing', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [null, { noTitle: true }, HEAT]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    expect(res.statusCode).toBe(200);
    expect(res.json().films).toHaveLength(1);
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
