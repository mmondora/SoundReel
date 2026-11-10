import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real sources of the front page of the site, with the stores mocked: what is tested here is the WIRING (who is asked for what), the
// rules are in webHome.test.ts. Nothing here touches a database, the network or the file system.
vi.mock('../utils/db', () => ({ listEntries: vi.fn(), listEntrySummaries: vi.fn() }));
vi.mock('./songMeta', () => ({ listSongMeta: vi.fn() }));
vi.mock('./filmMeta', () => ({ listFilmMeta: vi.fn() }));
vi.mock('./playlists', () => ({ listPlaylists: vi.fn() }));
vi.mock('./playlistResolver', () => ({ resolveSummaries: vi.fn() }));
// a limit that is NOT the one a careless copy would write, so «which limit was used» can be told
vi.mock('../routes/songs', () => ({ aggregateSongs: vi.fn(), LIST_ENTRIES_LIMIT: 12345 }));
vi.mock('../routes/films', () => ({ aggregateFilms: vi.fn() }));

import { realWebHomeDeps } from './webHomeData';
import { listEntries, listEntrySummaries } from '../utils/db';
import { listSongMeta } from './songMeta';
import { listFilmMeta } from './filmMeta';
import { listPlaylists } from './playlists';
import { resolveSummaries } from './playlistResolver';
import { aggregateSongs } from '../routes/songs';
import { aggregateFilms } from '../routes/films';
import type { AggregatedFilm, AggregatedSong, Entry, PlaylistSummary } from '../types';

const mike = { userId: 'mike', isAdmin: false };
const entries = [{ id: 'e1' }, { id: 'e2' }] as unknown as Entry[];
const songMeta = new Map([['a::one', { coverUrl: 'https://img.example/a.jpg' }]]) as unknown as Awaited<ReturnType<typeof listSongMeta>>;
const filmMeta = new Map([['dune::2021', { tmdbId: 1 }]]) as unknown as Awaited<ReturnType<typeof listFilmMeta>>;
const aSong = { songKey: 'a::one', title: 'One' } as unknown as AggregatedSong;
const aFilm = { filmKey: 'dune::2021', title: 'Dune' } as unknown as AggregatedFilm;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listEntries).mockResolvedValue(entries);
  vi.mocked(listEntrySummaries).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(listSongMeta).mockResolvedValue(songMeta);
  vi.mocked(listFilmMeta).mockResolvedValue(filmMeta);
  vi.mocked(aggregateSongs).mockReturnValue(new Map([[aSong.songKey, aSong]]));
  vi.mocked(aggregateFilms).mockReturnValue(new Map([[aFilm.filmKey, aFilm]]));
  vi.mocked(listPlaylists).mockResolvedValue([]);
  vi.mocked(resolveSummaries).mockImplementation(async (list) => list);
});

describe('the posts', () => {
  it('are the first rows of the list of entries, asked for the viewer with the same visibility as that list', async () => {
    const answer = { items: [{ id: 'e1' }], total: 700 } as unknown as Awaited<ReturnType<typeof listEntrySummaries>>;
    vi.mocked(listEntrySummaries).mockResolvedValue(answer);
    expect(await realWebHomeDeps().posts({ userId: 'sara', isAdmin: false }, 6)).toBe(answer);
    expect(listEntrySummaries).toHaveBeenCalledWith(6, 0, { userId: 'sara', isAdmin: false });
  });

  it('are asked for an admin as an admin (the anonymous posts are theirs to see, like in the list of entries)', async () => {
    await realWebHomeDeps().posts({ userId: 'mike', isAdmin: true }, 6);
    expect(listEntrySummaries).toHaveBeenCalledWith(6, 0, { userId: 'mike', isAdmin: true });
  });
});

describe('the songs and the films', () => {
  it('the songs are the journal of the viewer aggregated with the song metadata', async () => {
    const songs = await realWebHomeDeps().songs(mike);
    expect(listEntries).toHaveBeenCalledWith(12345, { userId: 'mike', isAdmin: false });
    expect(aggregateSongs).toHaveBeenCalledWith(entries, songMeta);
    expect(songs).toEqual([aSong]);
  });

  it('the films are the journal of the viewer aggregated with the film metadata (the collapse is a rule of the Home, not of the source)', async () => {
    const films = await realWebHomeDeps().films(mike);
    expect(listEntries).toHaveBeenCalledWith(12345, { userId: 'mike', isAdmin: false });
    expect(aggregateFilms).toHaveBeenCalledWith(entries, filmMeta);
    expect(films).toEqual([aFilm]);
  });

  it('read the journal ONCE when they are both asked in the same request: the cold read is the costly part', async () => {
    const deps = realWebHomeDeps();
    await Promise.all([deps.songs(mike), deps.films(mike)]);
    expect(listEntries).toHaveBeenCalledTimes(1);
  });

  it('a new request reads it again: nothing is kept from one request to the next, so nothing of one user reaches another', async () => {
    await realWebHomeDeps().songs(mike);
    await realWebHomeDeps().songs({ userId: 'sara', isAdmin: false });
    expect(listEntries).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listEntries).mock.calls.map((c) => c[1])).toEqual([{ userId: 'mike', isAdmin: false }, { userId: 'sara', isAdmin: false }]);
  });

  it('even on the SAME sources a second viewer never gets the journal read for the first', async () => {
    const deps = realWebHomeDeps();
    await deps.songs(mike);
    await deps.films({ userId: 'mike', isAdmin: true });
    await deps.songs({ userId: 'sara', isAdmin: false });
    expect(vi.mocked(listEntries).mock.calls.map((c) => c[1])).toEqual([
      { userId: 'mike', isAdmin: false }, { userId: 'mike', isAdmin: true }, { userId: 'sara', isAdmin: false },
    ]);
  });

  it('a journal that cannot be read fails both, each on its own (the Home leaves both sections out and keeps the rest)', async () => {
    vi.mocked(listEntries).mockRejectedValue(new Error('db down'));
    const deps = realWebHomeDeps();
    await expect(deps.songs(mike)).rejects.toThrow('db down');
    await expect(deps.films(mike)).rejects.toThrow('db down');
  });
});

describe('the playlists', () => {
  it('are the ones the viewer reads, listed with the same visibility as GET /api/playlists', async () => {
    const stored = [{ id: 'p1' }] as unknown as PlaylistSummary[];
    vi.mocked(listPlaylists).mockResolvedValue(stored);
    expect(await realWebHomeDeps().playlists({ userId: 'archi', isAdmin: true })).toBe(stored);
    expect(listPlaylists).toHaveBeenCalledWith({ userId: 'archi', isAdmin: true });
  });

  it('have the songs of a rule counted for the viewer, and only for the lists it is given', async () => {
    const shown = [{ id: 'p1', kind: 'dynamic' }] as unknown as PlaylistSummary[];
    const counted = [{ id: 'p1', kind: 'dynamic', songCount: 58 }] as unknown as PlaylistSummary[];
    vi.mocked(resolveSummaries).mockResolvedValue(counted);
    expect(await realWebHomeDeps().resolvePlaylists(shown, { userId: 'sara', isAdmin: false })).toBe(counted);
    expect(resolveSummaries).toHaveBeenCalledWith(shown, { userId: 'sara', isAdmin: false });
  });
});
