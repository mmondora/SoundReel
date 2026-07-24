import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({
  pool: { connect: vi.fn() },
  listEntries: vi.fn(),
  getEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  deleteAllEntries: vi.fn(),
  appendActionLog: vi.fn(),
  createActionLog: vi.fn(),
}));
vi.mock('../services/spotify', () => ({ addToPlaylist: vi.fn() }));
vi.mock('../services/openaiEnrich', () => ({ enrichWithOpenAI: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { registerEntriesRoutes } from './entries';
import { getEntry, updateEntry, appendActionLog, createActionLog } from '../utils/db';
import { enrichWithOpenAI } from '../services/openaiEnrich';

function buildApp() {
  const app = Fastify();
  registerEntriesRoutes(app);
  return app;
}

const MOCK_ENTRY = {
  id: 'entry-1',
  sourceUrl: 'https://github.com/foo/bar',
  caption: 'check this out',
  results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
};

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
    vi.mocked(getEntry).mockResolvedValue(null);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: { entryId: 'missing' } });
    expect(res.statusCode).toBe(404);
  });

  it('persists and logs the enrichment on success', async () => {
    vi.mocked(getEntry).mockResolvedValue(MOCK_ENTRY as never);
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
  });

  it('returns 500 and logs manual_enrich_failed when the service throws', async () => {
    vi.mocked(getEntry).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(enrichWithOpenAI).mockRejectedValue(new Error('OpenAI API key non configurata.'));
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().success).toBe(false);
    expect(createActionLog).toHaveBeenCalledWith('manual_enrich_failed', expect.objectContaining({ error: expect.stringContaining('OpenAI API key') }));
  });
});
