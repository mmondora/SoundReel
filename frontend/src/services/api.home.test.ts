import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWebHome } from './api';

// `GET /api/home` (docs/web-home.md): the sections of the Home view, ready from the server (rule P: the browser draws, it does not compute).

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchWebHome', () => {
  it('asks /api/home, never from the cache (a new post must show on the next visit), and gives back the sections', async () => {
    const sections = [{ id: 'songs', total: 1, items: [{ songKey: 'a::b', title: 'B', artist: 'A', coverUrl: null, entryId: 'e1', sourceUrl: null, createdAt: '2026-11-10T10:00:00.000Z' }] }];
    const f = stubFetch(200, { sections });
    await expect(fetchWebHome()).resolves.toEqual({ sections });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('/api/home');
    expect(f.mock.calls[0][1]?.cache).toBe('no-store');
  });

  it('an empty library is no sections', async () => {
    stubFetch(200, { sections: [] });
    await expect(fetchWebHome()).resolves.toEqual({ sections: [] });
  });

  it('a Home that cannot be built is an error', async () => {
    stubFetch(500, { error: 'home failed' });
    await expect(fetchWebHome()).rejects.toThrow(/home failed/);
  });
});
