import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn() }));

import { filmKey, patchFilmUserMeta, upsertFilmEnrichment } from './filmMeta';
import { query } from '../utils/db';

describe('filmKey', () => {
  it('lowercases and trims title, appends year', () => {
    expect(filmKey('  A Scanner Darkly ', '2006')).toBe('a scanner darkly::2006');
  });
  it('handles missing year', () => {
    expect(filmKey('Heat', null)).toBe('heat::');
    expect(filmKey('Heat', undefined)).toBe('heat::');
  });
  it('collapses internal whitespace', () => {
    expect(filmKey('The  Matrix', '1999')).toBe('the matrix::1999');
  });
  it('trims year', () => {
    expect(filmKey('Heat', ' 1995 ')).toBe('heat::1995');
  });
});

const ROW = {
  film_key: 'heat::1995',
  tmdb_id: 949,
  genres: ['Thriller'],
  overview: 'x',
  film_cast: ['Al Pacino'],
  tmdb_score: '7.9',
  watched: false,
  rating: null,
  score: null,
  availability: {},
};

describe('patchFilmUserMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setting rating forces watched = true', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...ROW, rating: 'fresh', watched: true }]);
    const rec = await patchFilmUserMeta('heat::1995', { rating: 'fresh' });
    const updateSql = vi.mocked(query).mock.calls[1][0];
    expect(updateSql).toContain('watched = true');
    expect(rec.watched).toBe(true);
  });

  it('availability merge adds and removes keys', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]);
    await patchFilmUserMeta('heat::1995', {
      availability: { primeVideo: 'paid', netflix: null },
    });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    expect(updateSql).toContain('availability ||');
    expect(params).toContain('{"primeVideo":"paid"}');
    expect(params).toContain('netflix');
  });
});

describe('upsertFilmEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never touches user-state columns', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertFilmEnrichment({
      filmKey: 'heat::1995',
      tmdbId: 949,
      genres: ['Thriller'],
      overview: 'x',
      cast: ['Al Pacino'],
      tmdbScore: 7.9,
    });
    const sql = vi.mocked(query).mock.calls[0][0];
    expect(sql).not.toMatch(/\b(watched|rating|score|availability)\b/);
  });
});
