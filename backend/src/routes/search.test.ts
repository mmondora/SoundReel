import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({ query: vi.fn() }));
vi.mock('../services/queryExpander', () => ({ expandQuery: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn(), logWarning: vi.fn() }));

import { registerSearchRoute } from './search';
import { query } from '../utils/db';
import { expandQuery } from '../services/queryExpander';

function buildApp() {
  const app = Fastify();
  registerSearchRoute(app);
  return app;
}

describe('GET /api/search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty result for short query (< 2 chars)', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=a' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [], expandedTerms: [], total: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns empty result for missing q param', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/search' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [], expandedTerms: [], total: 0 });
  });

  it('returns results for valid query with no synonyms', async () => {
    vi.mocked(expandQuery).mockResolvedValue([]);
    vi.mocked(query).mockResolvedValue([
      {
        id: 'abc',
        source_url: 'https://example.com',
        source_platform: 'youtube',
        caption: 'test',
        thumbnail_url: null,
        results: { songs: [], films: [], notes: [], tags: [], summary: null },
        created_at: new Date('2026-06-23'),
        rank: 0.5,
      },
    ]);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=spotify' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].sourceUrl).toBe('https://example.com');
    expect(body.expandedTerms).toEqual([]);
    expect(body.total).toBe(1);
  });

  it('includes expandedTerms in response when synonyms returned', async () => {
    vi.mocked(expandQuery).mockResolvedValue(['music', 'playlist']);
    vi.mocked(query).mockResolvedValue([]);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=spotify' });
    expect(res.statusCode).toBe(200);
    expect(res.json().expandedTerms).toEqual(['music', 'playlist']);
  });

  it('returns 500 on Postgres error', async () => {
    vi.mocked(expandQuery).mockResolvedValue([]);
    vi.mocked(query).mockRejectedValue(new Error('DB down'));
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=spotify' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('Search failed');
  });

  it('caps limit at 50 when a higher value is requested', async () => {
    vi.mocked(expandQuery).mockResolvedValue([]);
    vi.mocked(query).mockResolvedValue([]);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=spotify&limit=200' });
    expect(res.statusCode).toBe(200);
    // Verify the SQL was called with limit capped at 50
    expect(vi.mocked(query)).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([50]),
    );
  });
});
