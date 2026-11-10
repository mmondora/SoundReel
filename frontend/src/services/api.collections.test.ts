import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addEntryToCollection, fetchCollection, fetchCollections, hideCollection, mergeCollection, removeEntryFromCollection, renameCollection, unhideCollection,
} from './api';
import type { CollectionListItem, CollectionPage } from '../types';

// The collections of the library (docs/collections.md): the server decides which ones there are, their names, their order and the address of Maps;
// the site asks and draws. The id of a type has a colon in it (`type:music`): it travels encoded.

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ITEM: CollectionListItem = { id: 'abc', name: 'Vino', kind: 'theme', group: 'Cibo e bevande', parentId: null, count: 15, isNew: true, thumbs: [], views: ['grid', 'list'], defaultView: 'grid' };
const PAGE: CollectionPage = { collection: ITEM, why: { words: ['vino'], entryIds: [] }, facets: { places: [], sources: [], months: [] }, entries: [], venues: [], total: 0 };

describe('fetchCollections', () => {
  it('asks /api/collections, never from the cache, and gives back the list', async () => {
    const f = stubFetch(200, { collections: [ITEM] });
    await expect(fetchCollections()).resolves.toEqual([ITEM]);
    expect(f.mock.calls[0][0]).toBe('/api/collections');
    expect(f.mock.calls[0][1]?.cache).toBe('no-store');
  });

  it('the hidden ones and the ones in observation are asked with `state`', async () => {
    const f = stubFetch(200, { collections: [] });
    await fetchCollections('hidden');
    await fetchCollections('watching');
    expect(f.mock.calls[0][0]).toBe('/api/collections?state=hidden');
    expect(f.mock.calls[1][0]).toBe('/api/collections?state=watching');
  });

  it('a server that fails is an error', async () => {
    stubFetch(500, { error: 'collections_failed' });
    await expect(fetchCollections()).rejects.toThrow(/collections_failed/);
  });
});

describe('fetchCollection', () => {
  it('encodes the id (the one of a type has a colon) and sends only the parameters that have a value', async () => {
    const f = stubFetch(200, PAGE);
    await fetchCollection('type:music', { dove: 'Milano', fonte: undefined, q: '', offset: 0, limit: 40 });
    const [path] = f.mock.calls[0];
    const u = new URL(String(path), 'http://x');
    expect(u.pathname).toBe('/api/collections/type%3Amusic');
    expect(Object.fromEntries(u.searchParams)).toEqual({ dove: 'Milano', offset: '0', limit: '40' });
  });

  it('without a query it is the bare address, and the answer is given back whole', async () => {
    const f = stubFetch(200, PAGE);
    await expect(fetchCollection('abc')).resolves.toEqual(PAGE);
    expect(f.mock.calls[0][0]).toBe('/api/collections/abc');
    expect(f.mock.calls[0][1]?.cache).toBe('no-store');
  });

  it('sends `quando` and `fonte` too', async () => {
    const f = stubFetch(200, PAGE);
    await fetchCollection('abc', { fonte: 'instagram', quando: '2026-10' });
    const u = new URL(String(f.mock.calls[0][0]), 'http://x');
    expect(Object.fromEntries(u.searchParams)).toEqual({ fonte: 'instagram', quando: '2026-10' });
  });

  it('a collection that is gone is an error the page can read (404)', async () => {
    stubFetch(404, { error: 'collection_not_found' });
    await expect(fetchCollection('gone')).rejects.toThrow(/collection_not_found/);
  });
});

describe('the corrections', () => {
  it('rename sends the new name and gives back the collection', async () => {
    const f = stubFetch(200, { collection: { ...ITEM, name: 'Vini' } });
    await expect(renameCollection('abc', 'Vini')).resolves.toMatchObject({ name: 'Vini' });
    const [path, init] = f.mock.calls[0];
    expect(path).toBe('/api/collections/abc/rename');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Vini' });
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('merge sends the target', async () => {
    const f = stubFetch(200, { collection: ITEM });
    await mergeCollection('abc', 'def');
    expect(f.mock.calls[0][0]).toBe('/api/collections/abc/merge');
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ targetId: 'def' });
  });

  it('hide and unhide are POSTs with no body', async () => {
    const f = stubFetch(200, { ok: true });
    await hideCollection('abc');
    await unhideCollection('abc');
    expect(f.mock.calls[0][0]).toBe('/api/collections/abc/hide');
    expect(f.mock.calls[1][0]).toBe('/api/collections/abc/unhide');
    expect(f.mock.calls[0][1]?.method).toBe('POST');
    expect(f.mock.calls[1][1]?.method).toBe('POST');
  });

  it('«add to» is a POST and «not this one» a DELETE, on the collection and the post (both encoded)', async () => {
    const f = stubFetch(200, { ok: true });
    await addEntryToCollection('a b', 'e/1');
    await removeEntryFromCollection('a b', 'e/1');
    expect(f.mock.calls[0][0]).toBe('/api/collections/a%20b/entries/e%2F1');
    expect(f.mock.calls[0][1]?.method).toBe('POST');
    expect(f.mock.calls[1][0]).toBe('/api/collections/a%20b/entries/e%2F1');
    expect(f.mock.calls[1][1]?.method).toBe('DELETE');
  });

  it('a refusal (400, 404) is an error with the server\'s reason', async () => {
    stubFetch(400, { error: 'not_editable' });
    await expect(hideCollection('type:music')).rejects.toThrow(/not_editable/);
    stubFetch(404, { error: 'entry_not_found' });
    await expect(removeEntryFromCollection('abc', 'x')).rejects.toThrow(/entry_not_found/);
  });
});
