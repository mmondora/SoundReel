import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({
  pool: { connect: vi.fn() },
  listEntries: vi.fn(),
  listEntrySummaries: vi.fn(),
  getJournalStats: vi.fn(),
  getEntry: vi.fn(),
  getEntryForUser: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  deleteAllEntries: vi.fn(),
  appendActionLog: vi.fn(),
  createActionLog: vi.fn(),
  shareEntry: vi.fn(),
  unshareEntry: vi.fn(),
  listEntryShares: vi.fn(),
}));
vi.mock('../services/spotify', () => ({ addToPlaylist: vi.fn() }));
vi.mock('../services/openaiEnrich', () => ({ enrichWithOpenAI: vi.fn() }));
vi.mock('../services/localMedia', () => ({
  listEntryMediaUrls: vi.fn(),
  preferLocalMediaUrls: vi.fn(async (e: unknown) => e),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { registerEntriesRoutes } from './entries';
import {
  getEntry,
  getEntryForUser,
  updateEntry,
  appendActionLog,
  createActionLog,
  listEntries,
  listEntrySummaries,
  getJournalStats,
} from '../utils/db';
import { enrichWithOpenAI } from '../services/openaiEnrich';

function buildApp() {
  const app = Fastify();
  registerEntriesRoutes(app);
  return app;
}

const VIS_ANON = { userId: 'anonymous', isAdmin: false };

const MOCK_ENTRY = {
  id: 'entry-1',
  sourceUrl: 'https://github.com/foo/bar',
  caption: 'check this out',
  ownerUser: 'mike',
  results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
};

const MOCK_SUMMARY = {
  id: 'entry-1',
  sourceUrl: 'https://instagram.com/reel/abc',
  sourcePlatform: 'instagram',
  caption: 'a caption',
  thumbnailUrl: 'https://cdn.example/thumb.jpg',
  status: 'completed',
  createdAt: '2026-07-01T00:00:00.000Z',
  summary: 'Short summary',
  songCount: 2,
  filmCount: 1,
  noteCount: 0,
  tags: ['#vacanze', 'tesla'],
};

describe('GET /api/entries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns full entries scoped to current user (anonymous without Remote-User)', async () => {
    vi.mocked(listEntries).mockResolvedValue([MOCK_ENTRY as never]);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/entries?limit=50' });
    expect(res.statusCode).toBe(200);
    expect(listEntries).toHaveBeenCalledWith(50, VIS_ANON);
    expect(listEntrySummaries).not.toHaveBeenCalled();
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('entry-1');
  });

  it('scopes to Remote-User when present', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/entries?limit=10',
      headers: { 'remote-user': 'mike', 'remote-groups': 'family,admins' },
    });
    expect(res.statusCode).toBe(200);
    expect(listEntries).toHaveBeenCalledWith(10, { userId: 'mike', isAdmin: true });
  });

  it('returns summary shape when view=summary', async () => {
    vi.mocked(listEntrySummaries).mockResolvedValue({ items: [MOCK_SUMMARY], total: 42 });
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/entries?view=summary&limit=20&offset=10',
    });
    expect(res.statusCode).toBe(200);
    expect(listEntrySummaries).toHaveBeenCalledWith(20, 10, VIS_ANON);
    expect(listEntries).not.toHaveBeenCalled();
    const body = res.json();
    expect(body).toEqual({
      entries: [MOCK_SUMMARY],
      total: 42,
      limit: 20,
      offset: 10,
    });
    expect(body.entries[0]).not.toHaveProperty('results');
    expect(body.entries[0]).not.toHaveProperty('actionLog');
    expect(body.entries[0].songCount).toBe(2);
    expect(body.entries[0].summary).toBe('Short summary');
  });

  it('defaults offset to 0 for summary view', async () => {
    vi.mocked(listEntrySummaries).mockResolvedValue({ items: [], total: 0 });
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/entries?view=summary' });
    expect(res.statusCode).toBe(200);
    expect(listEntrySummaries).toHaveBeenCalledWith(200, 0, VIS_ANON);
    expect(res.json()).toEqual({ entries: [], total: 0, limit: 200, offset: 0 });
  });
});

describe('GET /api/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns journal stats wrapper scoped to user', async () => {
    const stats = {
      totalEntries: 100,
      totalSongs: 40,
      totalFilms: 25,
      totalNotes: 10,
      totalSoftware: 5,
    };
    vi.mocked(getJournalStats).mockResolvedValue(stats);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);
    expect(getJournalStats).toHaveBeenCalledWith(VIS_ANON);
    expect(res.json()).toEqual({ stats });
  });
});

describe('POST /api/entries/enrich', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createActionLog).mockReturnValue({ action: 'test', details: {}, timestamp: '2026-01-01T00:00:00.000Z' });
  });

  it('returns 400 when entryId is missing', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when entry is not found', async () => {
    vi.mocked(getEntryForUser).mockResolvedValue(null);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: { entryId: 'missing' } });
    expect(res.statusCode).toBe(404);
  });

  it('persists and logs the enrichment on success', async () => {
    vi.mocked(getEntryForUser).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(enrichWithOpenAI).mockResolvedValue({
      category: 'tech',
      items: [{ label: 'foo/bar', explanation: 'A CLI tool', links: [{ url: 'https://github.com/foo/bar', title: 'foo/bar', snippet: '' }] }],
    });
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.enrichment.category).toBe('tech');
    expect(updateEntry).toHaveBeenCalledWith('entry-1', {
      'results.enrichments': expect.objectContaining({ category: 'tech' }),
    });
    expect(appendActionLog).toHaveBeenCalledWith('entry-1', expect.objectContaining({ action: 'test' }));
    expect(createActionLog).toHaveBeenCalledWith('manual_enrich', expect.objectContaining({ category: 'tech', items: 1, hasVerdict: false }));
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('returns 500 and logs manual_enrich_failed when the service throws', async () => {
    vi.mocked(getEntryForUser).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(enrichWithOpenAI).mockRejectedValue(new Error('OpenAI API key non configurata.'));
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().success).toBe(false);
    expect(createActionLog).toHaveBeenCalledWith('manual_enrich_failed', expect.objectContaining({ error: expect.stringContaining('OpenAI API key') }));
  });
});
