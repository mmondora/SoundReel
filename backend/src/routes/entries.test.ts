import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({
  pool: { connect: vi.fn() },
  listEntries: vi.fn(),
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
// the collections have their own tests (collectionsViewData.test.ts): here only that the routes ask for them, for the right user, and survive them failing
vi.mock('../services/collectionsViewData', () => ({
  withCollectionChips: vi.fn(),
  placesAndVenuesOfEntry: vi.fn(),
}));
// the page of the list, with its filters and its limits, has its own tests (entriesIndex.test.ts): here only that the route asks for it, with the query
// as it came and for the right viewer, adds the chips, and answers what it is told
vi.mock('./entriesIndex', () => ({ entriesIndexFor: vi.fn() }));

import { registerEntriesRoutes } from './entries';
import {
  getEntry,
  getEntryForUser,
  updateEntry,
  appendActionLog,
  createActionLog,
  listEntries,
  getJournalStats,
} from '../utils/db';
import { enrichWithOpenAI } from '../services/openaiEnrich';
import { placesAndVenuesOfEntry, withCollectionChips } from '../services/collectionsViewData';
import { logError } from '../utils/logger';
import { entriesIndexFor } from './entriesIndex';

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
    // by default the collections answer a chip for every row
    vi.mocked(withCollectionChips).mockImplementation((async (items: Array<{ id: string }>) =>
      items.map((i) => ({ ...i, collections: [{ id: 'c1', name: 'Vino' }] }))) as never);
  });

  it('returns full entries scoped to current user (anonymous without Remote-User)', async () => {
    vi.mocked(listEntries).mockResolvedValue([MOCK_ENTRY as never]);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/entries?limit=50' });
    expect(res.statusCode).toBe(200);
    expect(listEntries).toHaveBeenCalledWith(50, VIS_ANON);
    expect(entriesIndexFor).not.toHaveBeenCalled();
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
    vi.mocked(entriesIndexFor).mockResolvedValue({ status: 200, body: { entries: [MOCK_SUMMARY], total: 42, limit: 20, offset: 10 } });
    const app = buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/entries?view=summary&limit=20&offset=10',
    });
    expect(res.statusCode).toBe(200);
    expect(entriesIndexFor).toHaveBeenCalledWith({ view: 'summary', limit: '20', offset: '10' }, VIS_ANON);
    expect(listEntries).not.toHaveBeenCalled();
    const body = res.json();
    expect(body).toEqual({
      entries: [{ ...MOCK_SUMMARY, collections: [{ id: 'c1', name: 'Vino' }] }],
      total: 42,
      limit: 20,
      offset: 10,
    });
    expect(Object.keys(body)).toEqual(['entries', 'total', 'limit', 'offset']);
    expect(body.entries[0]).not.toHaveProperty('results');
    expect(body.entries[0]).not.toHaveProperty('actionLog');
    expect(body.entries[0].songCount).toBe(2);
    expect(body.entries[0].summary).toBe('Short summary');
  });

  it('asks for the page with the query as it came (the filters of the Inbox are in it), for the user who reads and nobody else', async () => {
    vi.mocked(entriesIndexFor).mockResolvedValue({ status: 200, body: { entries: [], total: 0, limit: 40, offset: 0 } });
    await buildApp().inject({
      method: 'GET',
      url: '/api/entries?view=summary&limit=40&platform=tiktok&tag=%23vino&user=sara',
      headers: { 'remote-user': 'mike', 'remote-groups': 'admins' },
    });
    expect(entriesIndexFor).toHaveBeenCalledTimes(1);
    expect(entriesIndexFor).toHaveBeenCalledWith(
      { view: 'summary', limit: '40', platform: 'tiktok', tag: '#vino', user: 'sara' },
      { userId: 'mike', isAdmin: true },
    );
  });

  it('keeps what the page says about each post (who sent it, its category, its verdict) next to the chips', async () => {
    const withExtras = { ...MOCK_SUMMARY, inputChannel: 'telegram', inputUser: 'sara', category: 'claim', verdict: { label: 'falso', confidence: 82 } };
    vi.mocked(entriesIndexFor).mockResolvedValue({ status: 200, body: { entries: [withExtras], total: 1, limit: 200, offset: 0 } });
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary' });
    expect(res.json().entries[0]).toEqual({ ...withExtras, collections: [{ id: 'c1', name: 'Vino' }] });
  });

  it('says what the page says when the request is wrong (a 400 with its field), and asks for no chips', async () => {
    vi.mocked(entriesIndexFor).mockResolvedValue({ status: 400, body: { error: 'invalid_query:tag' } });
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary&tag=a&tag=b' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_query:tag' });
    expect(withCollectionChips).not.toHaveBeenCalled();
  });

  it('a failure to read the page is a 500 with nothing of it in the body, and goes to the log', async () => {
    vi.mocked(entriesIndexFor).mockRejectedValue(new Error('secret detail: the database at 10.0.0.5 is down'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'entries_failed' });
    expect(res.body).not.toContain('secret');
    expect(logError).toHaveBeenCalledTimes(1);
    expect(withCollectionChips).not.toHaveBeenCalled();
  });

  it('gives each summary row the chips of the collections it is in, asked for the whole page at once and for the user who reads', async () => {
    vi.mocked(entriesIndexFor).mockResolvedValue({ status: 200, body: { entries: [MOCK_SUMMARY, { ...MOCK_SUMMARY, id: 'entry-2' }], total: 2, limit: 200, offset: 0 } });
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary', headers: { 'remote-user': 'mike', 'remote-groups': 'admins' } });
    expect(res.statusCode).toBe(200);
    expect(withCollectionChips).toHaveBeenCalledTimes(1);
    const [rows, userId] = vi.mocked(withCollectionChips).mock.calls[0];
    expect((rows as Array<{ id: string }>).map((r) => r.id)).toEqual(['entry-1', 'entry-2']);
    // the collections are the user's own: an administrator reads the posts of anonymous too, but the chips are theirs
    expect(userId).toBe('mike');
    expect(res.json().entries.map((e: { collections: unknown }) => e.collections)).toEqual([[{ id: 'c1', name: 'Vino' }], [{ id: 'c1', name: 'Vino' }]]);
  });

  it('asks for the chips of an anonymous visitor as anonymous (who has no collections)', async () => {
    vi.mocked(entriesIndexFor).mockResolvedValue({ status: 200, body: { entries: [MOCK_SUMMARY], total: 1, limit: 200, offset: 0 } });
    await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary' });
    expect(vi.mocked(withCollectionChips).mock.calls[0][1]).toBe('anonymous');
  });

  it('never lets the collections break the list: when they fail the rows come back with no chips, and it is logged', async () => {
    vi.mocked(entriesIndexFor).mockResolvedValue({ status: 200, body: { entries: [MOCK_SUMMARY], total: 1, limit: 200, offset: 0 } });
    vi.mocked(withCollectionChips).mockRejectedValue(new Error('collections down'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [{ ...MOCK_SUMMARY, collections: [] }], total: 1, limit: 200, offset: 0 });
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('the pages are never cached, whatever the answer: a page, a request that is wrong and a failure all say no-store', async () => {
    vi.mocked(entriesIndexFor).mockResolvedValueOnce({ status: 200, body: { entries: [MOCK_SUMMARY], total: 1, limit: 200, offset: 0 } });
    expect((await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary' })).headers['cache-control']).toBe('no-store');
    vi.mocked(entriesIndexFor).mockResolvedValueOnce({ status: 400, body: { error: 'invalid_query:limit' } });
    expect((await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary&limit=x' })).headers['cache-control']).toBe('no-store');
    vi.mocked(entriesIndexFor).mockRejectedValueOnce(new Error('db down'));
    expect((await buildApp().inject({ method: 'GET', url: '/api/entries?view=summary' })).headers['cache-control']).toBe('no-store');
  });

  it('the full list says nothing about caching, as it always did', async () => {
    vi.mocked(listEntries).mockResolvedValue([MOCK_ENTRY as never]);
    expect((await buildApp().inject({ method: 'GET', url: '/api/entries' })).headers['cache-control']).toBeUndefined();
  });

  it('does not ask for chips on the full list (only the summary rows carry them)', async () => {
    vi.mocked(listEntries).mockResolvedValue([MOCK_ENTRY as never]);
    await buildApp().inject({ method: 'GET', url: '/api/entries' });
    expect(withCollectionChips).not.toHaveBeenCalled();
  });

  it('the full list has no filters and no page: it answers as it always did, and the page of the summary is not asked', async () => {
    vi.mocked(listEntries).mockResolvedValue([MOCK_ENTRY as never]);
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries?limit=5000&platform=tiktok&tag=%23vino&offset=40' });
    expect(res.statusCode).toBe(200);
    expect(listEntries).toHaveBeenCalledWith(1000, VIS_ANON);
    expect(entriesIndexFor).not.toHaveBeenCalled();
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('a view that is not «summary» is the full list', async () => {
    vi.mocked(listEntries).mockResolvedValue([]);
    await buildApp().inject({ method: 'GET', url: '/api/entries?view=full&limit=7' });
    expect(listEntries).toHaveBeenCalledWith(7, VIS_ANON);
    expect(entriesIndexFor).not.toHaveBeenCalled();
  });
});

describe('GET /api/entries/:id', () => {
  const ENTRY_FULL = { ...MOCK_ENTRY, sourcePlatform: 'instagram', createdAt: '2026-07-01T00:00:00.000Z' };
  const VENUE = {
    key: 'bar luce|milano', name: 'Bar Luce', kind: 'bar', place: 'Milano', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Bar%20Luce%2C%20Milano',
    posts: [{ entryId: 'entry-1', sourceUrl: 'https://github.com/foo/bar', sourcePlatform: 'instagram', createdAt: '2026-07-01T00:00:00.000Z' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEntryForUser).mockResolvedValue(ENTRY_FULL as never);
    vi.mocked(placesAndVenuesOfEntry).mockResolvedValue({ places: [{ name: 'Milano', kind: 'city' }], venues: [VENUE] });
  });

  it('answers the post in full with the places the server found in its text and the venues it names, with the address of Maps', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries/entry-1', headers: { 'remote-user': 'mike' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('entry-1');
    expect(body.places).toEqual([{ name: 'Milano', kind: 'city' }]);
    expect(body.venues).toEqual([VENUE]);
    expect(body.venues[0].mapsUrl).toContain('https://www.google.com/maps/search/?api=1&query=');
  });

  it('asks for them for THIS post, with where it lives and when it was saved (the venue says which post cites it)', async () => {
    await buildApp().inject({ method: 'GET', url: '/api/entries/entry-1', headers: { 'remote-user': 'mike' } });
    expect(placesAndVenuesOfEntry).toHaveBeenCalledWith({ id: 'entry-1', sourceUrl: 'https://github.com/foo/bar', sourcePlatform: 'instagram', createdAt: '2026-07-01T00:00:00.000Z' });
  });

  it('answers the post as it always was when the places cannot be read: no `places`, no `venues`, still a 200', async () => {
    vi.mocked(placesAndVenuesOfEntry).mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries/entry-1', headers: { 'remote-user': 'mike' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('places');
    expect(res.json()).not.toHaveProperty('venues');
    expect(res.json().id).toBe('entry-1');
  });

  it('a post with no place and no venue has two empty lists (the site shows no section)', async () => {
    vi.mocked(placesAndVenuesOfEntry).mockResolvedValue({ places: [], venues: [] });
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries/entry-1' });
    expect(res.json()).toMatchObject({ places: [], venues: [] });
  });

  it('never lets the places break the post: a failure that escapes is logged and the post is answered without them', async () => {
    vi.mocked(placesAndVenuesOfEntry).mockRejectedValue(new Error('places down'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries/entry-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('places');
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('a post the user cannot read is a 404 and nothing about its places is asked', async () => {
    vi.mocked(getEntryForUser).mockResolvedValue(null);
    const res = await buildApp().inject({ method: 'GET', url: '/api/entries/other' });
    expect(res.statusCode).toBe(404);
    expect(placesAndVenuesOfEntry).not.toHaveBeenCalled();
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
