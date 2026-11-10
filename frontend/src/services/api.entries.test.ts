import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEntryFacets, listEntrySummaries } from './api';
import type { EntryFacets } from '../types';

// The list of posts, a page at a time, and the filters of the Inbox (docs/entries-index.md): the server filters and counts, the site asks and draws.

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const PAGE = { entries: [], total: 0, limit: 40, offset: 0 };
const queryOf = (url: string): URLSearchParams => new URLSearchParams(url.split('?')[1]);

describe('listEntrySummaries', () => {
  it('asks the summary view, a page at a time, and gives back the page', async () => {
    const f = stubFetch(200, { ...PAGE, total: 1700 });
    await expect(listEntrySummaries(40, 80)).resolves.toMatchObject({ total: 1700 });
    expect(f.mock.calls[0][0].split('?')[0]).toBe('/api/entries');
    const q = queryOf(f.mock.calls[0][0]);
    expect(q.get('view')).toBe('summary');
    expect(q.get('limit')).toBe('40');
    expect(q.get('offset')).toBe('80');
  });

  it('without a filter it sends no filter at all (the page the Link page asks for has not changed)', async () => {
    const f = stubFetch(200, PAGE);
    await listEntrySummaries(40, 0);
    expect([...queryOf(f.mock.calls[0][0]).keys()].sort()).toEqual(['limit', 'offset', 'view']);
  });

  it('the filters go to the server with their own names; an empty one is left out', async () => {
    const f = stubFetch(200, PAGE);
    await listEntrySummaries(40, 0, { platform: 'instagram', channel: 'telegram', user: 'sara', category: 'claim', verdict: 'false', tag: '#vino' });
    const q = queryOf(f.mock.calls[0][0]);
    expect(Object.fromEntries(q.entries())).toEqual({
      view: 'summary', limit: '40', offset: '0', platform: 'instagram', channel: 'telegram', user: 'sara', category: 'claim', verdict: 'false', tag: '#vino',
    });
    await listEntrySummaries(40, 0, { platform: '', channel: null, user: '   ', tag: undefined });
    expect([...queryOf(f.mock.calls[1][0]).keys()].sort()).toEqual(['limit', 'offset', 'view']);
  });

  it('a value is trimmed before it is sent', async () => {
    const f = stubFetch(200, PAGE);
    await listEntrySummaries(40, 0, { platform: '  tiktok ', tag: '\t#vino\n' });
    const q = queryOf(f.mock.calls[0][0]);
    expect(q.get('platform')).toBe('tiktok');
    expect(q.get('tag')).toBe('#vino');
  });

  it('a value is encoded (a tag has a # in it)', async () => {
    const f = stubFetch(200, PAGE);
    await listEntrySummaries(40, 0, { tag: '#vini italiani & co' });
    expect(f.mock.calls[0][0]).toContain('tag=%23vini+italiani+%26+co');
  });

  it('a server that fails is an error', async () => {
    stubFetch(500, { error: 'entries_failed' });
    await expect(listEntrySummaries(40, 0)).rejects.toThrow();
  });
});

describe('fetchEntryFacets', () => {
  const FACETS: EntryFacets = {
    platforms: [{ platform: 'instagram', count: 900 }], channels: [{ channel: 'telegram', count: 1500 }], users: [{ user: 'mike', count: 1600 }],
    categories: [{ category: 'tech', count: 12 }], verdicts: [{ verdict: 'true', count: 5 }], tags: [{ tag: '#vino', count: 15 }],
  };

  it('asks /api/entries/facets and gives back the facets', async () => {
    const f = stubFetch(200, FACETS);
    await expect(fetchEntryFacets()).resolves.toEqual(FACETS);
    expect(f.mock.calls[0][0]).toBe('/api/entries/facets');
  });

  it('a server that fails is an error', async () => {
    stubFetch(500, { error: 'entries_failed' });
    await expect(fetchEntryFacets()).rejects.toThrow();
  });
});
