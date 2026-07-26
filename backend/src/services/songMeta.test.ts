import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn() }));

import { songKey, patchSongUserMeta, upsertSongEnrichment, listSongMeta, getSongMeta } from './songMeta';
import { query } from '../utils/db';

describe('songKey', () => {
  it('lowercases and trims both sides, artist first', () => {
    expect(songKey('  Daft Punk ', ' One More Time ')).toBe('daft punk::one more time');
  });
  it('collapses internal whitespace on both sides', () => {
    expect(songKey('The  Weeknd', 'Blinding   Lights')).toBe('the weeknd::blinding lights');
  });
  it('is stable regardless of casing', () => {
    expect(songKey('DAFT PUNK', 'ONE MORE TIME')).toBe(songKey('daft punk', 'one more time'));
  });
});

const ROW = {
  song_key: 'daft punk::one more time',
  deezer_id: 123,
  itunes_id: 456,
  genres: ['Electronic'],
  album: 'Discovery',
  cover_url: 'https://example.com/cover.jpg',
  preview_url: 'https://example.com/preview.mp3',
  deezer_url: 'https://deezer.com/track/123',
  itunes_url: 'https://itunes.apple.com/track/456',
  enriched_at: null,
  listened: false,
  favorite: false,
  downloaded: false,
  rating: null,
  score: null,
};

describe('patchSongUserMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper: verify that every parameter in params[] is referenced in the SQL.
   * Extracts all $n placeholders, ensures they cover 1..params.length with no gaps.
   */
  function assertAllParamsUsed(sql: string, params: unknown[]): void {
    const placeholderMatches = sql.match(/\$\d+/g) || [];
    const referencedIndices = new Set(placeholderMatches.map((p) => Number(p.slice(1))));
    for (let i = 1; i < params.length; i++) {
      expect(referencedIndices.has(i)).toBe(true);
    }
    const maxIndex = Math.max(...Array.from(referencedIndices));
    expect(maxIndex).toBeLessThanOrEqual(params.length);
  }

  it('setting rating forces listened = true', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ROW, rating: 'like', listened: true }]);
    const rec = await patchSongUserMeta('daft punk::one more time', { rating: 'like' });
    const updateSql = vi.mocked(query).mock.calls[1][0];
    expect(updateSql).toContain('listened = true');
    expect(rec.listened).toBe(true);
  });

  it('patch with both rating and score produces exactly one listened assignment', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ROW, rating: 'like', score: 85, listened: true }]);
    await patchSongUserMeta('daft punk::one more time', { rating: 'like', score: 85 });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    const listenedMatches = updateSql.match(/listened\s*=/g) || [];
    expect(listenedMatches).toHaveLength(1);
    expect(updateSql).toContain('listened = true');
    assertAllParamsUsed(updateSql, params);
  });

  it('patch with listened=false and rating=like produces exactly one listened=true assignment', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ROW, listened: true, rating: 'like' }]);
    await patchSongUserMeta('daft punk::one more time', { listened: false, rating: 'like' });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    const listenedMatches = updateSql.match(/listened\s*=/g) || [];
    expect(listenedMatches).toHaveLength(1);
    expect(updateSql).toContain('listened = true');
    assertAllParamsUsed(updateSql, params);
  });

  it('patch listened=false alone produces listened assignment with false param', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ROW, listened: false }]);
    await patchSongUserMeta('daft punk::one more time', { listened: false });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    const listenedMatches = updateSql.match(/listened\s*=/g) || [];
    expect(listenedMatches).toHaveLength(1);
    expect(updateSql).toMatch(/listened\s*=\s*\$/);
    assertAllParamsUsed(updateSql, params);
  });

  it('patch with listened=true and score=90 forces listened=true (no param orphan)', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ROW, listened: true, score: 90 }]);
    await patchSongUserMeta('daft punk::one more time', { listened: true, score: 90 });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    const listenedMatches = updateSql.match(/listened\s*=/g) || [];
    expect(listenedMatches).toHaveLength(1);
    expect(updateSql).toContain('listened = true');
    assertAllParamsUsed(updateSql, params);
  });

  it('patch favorite alone produces a single favorite assignment', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ROW, favorite: true }]);
    await patchSongUserMeta('daft punk::one more time', { favorite: true });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    expect(updateSql).toMatch(/favorite\s*=\s*\$/);
    assertAllParamsUsed(updateSql, params);
  });

  it('patch downloaded alone produces a single downloaded assignment', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ROW, downloaded: true }]);
    await patchSongUserMeta('daft punk::one more time', { downloaded: true });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    expect(updateSql).toMatch(/downloaded\s*=\s*\$/);
    assertAllParamsUsed(updateSql, params);
  });

  it('patch with all fields keeps params aligned with placeholders', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...ROW, rating: 'dislike', score: 10, favorite: true, downloaded: true, listened: true }]);
    await patchSongUserMeta('daft punk::one more time', {
      rating: 'dislike',
      score: 10,
      favorite: true,
      downloaded: true,
    });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    assertAllParamsUsed(updateSql, params);
  });

  it('ensures the row exists before updating (ON CONFLICT DO NOTHING)', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]);
    await patchSongUserMeta('daft punk::one more time', { favorite: true });
    const [ensureSql, ensureParams] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(ensureSql).toContain('ON CONFLICT (song_key) DO NOTHING');
    expect(ensureParams).toEqual(['daft punk::one more time']);
  });
});

describe('upsertSongEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never touches user-state columns', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertSongEnrichment({
      songKey: 'daft punk::one more time',
      deezerId: 123,
      itunesId: null,
      genres: ['Electronic'],
      album: 'Discovery',
      coverUrl: 'https://example.com/cover.jpg',
      previewUrl: 'https://example.com/preview.mp3',
      deezerUrl: 'https://deezer.com/track/123',
      itunesUrl: null,
    });
    const sql = vi.mocked(query).mock.calls[0][0];
    expect(sql).not.toMatch(/\b(listened|favorite|downloaded|rating|score)\b/);
  });

  it('sets enriched_at = now()', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertSongEnrichment({
      songKey: 'daft punk::one more time',
      deezerId: 123,
      itunesId: null,
      genres: [],
      album: null,
      coverUrl: null,
      previewUrl: null,
      deezerUrl: null,
      itunesUrl: null,
    });
    const sql = vi.mocked(query).mock.calls[0][0];
    expect(sql).toContain('enriched_at = now()');
  });
});

describe('listSongMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a Map keyed by song_key', async () => {
    vi.mocked(query).mockResolvedValueOnce([ROW]);
    const map = await listSongMeta();
    expect(map.size).toBe(1);
    expect(map.get('daft punk::one more time')?.deezerId).toBe(123);
  });
});

describe('getSongMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the mapped record for a single song_key lookup', async () => {
    vi.mocked(query).mockResolvedValueOnce([ROW]);
    const rec = await getSongMeta('daft punk::one more time');
    expect(rec).not.toBeNull();
    expect(rec!.songKey).toBe('daft punk::one more time');
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE song_key = $1');
    expect(params).toEqual(['daft punk::one more time']);
  });

  it('returns null when no row matches', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    const rec = await getSongMeta('nope::nope');
    expect(rec).toBeNull();
  });
});
