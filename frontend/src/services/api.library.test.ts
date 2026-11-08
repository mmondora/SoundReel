import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browseMusicFolders,
  getMusicFolders,
  rescanMusicFolders,
  saveMusicFolders,
  searchLibrary,
} from './api';
import { parseApiError } from '../utils/apiError';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const urlOf = (f: ReturnType<typeof stubFetch>) => new URL(String(f.mock.calls[0][0]), 'http://x');

describe('searchLibrary', () => {
  it('sends the text, the scope and the limit as query parameters (the text URL-encoded)', async () => {
    const f = stubFetch(200, { q: 'maestro bassi', scope: 'all', counts: { songs: 0, media: 0, local: 0 }, results: [] });
    await searchLibrary('Maestro & Bassi è', 'media', 50);
    const url = urlOf(f);
    expect(url.pathname).toBe('/api/library/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'Maestro & Bassi è', scope: 'media', limit: '50' });
  });

  it('defaults to every scope with the server’s cap of 100', async () => {
    const f = stubFetch(200, {});
    await searchLibrary('bassi');
    expect(Object.fromEntries(urlOf(f).searchParams)).toEqual({ q: 'bassi', scope: 'all', limit: '100' });
  });

  it('passes the abort signal on to fetch', async () => {
    const f = stubFetch(200, {});
    const controller = new AbortController();
    await searchLibrary('bassi', 'all', 100, controller.signal);
    expect(f.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('returns what the server sent', async () => {
    stubFetch(200, { q: 'x', scope: 'all', counts: { songs: 1, media: 2, local: 3 }, results: [{ scope: 'local', artist: 'A', title: 'T' }] });
    const res = await searchLibrary('xx');
    expect(res.counts).toEqual({ songs: 1, media: 2, local: 3 });
    expect(res.results).toHaveLength(1);
  });

  it('keeps the server’s error code readable for the page (400 query_too_short, invalid_scope)', async () => {
    stubFetch(400, { error: 'query_too_short' });
    const err = await searchLibrary('a').catch((e: unknown) => e);
    expect(parseApiError(err).code).toBe('query_too_short');
    stubFetch(400, { error: 'invalid_scope' });
    expect(parseApiError(await searchLibrary('ab', 'all').catch((e: unknown) => e)).code).toBe('invalid_scope');
  });
});

describe('music folders', () => {
  it('reads the list with GET', async () => {
    const f = stubFetch(200, { roots: [], folders: [] });
    await getMusicFolders();
    expect(urlOf(f).pathname).toBe('/api/config/music-folders');
    expect(f.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('replaces the list with POST of the WHOLE list under "folders"', async () => {
    const f = stubFetch(200, { roots: [], folders: [] });
    await saveMusicFolders([{ path: '/music-extra/a', label: 'A', enabled: false }, { path: '/music-extra/b' }]);
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      folders: [{ path: '/music-extra/a', label: 'A', enabled: false }, { path: '/music-extra/b' }],
    });
  });

  it('an empty list is a valid replacement (remove everything)', async () => {
    const f = stubFetch(200, { roots: [], folders: [] });
    await saveMusicFolders([]);
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({ folders: [] });
  });

  it('keeps the folder error and its index readable', async () => {
    stubFetch(400, { error: 'folder_outside_roots', index: 1 });
    const err = await saveMusicFolders([{ path: '/a' }, { path: '/etc' }]).catch((e: unknown) => e);
    expect(parseApiError(err)).toMatchObject({ code: 'folder_outside_roots', index: 1 });
  });

  it('a non-admin gets 403 and it is recognisable', async () => {
    stubFetch(403, { error: 'forbidden' });
    expect(parseApiError(await getMusicFolders().catch((e: unknown) => e)).code).toBe('forbidden');
  });

  it('browse: no path lists the allowed roots; a path is sent URL-encoded', async () => {
    const f = stubFetch(200, { path: null, parent: null, dirs: [] });
    await browseMusicFolders();
    expect(urlOf(f).pathname).toBe('/api/config/music-folders/browse');
    expect(urlOf(f).search).toBe('');
    const g = stubFetch(200, { path: '/music-extra/Rock & Roll', parent: '/music-extra', dirs: [] });
    await browseMusicFolders('/music-extra/Rock & Roll');
    expect(urlOf(g).searchParams.get('path')).toBe('/music-extra/Rock & Roll');
    await browseMusicFolders(null);
  });

  it('browse errors keep their code (folder_outside_roots, folder_missing)', async () => {
    stubFetch(400, { error: 'folder_missing' });
    expect(parseApiError(await browseMusicFolders('/nope').catch((e: unknown) => e)).code).toBe('folder_missing');
  });

  it('rescan is a POST and 202 is fine', async () => {
    const f = stubFetch(202, { ok: true });
    await expect(rescanMusicFolders()).resolves.toBeUndefined();
    expect(urlOf(f).pathname).toBe('/api/config/music-folders/rescan');
    expect((f.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('rescan failing throws with the reason', async () => {
    stubFetch(403, { error: 'forbidden' });
    expect(parseApiError(await rescanMusicFolders().catch((e: unknown) => e)).code).toBe('forbidden');
  });
});
