import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn() }));

import { filmKey, patchFilmUserMeta, upsertFilmEnrichment, upsertStreamingOptions, getFilmMeta } from './filmMeta';
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
  it('regression: coerces a numeric year (e.g. from JSONB stored as JSON number) instead of throwing', () => {
    expect(filmKey('Heat', 1995 as unknown as string)).toBe('heat::1995');
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

  /**
   * Helper: verify that every parameter in params[] is referenced in the SQL.
   * Extracts all $n placeholders, ensures they cover 1..params.length with no gaps.
   */
  function assertAllParamsUsed(sql: string, params: unknown[]): void {
    const placeholderMatches = sql.match(/\$\d+/g) || [];
    const referencedIndices = new Set(placeholderMatches.map(p => Number(p.slice(1))));
    // Verify every index 1..params.length is referenced
    for (let i = 1; i < params.length; i++) {
      expect(referencedIndices.has(i)).toBe(true);
    }
    // Verify no orphan parameters beyond params.length
    const maxIndex = Math.max(...Array.from(referencedIndices));
    expect(maxIndex).toBeLessThanOrEqual(params.length);
  }

  it('setting rating forces watched = true', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...ROW, rating: 'fresh', watched: true }]);
    const rec = await patchFilmUserMeta('heat::1995', { rating: 'fresh' });
    const updateSql = vi.mocked(query).mock.calls[1][0];
    expect(updateSql).toContain('watched = true');
    expect(rec.watched).toBe(true);
  });

  it('patch with both rating and score produces exactly one watched assignment', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...ROW, rating: 'fresh', score: 85, watched: true }]);
    await patchFilmUserMeta('heat::1995', { rating: 'fresh', score: 85 });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    const watchedMatches = updateSql.match(/watched\s*=/g) || [];
    expect(watchedMatches).toHaveLength(1);
    expect(updateSql).toContain('watched = true');
    assertAllParamsUsed(updateSql, params);
  });

  it('patch with watched=false and rating=fresh produces exactly one watched=true assignment', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...ROW, watched: true, rating: 'fresh' }]);
    await patchFilmUserMeta('heat::1995', { watched: false, rating: 'fresh' });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    const watchedMatches = updateSql.match(/watched\s*=/g) || [];
    expect(watchedMatches).toHaveLength(1);
    expect(updateSql).toContain('watched = true');
    assertAllParamsUsed(updateSql, params);
  });

  it('patch watched=false alone produces watched assignment with false param', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...ROW, watched: false }]);
    await patchFilmUserMeta('heat::1995', { watched: false });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    const watchedMatches = updateSql.match(/watched\s*=/g) || [];
    expect(watchedMatches).toHaveLength(1);
    expect(updateSql).toMatch(/watched\s*=\s*\$/);
    assertAllParamsUsed(updateSql, params);
  });

  it('patch with watched=true and score=90 forces watched=true (no param orphan)', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...ROW, watched: true, score: 90 }]);
    await patchFilmUserMeta('heat::1995', { watched: true, score: 90 });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    const watchedMatches = updateSql.match(/watched\s*=/g) || [];
    expect(watchedMatches).toHaveLength(1);
    expect(updateSql).toContain('watched = true');
    assertAllParamsUsed(updateSql, params);
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

describe('upsertStreamingOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const OPTIONS = [
    { platform: 'Netflix', type: 'SUBSCRIPTION' as const, is_free: false, price: null, url: 'https://netflix.com/1' },
  ];

  it('ensures the row exists then updates streaming columns, never touching user-state columns', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await upsertStreamingOptions({ filmKey: 'heat::1995', options: OPTIONS, watchmodeTitleId: 42 });

    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    const [ensureSql, ensureParams] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(ensureSql).toContain('ON CONFLICT (film_key) DO NOTHING');
    expect(ensureParams).toEqual(['heat::1995']);

    const [updateSql, updateParams] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    expect(updateSql).not.toMatch(/\b(watched|rating|score)\b/);
    expect(updateSql).toContain('streaming_options = $2::jsonb');
    expect(updateSql).toContain('streaming_checked_at = now()');
    expect(updateSql).toContain('watchmode_title_id = COALESCE($3, watchmode_title_id)');
    expect(updateParams).toEqual(['heat::1995', JSON.stringify(OPTIONS), 42]);
  });

  it('passes null watchmodeTitleId through so COALESCE preserves the existing value', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await upsertStreamingOptions({ filmKey: 'heat::1995', options: [], watchmodeTitleId: null });

    const [, updateParams] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    expect(updateParams).toEqual(['heat::1995', '[]', null]);
  });
});

describe('getFilmMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the mapped record for a single film_key lookup', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { ...ROW, streaming_options: [], streaming_checked_at: null, watchmode_title_id: 42 },
    ]);

    const rec = await getFilmMeta('heat::1995');

    expect(rec).not.toBeNull();
    expect(rec!.filmKey).toBe('heat::1995');
    expect(rec!.watchmodeTitleId).toBe(42);
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE film_key = $1');
    expect(params).toEqual(['heat::1995']);
  });

  it('returns null when no row matches', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    const rec = await getFilmMeta('nope::1999');
    expect(rec).toBeNull();
  });
});
