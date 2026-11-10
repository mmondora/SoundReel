import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import { buildWebHome, WEB_HOME_LIMITS, type WebHomeDeps, type WebHomeViewer } from './webHome';
import { logWarning } from '../utils/logger';
import type { AggregatedFilm, AggregatedSong, EntrySummaryRow, PlaylistSummary } from '../types';

const viewer: WebHomeViewer = { userId: 'mike', isAdmin: false };

const keyOf = (artist: string, title: string) => `${artist.toLowerCase()}::${title.toLowerCase()}`;

function post(id: string, createdAt: string, extra: Partial<EntrySummaryRow> = {}): EntrySummaryRow {
  return {
    id, sourceUrl: `https://www.instagram.com/reel/${id}/`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: null,
    status: 'completed', createdAt, summary: null, songCount: 0, filmCount: 0, noteCount: 0, tags: [], ...extra,
  };
}

type Mention = [entryId: string, createdAt: string, sourceUrl?: string | null];

function song(artist: string, title: string, mentions: Mention[], extra: Partial<AggregatedSong> = {}): AggregatedSong {
  return {
    songKey: keyOf(artist, title), title, artist, album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: mentions.map(([entryId, createdAt, sourceUrl]) => ({ entryId, createdAt, sourceUrl: sourceUrl ?? null, sourcePlatform: 'instagram' })),
    meta: null, inLibrary: false, ...extra,
  };
}

function film(title: string, year: string | number | null, mentions: Mention[], extra: Partial<AggregatedFilm> = {}): AggregatedFilm {
  return {
    filmKey: `${title.toLowerCase()}::${year ?? ''}`, title, director: null, year: year as string | null, imdbUrl: null, posterUrl: null,
    streamingUrls: null,
    mentions: mentions.map(([entryId, createdAt, sourceUrl]) => ({ entryId, createdAt, sourceUrl: sourceUrl ?? null, sourcePlatform: 'instagram' })),
    meta: null, ...extra,
  };
}

type Stored = PlaylistSummary & { ownerUser?: string };
function playlist(id: string, name: string, createdAt: string, extra: Partial<Stored> = {}): Stored {
  return { id, name, songCount: 3, createdAt, updatedAt: createdAt, kind: 'static', ownerUser: 'mike', ...extra };
}

function deps(over: Partial<WebHomeDeps> = {}): WebHomeDeps {
  return {
    posts: vi.fn(async () => ({ items: [], total: 0 })),
    songs: vi.fn(async () => []),
    films: vi.fn(async () => []),
    playlists: vi.fn(async () => []),
    resolvePlaylists: vi.fn(async (list: Stored[]) => list),
    ...over,
  };
}

const idsOf = (home: Awaited<ReturnType<typeof buildWebHome>>) => home.sections.map((s) => s.id);
const sectionOf = <T extends 'resume' | 'songs' | 'playlists' | 'films'>(home: Awaited<ReturnType<typeof buildWebHome>>, id: T) => {
  const found = home.sections.find((s) => s.id === id);
  if (!found) throw new Error(`no section ${id}`);
  return found as Extract<(typeof home.sections)[number], { id: T }>;
};

