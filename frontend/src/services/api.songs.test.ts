import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSongs } from './api';

// `GET /api/songs`: the journal's songs by default; `?scope=everything` (the playlist manager) adds the songs that exist only as
// files, so that searching for a song to put in a playlist takes from everything (spec 2026-11-08-playlist-search-everything-design.md).

afterEach(() => vi.unstubAllGlobals());

function stubFetch(songs: unknown[] = []) {
  const fetchMock = vi.fn(async (_input: string) => new Response(JSON.stringify({ songs }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchSongs', () => {
  it('asks for the journal by default: the Songs page and the player stay as they were', async () => {
    const f = stubFetch([{ songKey: 'a::b' }]);
    expect(await fetchSongs()).toEqual([{ songKey: 'a::b' }]);
    expect(String(f.mock.calls[0][0])).toMatch(/\/api\/songs$/);
    await fetchSongs('journal');
    expect(String(f.mock.calls[1][0])).toMatch(/\/api\/songs$/);
  });

  it('asks for EVERYTHING when told to: the same list plus the songs that are only files', async () => {
    const f = stubFetch([{ songKey: 'bassi maestro::capirai', libraryOnly: true }]);
    const songs = await fetchSongs('everything');
    expect(songs[0].libraryOnly).toBe(true);
    const url = new URL(String(f.mock.calls[0][0]), 'http://x');
    expect(url.pathname).toBe('/api/songs');
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'everything' });
  });
});