/** `n` songs, each mentioned once, the i-th on day i (so the higher the number, the newer). */
const manySongs = (n: number): AggregatedSong[] =>
  Array.from({ length: n }, (_, i) => song('Artist', `Song ${String(i + 1).padStart(2, '0')}`, [[`e${i + 1}`, `2026-03-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`]]));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildWebHome: the sections and their order (spec 2026-11-10-web-look-and-feel-rethink-design.md §3.2 L1, plan Task 8)', () => {
  it('answers the latest posts, the new songs, the playlists and the films, in that order, each with its total and its items', async () => {
    const home = await buildWebHome(viewer, deps({
      posts: async () => ({ items: [post('e1', '2026-03-01T10:00:00.000Z')], total: 1 }),
      songs: async () => [song('A', 'One', [['e1', '2026-03-01T10:00:00.000Z']])],
      playlists: async () => [playlist('p1', 'Road trip', '2026-01-01T00:00:00.000Z')],
      films: async () => [film('Dune', '2021', [['e2', '2026-03-02T10:00:00.000Z']])],
    }));
    expect(idsOf(home)).toEqual(['resume', 'songs', 'playlists', 'films']);
    expect(home.sections.map((s) => [s.total, s.items.length])).toEqual([[1, 1], [1, 1], [1, 1], [1, 1]]);
  });

  it('keeps that order whichever source answers first', async () => {
    const slow = <T>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    const home = await buildWebHome(viewer, deps({
      posts: () => slow({ items: [post('e1', '2026-03-01T10:00:00.000Z')], total: 1 }, 30),
      songs: () => slow([song('A', 'One', [['e1', '2026-03-01T10:00:00.000Z']])], 20),
      playlists: () => slow([playlist('p1', 'Road trip', '2026-01-01T00:00:00.000Z')], 10),
      films: () => slow([film('Dune', '2021', [['e2', '2026-03-02T10:00:00.000Z']])], 0),
    }));
    expect(idsOf(home)).toEqual(['resume', 'songs', 'playlists', 'films']);
  });

  it('an empty library answers no section at all', async () => {
    expect(await buildWebHome(viewer, deps())).toEqual({ sections: [] });
  });

  it('a section with nothing in it is left out, the others stay', async () => {
    const home = await buildWebHome(viewer, deps({
      songs: async () => [song('A', 'One', [['e1', '2026-03-01T10:00:00.000Z']])],
      films: async () => [film('Dune', '2021', [['e2', '2026-03-02T10:00:00.000Z']])],
    }));
    expect(idsOf(home)).toEqual(['songs', 'films']);
  });

  it('never names the collections: they are not built yet (ADR-0022), so the section is simply absent', async () => {
    const home = await buildWebHome(viewer, deps({
      posts: async () => ({ items: [post('e1', '2026-03-01T10:00:00.000Z')], total: 1 }),
      songs: async () => manySongs(3),
      playlists: async () => [playlist('p1', 'Road trip', '2026-01-01T00:00:00.000Z')],
      films: async () => [film('Dune', '2021', [['e2', '2026-03-02T10:00:00.000Z']])],
    }));
    expect(idsOf(home)).not.toContain('collections');
  });

  it('carries only what the contract names: the sections and nothing else (no user, no title, no store)', async () => {
    const home = await buildWebHome(viewer, deps({ songs: async () => manySongs(1) }));
    expect(Object.keys(home)).toEqual(['sections']);
    expect(Object.keys(home.sections[0]).sort()).toEqual(['id', 'items', 'total']);
  });

  it('the limits are six posts and twelve songs, playlists and films', () => {
    expect(WEB_HOME_LIMITS).toEqual({ resume: 6, songs: 12, playlists: 12, films: 12 });
  });
});

describe('the sources are asked for the viewer, whoever that is (own and shared, never another user)', () => {
  it('hands every source the viewer exactly as the route resolved them', async () => {
    const admin: WebHomeViewer = { userId: 'archi', isAdmin: true };
    const d = deps();
    await buildWebHome(admin, d);
    expect(d.posts).toHaveBeenCalledWith(admin, WEB_HOME_LIMITS.resume);
    expect(d.songs).toHaveBeenCalledWith(admin);
    expect(d.films).toHaveBeenCalledWith(admin);
    expect(d.playlists).toHaveBeenCalledWith(admin);
  });

  it('what one user sees is not what another sees: the answer follows the viewer given', async () => {
    const journals: Record<string, AggregatedSong[]> = {
      mike: [song('Mike', 'Mine', [['m1', '2026-03-01T10:00:00.000Z']])],
      sara: [song('Sara', 'Hers', [['s1', '2026-03-02T10:00:00.000Z']])],
    };
    const d = deps({ songs: async (v) => journals[v.userId] ?? [] });
    const titles = async (userId: string) => sectionOf(await buildWebHome({ userId, isAdmin: false }, d), 'songs').items.map((s) => s.title);
    expect(await titles('mike')).toEqual(['Mine']);
    expect(await titles('sara')).toEqual(['Hers']);
    expect((await buildWebHome({ userId: 'anonymous', isAdmin: false }, d)).sections).toEqual([]);
  });
});

describe('resume: the latest posts', () => {
  it('passes the rows through exactly as the list of entries gives them, so the site draws them with the card it already has', async () => {
    const rows = [post('e2', '2026-03-02T10:00:00.000Z', { songCount: 4, tags: ['jazz'], summary: 'Quattro dischi' }), post('e1', '2026-03-01T10:00:00.000Z', { status: 'processing' })];
    const home = await buildWebHome(viewer, deps({ posts: async () => ({ items: rows, total: 2 }) }));
    const resume = sectionOf(home, 'resume');
    expect(resume.items).toEqual(rows);
    expect(resume.items[0]).toBe(rows[0]);
  });

  it('asks for six and shows six, even when the source gives more', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => post(`e${i}`, `2026-03-0${9 - i}T10:00:00.000Z`));
    const d = deps({ posts: vi.fn(async () => ({ items: rows, total: 9 })) });
    const resume = sectionOf(await buildWebHome(viewer, d), 'resume');
    expect(d.posts).toHaveBeenCalledWith(viewer, 6);
    expect(resume.items.map((r) => r.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('the total is how many posts there are in all, not how many are shown', async () => {
    const rows = [post('e1', '2026-03-01T10:00:00.000Z')];
    const resume = sectionOf(await buildWebHome(viewer, deps({ posts: async () => ({ items: rows, total: 712 }) })), 'resume');
    expect(resume.total).toBe(712);
    expect(resume.items).toHaveLength(1);
  });
});

describe('songs: the new songs of the posts', () => {
  it('puts the song of the newest post first, by the newest post that names each song', async () => {
    const old = song('Old', 'Name', [['e1', '2026-01-01T10:00:00.000Z']]);
    const mid = song('Mid', 'Name', [['e2', '2026-02-01T10:00:00.000Z']]);
    // mentioned long ago AND yesterday: it is a new song for the Home
    const again = song('Again', 'Name', [['e4', '2026-03-05T10:00:00.000Z'], ['e0', '2025-12-01T10:00:00.000Z']]);
    const items = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [old, mid, again] })), 'songs').items;
    expect(items.map((s) => s.title + '/' + s.artist)).toEqual(['Name/Again', 'Name/Mid', 'Name/Old']);
  });

  it('takes entryId, sourceUrl and createdAt from the NEWEST mention, wherever it sits in the list of mentions', async () => {
    const s = song('A', 'One', [
      ['e-old', '2026-01-01T10:00:00.000Z', 'https://www.instagram.com/reel/OLD/'],
      ['e-new', '2026-03-09T10:00:00.000Z', 'https://www.tiktok.com/@x/video/NEW'],
      ['e-mid', '2026-02-01T10:00:00.000Z', 'https://www.instagram.com/reel/MID/'],
    ]);
    const [item] = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [s] })), 'songs').items;
    expect(item).toEqual({
      songKey: 'a::one', title: 'One', artist: 'A', coverUrl: null,
      entryId: 'e-new', sourceUrl: 'https://www.tiktok.com/@x/video/NEW', createdAt: '2026-03-09T10:00:00.000Z',
    });
  });

  it('one card per songKey, even when the source lists a song twice', async () => {
    const a = song('A', 'One', [['e1', '2026-03-01T10:00:00.000Z']]);
    const home = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [a, { ...a }, song('B', 'Two', [['e2', '2026-02-01T10:00:00.000Z']])] })), 'songs');
    expect(home.items.map((s) => s.songKey)).toEqual(['a::one', 'b::two']);
    expect(home.total).toBe(2);
  });

  it('shows twelve and counts all of them in the total', async () => {
    const songs = sectionOf(await buildWebHome(viewer, deps({ songs: async () => manySongs(15) })), 'songs');
    expect(songs.items).toHaveLength(12);
    expect(songs.total).toBe(15);
    // the twelve newest: Song 15 down to Song 04
    expect(songs.items[0].title).toBe('Song 15');
    expect(songs.items[11].title).toBe('Song 04');
  });

  it('exactly twelve songs fill the section, a thirteenth only shows in the total', async () => {
    expect(sectionOf(await buildWebHome(viewer, deps({ songs: async () => manySongs(12) })), 'songs').items).toHaveLength(12);
    const thirteen = sectionOf(await buildWebHome(viewer, deps({ songs: async () => manySongs(13) })), 'songs');
    expect([thirteen.items.length, thirteen.total]).toEqual([12, 13]);
  });

  it('never carries a song that exists only as a file: this is the new songs of the POSTS', async () => {
    const fileOnly = song('Box', 'Only a file', [['e9', '2026-03-09T10:00:00.000Z']], { libraryOnly: true });
    const real = song('A', 'One', [['e1', '2026-03-01T10:00:00.000Z']]);
    const home = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [fileOnly, real] })), 'songs');
    expect(home.items.map((s) => s.title)).toEqual(['One']);
    expect(home.total).toBe(1);
  });

  it('a version of a song stays its own card, next to the original', async () => {
    const original = song('Artist', 'Night', [['e1', '2026-03-01T10:00:00.000Z']]);
    const slowed = song('Artist', 'Night (Slowed + Reverb)', [['e2', '2026-03-02T10:00:00.000Z']], {
      versionOf: { title: 'Night', artist: 'Artist', songKey: original.songKey, labels: ['Slowed + Reverb'] },
    });
    const items = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [original, slowed] })), 'songs').items;
    expect(items.map((s) => s.title)).toEqual(['Night (Slowed + Reverb)', 'Night']);
  });

  it('shows the cover the metadata knows, and null when it does not', async () => {
    const meta = { coverUrl: 'https://img.example/cover.jpg' } as unknown as AggregatedSong['meta'];
    const items = sectionOf(await buildWebHome(viewer, deps({
      songs: async () => [
        song('A', 'With', [['e2', '2026-03-02T10:00:00.000Z']], { meta }),
        song('B', 'Without', [['e1', '2026-03-01T10:00:00.000Z']], { meta: { coverUrl: null } as unknown as AggregatedSong['meta'] }),
        song('C', 'NoMeta', [['e0', '2026-02-01T10:00:00.000Z']]),
      ],
    })), 'songs').items;
    expect(items.map((s) => s.coverUrl)).toEqual(['https://img.example/cover.jpg', null, null]);
  });

  it('two songs of the same moment come out in the same order every time: by title, then by key', async () => {
    const at = '2026-03-01T10:00:00.000Z';
    const b = song('X', 'Bravo', [['e1', at]]);
    const a = song('X', 'Alpha', [['e1', at]]);
    const a2 = song('Y', 'Alpha', [['e1', at]]);
    const forward = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [b, a2, a] })), 'songs').items.map((s) => s.songKey);
    const backward = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [a, a2, b] })), 'songs').items.map((s) => s.songKey);
    expect(forward).toEqual(['x::alpha', 'y::alpha', 'x::bravo']);
    expect(backward).toEqual(forward);
  });

  it('a song whose posts have no readable date goes last, and one with no post at all is not a song of the posts', async () => {
    const undated = song('U', 'Undated', [['e5', 'not a date']]);
    const dated = song('D', 'Dated', [['e1', '2026-01-01T10:00:00.000Z']]);
    const orphan = song('O', 'Orphan', []);
    const home = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [undated, orphan, dated] })), 'songs');
    expect(home.items.map((s) => s.title)).toEqual(['Dated', 'Undated']);
    // with no readable date the first mention speaks for the song
    expect(home.items[1].entryId).toBe('e5');
    expect(home.total).toBe(2);
  });

  it('an unreadable date never hides a readable one on the same song', async () => {
    const mixed = song('M', 'Mixed', [['e-bad', 'garbage'], ['e-ok', '2026-02-01T10:00:00.000Z']]);
    const [item] = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [mixed] })), 'songs').items;
    expect([item.entryId, item.createdAt]).toEqual(['e-ok', '2026-02-01T10:00:00.000Z']);
  });

  it('with no readable date on any mention the FIRST mention speaks for the song', async () => {
    const s = song('U', 'Undated twice', [['e-first', 'garbage'], ['e-second', 'also garbage']]);
    const [item] = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [s] })), 'songs').items;
    expect([item.entryId, item.createdAt]).toEqual(['e-first', 'garbage']);
  });

  it('two songs of the same moment are ordered the way a person reads them: «Track 9» before «Track 10», and case does not matter', async () => {
    const at = '2026-03-01T10:00:00.000Z';
    const items = sectionOf(await buildWebHome(viewer, deps({
      songs: async () => [song('X', 'Track 10', [['e1', at]]), song('X', 'Track 9', [['e1', at]])],
    })), 'songs').items;
    expect(items.map((s) => s.title)).toEqual(['Track 9', 'Track 10']);
    // «a» and «A» are the same title for the order: the key then settles it (x::a before y::a), not the case
    const tie = sectionOf(await buildWebHome(viewer, deps({
      songs: async () => [song('Y', 'a', [['e1', at]]), song('X', 'A', [['e1', at]])],
    })), 'songs').items;
    expect(tie.map((s) => s.songKey)).toEqual(['x::a', 'y::a']);
  });

  it('keeps an empty artist as it is and an unknown post address as null', async () => {
    const s = song('', 'No artist', [['e1', '2026-03-01T10:00:00.000Z']]);
    s.mentions = [{ entryId: 'e1', createdAt: '2026-03-01T10:00:00.000Z' }];
    const [item] = sectionOf(await buildWebHome(viewer, deps({ songs: async () => [s] })), 'songs').items;
    expect([item.artist, item.sourceUrl]).toEqual(['', null]);
  });
});

describe('playlists: the playlists the viewer reads, newest created first', () => {
  it('lists them by creation date, newest first, and not by the last change', async () => {
    const list = [
      playlist('p-old-touched', 'Old but touched', '2026-01-01T00:00:00.000Z', { updatedAt: '2026-03-09T00:00:00.000Z' }),
      playlist('p-new', 'New', '2026-03-01T00:00:00.000Z', { updatedAt: '2026-03-01T00:00:00.000Z' }),
      playlist('p-mid', 'Mid', '2026-02-01T00:00:00.000Z'),
    ];
    const items = sectionOf(await buildWebHome(viewer, deps({ playlists: async () => list })), 'playlists').items;
    expect(items.map((p) => p.id)).toEqual(['p-new', 'p-mid', 'p-old-touched']);
  });

  it('shows twelve, and the total is every playlist the viewer can read', async () => {
    const list = Array.from({ length: 30 }, (_, i) => playlist(`p${i}`, `List ${i}`, `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
    const playlists = sectionOf(await buildWebHome(viewer, deps({ playlists: async () => list })), 'playlists');
    expect(playlists.items).toHaveLength(12);
    expect(playlists.total).toBe(30);
    expect(playlists.items[0].id).toBe('p29');
    expect(playlists.items[11].id).toBe('p18');
  });

  it('two lists created at the same moment come out by name', async () => {
    const at = '2026-03-01T00:00:00.000Z';
    const items = sectionOf(await buildWebHome(viewer, deps({ playlists: async () => [playlist('pb', 'Bravo', at), playlist('pa', 'Alpha', at)] })), 'playlists').items;
    expect(items.map((p) => p.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('names kind and origin like the playlists API: a list made by hand is «user», an automatic one «auto», a rule is «dynamic»', async () => {
    const list = [
      playlist('p1', 'By hand', '2026-03-04T00:00:00.000Z'),
      playlist('p2', 'Automatic', '2026-03-03T00:00:00.000Z', { origin: 'auto', autoKind: 'theme' }),
      playlist('p3', 'Soul da ascoltare', '2026-03-02T00:00:00.000Z', { kind: 'dynamic', origin: 'auto', ruleSummary: 'Aggiunte di recente · R&B/Soul · max 200' }),
      playlist('p4', 'Old backend', '2026-03-01T00:00:00.000Z', { kind: undefined, origin: undefined }),
    ];
    const items = sectionOf(await buildWebHome(viewer, deps({ playlists: async () => list })), 'playlists').items;
    expect(items.map((p) => [p.id, p.kind, p.origin, p.ruleSummary])).toEqual([
      ['p1', 'static', 'user', null],
      ['p2', 'static', 'auto', null],
      ['p3', 'dynamic', 'auto', 'Aggiunte di recente · R&B/Soul · max 200'],
      ['p4', 'static', 'user', null],
    ]);
  });

  it('carries exactly the fields of the contract, and the owner (a shared list says whose it is)', async () => {
    const [item] = sectionOf(await buildWebHome(viewer, deps({
      playlists: async () => [playlist('p1', 'Di Sara', '2026-03-01T00:00:00.000Z', { songCount: 7, ownerUser: 'sara' })],
    })), 'playlists').items;
    expect(item).toEqual({
      id: 'p1', name: 'Di Sara', songCount: 7, createdAt: '2026-03-01T00:00:00.000Z', kind: 'static', origin: 'user', ruleSummary: null, ownerUser: 'sara',
    });
  });

  it('the owner is an empty string for a list the store gave no owner (it never happens: the column is NOT NULL)', async () => {
    const [item] = sectionOf(await buildWebHome(viewer, deps({
      playlists: async () => [playlist('p1', 'Orphan', '2026-03-01T00:00:00.000Z', { ownerUser: undefined })],
    })), 'playlists').items;
    expect(item.ownerUser).toBe('');
  });

  it('counts the songs of a rule only for the lists it shows: the other ones are never evaluated', async () => {
    const list = Array.from({ length: 30 }, (_, i) => playlist(`p${i}`, `List ${i}`, `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, { kind: 'dynamic' }));
    const resolve = vi.fn(async (shown: Stored[]) => shown.map((p) => ({ ...p, songCount: 42 })));
    // not Michele: a rule is counted for the person who is looking, whoever that is
    const sara: WebHomeViewer = { userId: 'sara', isAdmin: true };
    const playlists = sectionOf(await buildWebHome(sara, deps({ playlists: async () => list, resolvePlaylists: resolve })), 'playlists');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toHaveLength(12);
    expect(resolve.mock.calls[0][1]).toEqual(sara);
    expect(playlists.items.every((p) => p.songCount === 42)).toBe(true);
  });

  it('shows the count the resolver gives, in the order it gives them', async () => {
    const list = [playlist('p1', 'A', '2026-03-02T00:00:00.000Z', { kind: 'dynamic', songCount: 0 }), playlist('p2', 'B', '2026-03-01T00:00:00.000Z')];
    const items = sectionOf(await buildWebHome(viewer, deps({
      playlists: async () => list,
      resolvePlaylists: async (shown: Stored[]) => shown.map((p) => (p.id === 'p1' ? { ...p, songCount: 58 } : p)),
    })), 'playlists').items;
    expect(items.map((p) => [p.id, p.songCount])).toEqual([['p1', 58], ['p2', 3]]);
  });

  it('a list of an empty library is no section, and nothing is resolved', async () => {
    const d = deps();
    expect((await buildWebHome(viewer, d)).sections).toEqual([]);
    expect(d.resolvePlaylists).not.toHaveBeenCalled();
  });
});

describe('films: the new films of the posts, one card per film', () => {
  it('collapses «Dune» and «Dune» with no year into one card, as the Films page does, and keeps two years as two films', async () => {
    const films = [
      film('Dune', '2021', [['e1', '2026-03-01T10:00:00.000Z']]),
      film('DUNE', null, [['e2', '2026-03-05T10:00:00.000Z']]),   // no year, another spelling: it joins the dated one
      film('Dune', '1984', [['e3', '2026-02-01T10:00:00.000Z']]),
    ];
    const home = sectionOf(await buildWebHome(viewer, deps({ films: async () => films })), 'films');
    expect(home.items.map((f) => [f.title, f.year])).toEqual([['Dune', '2021'], ['Dune', '1984']]);
    expect(home.total).toBe(2);
    // the collapsed card answers with the newest of the posts that name it
    expect(home.items[0].entryId).toBe('e2');
  });

  it('puts the film of the newest post first and takes the post fields from that newest mention', async () => {
    const a = film('Alpha', '2000', [['a-old', '2026-01-01T10:00:00.000Z', 'https://x.example/old'], ['a-new', '2026-03-09T10:00:00.000Z', 'https://x.example/new']]);
    const b = film('Bravo', '2001', [['b1', '2026-02-01T10:00:00.000Z']]);
    const items = sectionOf(await buildWebHome(viewer, deps({ films: async () => [b, a] })), 'films').items;
    expect(items.map((f) => f.title)).toEqual(['Alpha', 'Bravo']);
    expect([items[0].entryId, items[0].sourceUrl, items[0].createdAt]).toEqual(['a-new', 'https://x.example/new', '2026-03-09T10:00:00.000Z']);
    expect(items[1].sourceUrl).toBeNull();
  });

  it('carries exactly the fields of the contract: the year as text, the poster and the IMDb link or null', async () => {
    const full = film('Heat', 1995, [['e1', '2026-03-02T10:00:00.000Z', 'https://www.instagram.com/reel/HEAT/']], {
      posterUrl: 'https://img.example/heat.jpg', imdbUrl: 'https://www.imdb.com/title/tt0113277/',
    });
    // a film the store gave without the two fields at all (not even a null): the site still gets null, never «undefined»
    const bare = { ...film('Untitled', null, [['e2', '2026-03-01T10:00:00.000Z']]), posterUrl: undefined, imdbUrl: undefined } as unknown as AggregatedFilm;
    const items = sectionOf(await buildWebHome(viewer, deps({ films: async () => [full, bare] })), 'films').items;
    expect(items[0]).toEqual({
      filmKey: 'heat::1995', title: 'Heat', year: '1995', posterUrl: 'https://img.example/heat.jpg', imdbUrl: 'https://www.imdb.com/title/tt0113277/',
      entryId: 'e1', sourceUrl: 'https://www.instagram.com/reel/HEAT/', createdAt: '2026-03-02T10:00:00.000Z',
    });
    expect([items[1].year, items[1].posterUrl, items[1].imdbUrl]).toEqual([null, null, null]);
  });

  it('an empty or blank year is no year: the site gets null, never an empty text', async () => {
    const items = sectionOf(await buildWebHome(viewer, deps({
      films: async () => [
        film('Blank', '   ', [['e1', '2026-03-03T10:00:00.000Z']]),
        film('Empty', '', [['e2', '2026-03-02T10:00:00.000Z']]),
        film('Padded', ' 1999 ', [['e3', '2026-03-01T10:00:00.000Z']]),
      ],
    })), 'films').items;
    expect(items.map((f) => [f.title, f.year])).toEqual([['Blank', null], ['Empty', null], ['Padded', '1999']]);
  });

  it('shows twelve and counts all of them in the total', async () => {
    const films = Array.from({ length: 14 }, (_, i) => film(`Film ${String(i + 1).padStart(2, '0')}`, String(2000 + i), [[`e${i}`, `2026-03-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`]]));
    const home = sectionOf(await buildWebHome(viewer, deps({ films: async () => films })), 'films');
    expect(home.items).toHaveLength(12);
    expect(home.total).toBe(14);
    expect(home.items[0].title).toBe('Film 14');
    expect(home.items[11].title).toBe('Film 03');
  });

  it('two films of the same moment come out by title, every time', async () => {
    const at = '2026-03-01T10:00:00.000Z';
    const b = film('Bravo', '2001', [['e1', at]]);
    const a = film('Alpha', '2000', [['e2', at]]);
    expect(sectionOf(await buildWebHome(viewer, deps({ films: async () => [b, a] })), 'films').items.map((f) => f.title)).toEqual(['Alpha', 'Bravo']);
    expect(sectionOf(await buildWebHome(viewer, deps({ films: async () => [a, b] })), 'films').items.map((f) => f.title)).toEqual(['Alpha', 'Bravo']);
  });

  it('a film with no post at all is not a film of the posts: it is left out, and the section does not fail for it', async () => {
    const alone = await buildWebHome(viewer, deps({ films: async () => [film('Ghost', '2000', [])] }));
    expect(alone.sections).toEqual([]);
    const beside = sectionOf(await buildWebHome(viewer, deps({
      films: async () => [film('Ghost', '2000', []), film('Real', '2001', [['e1', '2026-03-01T10:00:00.000Z']])],
    })), 'films');
    expect(beside.items.map((f) => f.title)).toEqual(['Real']);
    expect(beside.total).toBe(1);
    expect(logWarning).not.toHaveBeenCalled();
  });
});

describe('one section failing costs only itself', () => {
  it.each([
    ['resume', { posts: async () => { throw new Error('db down'); } }],
    ['songs', { songs: async () => { throw new Error('db down'); } }],
    ['playlists', { playlists: async () => { throw new Error('db down'); } }],
    ['films', { films: async () => { throw new Error('db down'); } }],
  ] as const)('%s fails: the other three are answered and the failure is logged', async (failing, broken) => {
    const home = await buildWebHome(viewer, deps({
      posts: async () => ({ items: [post('e1', '2026-03-01T10:00:00.000Z')], total: 1 }),
      songs: async () => manySongs(2),
      playlists: async () => [playlist('p1', 'Road trip', '2026-01-01T00:00:00.000Z')],
      films: async () => [film('Dune', '2021', [['e2', '2026-03-02T10:00:00.000Z']])],
      ...broken,
    }));
    expect(idsOf(home)).toEqual(['resume', 'songs', 'playlists', 'films'].filter((id) => id !== failing));
    expect(logWarning).toHaveBeenCalledTimes(1);
    const [message, data] = vi.mocked(logWarning).mock.calls[0];
    expect(message).toContain(failing);
    expect(data).toMatchObject({ section: failing, error: 'db down' });
  });

  it('the resolution of a rule failing is the failure of the playlists section only', async () => {
    const home = await buildWebHome(viewer, deps({
      songs: async () => manySongs(1),
      playlists: async () => [playlist('p1', 'Rule', '2026-01-01T00:00:00.000Z', { kind: 'dynamic' })],
      resolvePlaylists: async () => { throw new Error('rule broke'); },
    }));
    expect(idsOf(home)).toEqual(['songs']);
    expect(logWarning).toHaveBeenCalledTimes(1);
  });

  it('every section failing still answers: no section, and no error', async () => {
    const boom = async () => { throw new Error('boom'); };
    const home = await buildWebHome(viewer, deps({ posts: boom, songs: boom, playlists: boom, films: boom }));
    expect(home).toEqual({ sections: [] });
    expect(logWarning).toHaveBeenCalledTimes(4);
  });

  it('a failure that is not an Error (a rejected string) is logged as text, never thrown', async () => {
    const home = await buildWebHome(viewer, deps({
      songs: async () => manySongs(1),
      films: () => Promise.reject('plain text'),
    }));
    expect(idsOf(home)).toEqual(['songs']);
    expect(vi.mocked(logWarning).mock.calls[0][1]).toMatchObject({ section: 'films', error: 'plain text' });
  });

  it('a source that throws at once (not inside a promise) also costs only its section', async () => {
    const home = await buildWebHome(viewer, deps({
      songs: manySongsSync,
      films: async () => [film('Dune', '2021', [['e2', '2026-03-02T10:00:00.000Z']])],
    }));
    expect(idsOf(home)).toEqual(['films']);
  });
});

function manySongsSync(): never {
  throw new Error('sync throw');
}
