import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real sources of the view layer, with the database mocked: what is tested here is the WIRING (who is asked for what, how a row becomes a fact);
// the rules are in collectionsView.test.ts and the real SQL is run by collectionsViewData.int.test.ts. Nothing here touches a database or the network.
const store = vi.hoisted(() => ({ placesOf: vi.fn(), venuesOf: vi.fn() }));
vi.mock('../utils/db', () => ({ query: vi.fn() }));
vi.mock('./collectionsStore', () => ({
  PgCollectionsStore: class {
    placesOf = store.placesOf;
    venuesOf = store.venuesOf;
  },
}));
vi.mock('./userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import { query } from '../utils/db';
import { getUserSongs } from './userSongs';
import { logWarning } from '../utils/logger';
import { entryVisibleTo, placesAndVenuesOfEntry, realViewSources, withCollectionChips } from './collectionsViewData';
import type { AggregatedSong } from '../types';

const D = (iso: string): Date => new Date(iso);
const src = realViewSources();
const sql = (call = 0): string => String(vi.mocked(query).mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call = 0): unknown[] => vi.mocked(query).mock.calls[call][1] as unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockResolvedValue([]);
});

describe('every question to the database is for ONE user, as a parameter', () => {
  it.each([
    ['the posts of every type', () => src.typeEntries('mike')],
    ['the posts of every place', () => src.placeEntries('mike')],
    ['the themes', () => src.themeRows('mike')],
    ['the live posts of the themes', () => src.themeMembers('mike')],
    ['the posts of a type', () => src.members('mike', { kind: 'type', type: 'type:music' })],
    ['the posts of a place', () => src.members('mike', { kind: 'place', names: ['Milano'] })],
    ['the posts of a theme', () => src.members('mike', { kind: 'theme', id: 't1' })],
    ['the theme chips', () => src.chipThemes('mike', ['e1'])],
    ['the place chips', () => src.chipPlaces('mike', ['e1'])],
  ])('%s', async (_label, ask) => {
    await ask();
    expect(query).toHaveBeenCalledTimes(1);
    expect(params()[0]).toBe('mike');
    // the user is never written into the text of the question
    expect(sql()).not.toContain('mike');
    expect(sql()).toContain('$1');
  });

  it.each([
    ['the posts of every type', () => src.typeEntries('mike')],
    ['the posts of every place', () => src.placeEntries('mike')],
    ['the live posts of the themes', () => src.themeMembers('mike')],
    ['the posts of a type', () => src.members('mike', { kind: 'type', type: 'type:films' })],
    ['the posts of a place', () => src.members('mike', { kind: 'place', names: ['Milano'] })],
    ['the posts of a theme', () => src.members('mike', { kind: 'theme', id: 't1' })],
  ])('%s: only the posts the user owns or that are shared with him, and no clause for an administrator', async (_label, ask) => {
    await ask();
    expect(sql()).toContain('owner_user = $1');
    expect(sql()).toContain('entry_shares');
    expect(sql()).toContain('shared_with = $1');
    expect(sql()).not.toMatch(/anonymous/);
  });
});

describe('the posts of every type', () => {
  it('are sorted into the types by what the posts hold, newest first, with their pictures', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { id: 'a', created_at: D('2026-11-09T10:00:00.000Z'), thumbnail_url: 'https://img/a.jpg', music: true, films: false, software: false, places: false, books: false },
      { id: 'b', created_at: D('2026-11-08T10:00:00.000Z'), thumbnail_url: null, music: true, films: true, software: false, places: true, books: false },
      { id: 'c', created_at: D('2026-11-07T10:00:00.000Z'), thumbnail_url: null, music: false, films: false, software: true, places: false, books: true },
    ]);
    const types = await src.typeEntries('mike');
    expect(types['type:music']).toEqual([
      { id: 'a', createdAt: '2026-11-09T10:00:00.000Z', thumbnailUrl: 'https://img/a.jpg' },
      { id: 'b', createdAt: '2026-11-08T10:00:00.000Z', thumbnailUrl: null },
    ]);
    expect(types['type:films']?.map((f) => f.id)).toEqual(['b']);
    expect(types['type:software']?.map((f) => f.id)).toEqual(['c']);
    expect(types['type:places']?.map((f) => f.id)).toEqual(['b']);
    expect(types['type:books']?.map((f) => f.id)).toEqual(['c']);
  });

  it('are asked as predicates on the results of the post: songs, films, software, notes of the place and of the book', async () => {
    await src.typeEntries('mike');
    const text = sql();
    for (const part of ["'songs'", "'films'", "'software'", "'notes'", "'place'", "'book'"]) expect(text).toContain(part);
  });

  it('are nothing for a user with no post', async () => {
    expect(await src.typeEntries('nobody')).toEqual({});
  });
});

describe('the posts of every place', () => {
  it('are grouped by place and kind, with the posts newest first', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { place: 'Milano', kind: 'city', id: 'a', created_at: D('2026-11-09T10:00:00.000Z'), thumbnail_url: 'https://img/a.jpg' },
      { place: 'Roma', kind: 'city', id: 'a', created_at: D('2026-11-09T10:00:00.000Z'), thumbnail_url: 'https://img/a.jpg' },
      { place: 'Milano', kind: 'city', id: 'b', created_at: D('2026-11-01T10:00:00.000Z'), thumbnail_url: null },
      { place: 'Milano', kind: 'region', id: 'c', created_at: D('2026-10-01T10:00:00.000Z'), thumbnail_url: null },
    ]);
    const places = await src.placeEntries('mike');
    expect(places.map((p) => [p.name, p.kind, p.entries.map((e) => e.id)])).toEqual([
      ['Milano', 'city', ['a', 'b']], ['Roma', 'city', ['a']], ['Milano', 'region', ['c']],
    ]);
  });
});

describe('the themes', () => {
  it('are rows with their state and their date', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { id: 't1', name: 'Vino', name_by: 'user', group_label: 'Cibo e bevande', parent_id: null, state: 'active', created_at: D('2026-11-01T10:00:00.000Z') },
      { id: 't2', name: 'Altro', name_by: 'auto', group_label: null, parent_id: 't1', state: 'hidden', created_at: D('2026-11-02T10:00:00.000Z') },
    ]);
    expect(await src.themeRows('mike')).toEqual([
      { id: 't1', name: 'Vino', nameBy: 'user', groupLabel: 'Cibo e bevande', parentId: null, state: 'active', createdAt: '2026-11-01T10:00:00.000Z' },
      { id: 't2', name: 'Altro', nameBy: 'auto', groupLabel: null, parentId: 't1', state: 'hidden', createdAt: '2026-11-02T10:00:00.000Z' },
    ]);
  });

  it('have their live posts, by theme, newest first, without the ones the user took out and without a merged theme', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { collection_id: 't1', id: 'a', created_at: D('2026-11-09T10:00:00.000Z'), thumbnail_url: 'https://img/a.jpg' },
      { collection_id: 't2', id: 'a', created_at: D('2026-11-09T10:00:00.000Z'), thumbnail_url: 'https://img/a.jpg' },
      { collection_id: 't1', id: 'b', created_at: D('2026-11-08T10:00:00.000Z'), thumbnail_url: null },
    ]);
    const members = await src.themeMembers('mike');
    expect(Object.keys(members).sort()).toEqual(['t1', 't2']);
    expect(members.t1.map((f) => f.id)).toEqual(['a', 'b']);
    expect(sql()).toContain("'user_remove'");
    expect(sql()).toContain("'merged'");
  });
});

describe('the posts of one collection', () => {
  const summaryRow = (over: Record<string, unknown> = {}) => ({
    id: 'a', source_url: 'https://www.instagram.com/reel/a/', source_platform: 'instagram', caption: 'una didascalia', thumbnail_url: 'https://img/a.jpg', status: 'completed',
    created_at: D('2026-11-09T10:00:00.000Z'), summary: 'Un riassunto', song_count: '2', film_count: 0, note_count: 3, tags: ['#vino', 7, null, '#cantina'], score: 0.75, source: 'auto', ...over,
  });

  it('are the summary rows of the list of entries: the numbers are numbers, the tags are the texts, the date is ISO', async () => {
    vi.mocked(query).mockResolvedValueOnce([summaryRow()]);
    const [row] = await src.members('mike', { kind: 'theme', id: 't1' });
    expect(row).toEqual({
      id: 'a', sourceUrl: 'https://www.instagram.com/reel/a/', sourcePlatform: 'instagram', caption: 'una didascalia', thumbnailUrl: 'https://img/a.jpg', status: 'completed',
      createdAt: '2026-11-09T10:00:00.000Z', summary: 'Un riassunto', songCount: 2, filmCount: 0, noteCount: 3, tags: ['#vino', '#cantina'], score: 0.75, source: 'auto',
    });
  });

  it('says who put a post in: the grouping, the user, or nobody (a type is computed)', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      summaryRow({ id: 'a', source: 'auto' }), summaryRow({ id: 'b', source: 'user_add' }), summaryRow({ id: 'c', source: 'computed' }), summaryRow({ id: 'd', source: 'something else' }),
    ]);
    const rows = await src.members('mike', { kind: 'theme', id: 't1' });
    expect(rows.map((r) => r.source)).toEqual(['auto', 'user_add', 'computed', 'computed']);
  });

  it('a theme is asked for by its id, for the user who owns it', async () => {
    await src.members('sara', { kind: 'theme', id: 'theme-9' });
    expect(params()).toEqual(['sara', 'theme-9']);
    expect(sql()).toContain('c.owner_user = $1');
    expect(sql()).toContain("'user_remove'");
  });

  it('a place is asked for by every spelling the user has', async () => {
    await src.members('mike', { kind: 'place', names: ['Milano', 'milano'] });
    expect(params()).toEqual(['mike', ['Milano', 'milano']]);
    expect(sql()).toContain('entry_places');
  });

  it('a type is asked for by its predicate, and the rows say they were computed (no score, no origin)', async () => {
    vi.mocked(query).mockResolvedValueOnce([summaryRow({ score: 0, source: 'computed' })]);
    const [row] = await src.members('mike', { kind: 'type', type: 'type:books' });
    expect(row).toMatchObject({ score: 0, source: 'computed' });
    expect(sql()).toContain("'book'");
    expect(params()).toEqual(['mike']);
  });

  it('every kind of type has its own question (a book is not a place)', async () => {
    const texts: string[] = [];
    for (const type of ['type:music', 'type:films', 'type:software', 'type:places', 'type:books'] as const) {
      vi.mocked(query).mockClear();
      await src.members('mike', { kind: 'type', type });
      texts.push(sql());
    }
    expect(new Set(texts).size).toBe(5);
  });

  it('are newest first', async () => {
    await src.members('mike', { kind: 'type', type: 'type:music' });
    expect(sql()).toContain('ORDER BY e.created_at DESC');
  });

  it('a row whose summary or caption is empty keeps them as null', async () => {
    vi.mocked(query).mockResolvedValueOnce([summaryRow({ summary: null, caption: null, tags: null })]);
    const [row] = await src.members('mike', { kind: 'theme', id: 't1' });
    expect(row).toMatchObject({ summary: null, caption: null, tags: [] });
  });
});

describe('the chips of a page of posts', () => {
  it('the themes are the ACTIVE ones the post is in, not the ones it was taken out of, for the whole page at once', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      { entry_id: 'e1', id: 't1', name: 'Vino', parent_id: 'p', score: '0.8' },   // a REAL can come back as text
      { entry_id: 'e2', id: 't2', name: 'Viaggi', parent_id: null, score: 0.5 },
    ]);
    expect(await src.chipThemes('mike', ['e1', 'e2'])).toEqual([
      { entryId: 'e1', id: 't1', name: 'Vino', parentId: 'p', score: 0.8 },
      { entryId: 'e2', id: 't2', name: 'Viaggi', parentId: null, score: 0.5 },
    ]);
    expect(params()).toEqual(['mike', ['e1', 'e2']]);
    expect(sql()).toContain("c.state = 'active'");
    expect(sql()).toContain("'user_remove'");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('the places say how many posts of the user name them (a place is a collection from eight)', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ entry_id: 'e1', place: 'Milano', kind: 'city', n: '9' }]);
    expect(await src.chipPlaces('mike', ['e1', 'e2'])).toEqual([{ entryId: 'e1', name: 'Milano', kind: 'city', entries: 9 }]);
    expect(params()).toEqual(['mike', ['e1', 'e2']]);
    expect(sql()).toContain('count(DISTINCT');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('the songs', () => {
  const song = (key: string, createdAts: string[], extra: Partial<AggregatedSong> = {}): AggregatedSong => ({
    songKey: key, title: key, artist: 'A', album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: createdAts.map((createdAt, i) => ({ entryId: `e${i}`, createdAt, sourceUrl: null, sourcePlatform: 'instagram' })), meta: null, inLibrary: false, ...extra,
  });

  it('are those of the journal of the user, never the journal an administrator sees, each with the date of its newest post', async () => {
    vi.mocked(getUserSongs).mockResolvedValue(new Map([
      ['a::one', song('a::one', ['2026-11-01T10:00:00.000Z', '2026-11-09T10:00:00.000Z', '2026-10-01T10:00:00.000Z'])],
      ['b::two', song('b::two', ['not a date'])],
    ]));
    expect(await src.songs('mike')).toEqual([{ key: 'a::one', at: '2026-11-09T10:00:00.000Z' }, { key: 'b::two', at: 'not a date' }]);
    expect(getUserSongs).toHaveBeenCalledWith('mike', false);
  });

  it('never include a song that exists only as a file', async () => {
    vi.mocked(getUserSongs).mockResolvedValue(new Map([['f::file', song('f::file', ['2026-11-01T10:00:00.000Z'], { libraryOnly: true })]]));
    expect(await src.songs('mike')).toEqual([]);
  });
});

describe('the places and the venues of a post in full', () => {
  const entry = { id: 'e1', sourceUrl: 'https://www.instagram.com/reel/e1/', sourcePlatform: 'instagram', createdAt: '2026-11-09T10:00:00.000Z' };

  it('are what the store holds for the post: the places as they are, the venues as one row each with the address of Maps', async () => {
    store.placesOf.mockResolvedValue([{ entryId: 'e1', name: 'Milano', kind: 'city' }]);
    store.venuesOf.mockResolvedValue([{ entryId: 'e1', key: 'bar luce|milano', name: 'Bar Luce', kind: 'bar', place: 'Milano' }]);
    const answer = await placesAndVenuesOfEntry(entry);
    expect(answer?.places).toEqual([{ name: 'Milano', kind: 'city' }]);
    expect(answer?.venues).toEqual([{
      key: 'bar luce|milano', name: 'Bar Luce', kind: 'bar', place: 'Milano', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Bar%20Luce%2C%20Milano',
      posts: [{ entryId: 'e1', sourceUrl: 'https://www.instagram.com/reel/e1/', sourcePlatform: 'instagram', createdAt: '2026-11-09T10:00:00.000Z' }],
    }]);
    expect(store.placesOf).toHaveBeenCalledWith(['e1']);
    expect(store.venuesOf).toHaveBeenCalledWith(['e1']);
  });

  it('keep the kind of each place: a city, a region, a country', async () => {
    store.placesOf.mockResolvedValue([{ entryId: 'e1', name: 'Lombardia', kind: 'region' }, { entryId: 'e1', name: 'Italia', kind: 'country' }]);
    store.venuesOf.mockResolvedValue([]);
    expect((await placesAndVenuesOfEntry(entry))?.places).toEqual([{ name: 'Lombardia', kind: 'region' }, { name: 'Italia', kind: 'country' }]);
  });

  it('are empty lists for a post that has none', async () => {
    store.placesOf.mockResolvedValue([]);
    store.venuesOf.mockResolvedValue([]);
    expect(await placesAndVenuesOfEntry(entry)).toEqual({ places: [], venues: [] });
  });

  it('are null when the store fails (the post is answered without them, and the failure is logged)', async () => {
    store.placesOf.mockRejectedValue(new Error('db down'));
    store.venuesOf.mockResolvedValue([]);
    expect(await placesAndVenuesOfEntry(entry)).toBeNull();
    expect(logWarning).toHaveBeenCalledTimes(1);
  });
});

describe('the chips on a list of posts', () => {
  const rows = [{ id: 'e1', summary: 'uno' }, { id: 'e2', summary: 'due' }];

  it('are added to every row, an empty list for the rows that have none', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce([{ entry_id: 'e1', id: 't1', name: 'Vino', parent_id: null, score: 0.8 }])
      .mockResolvedValueOnce([]);
    expect(await withCollectionChips(rows, 'mike')).toEqual([
      { id: 'e1', summary: 'uno', collections: [{ id: 't1', name: 'Vino' }] },
      { id: 'e2', summary: 'due', collections: [] },
    ]);
  });

  it('are asked for the user of the list, for the whole list at once', async () => {
    await withCollectionChips(rows, 'sara');
    expect(vi.mocked(query).mock.calls.map((c) => (c[1] as unknown[])[0])).toEqual(['sara', 'sara']);
    expect(vi.mocked(query).mock.calls.map((c) => (c[1] as unknown[])[1])).toEqual([['e1', 'e2'], ['e1', 'e2']]);
  });

  it('never break the list: when the collections cannot be read the rows come back with no chips, and the failure is logged', async () => {
    vi.mocked(query).mockRejectedValue(new Error('db down'));
    const out = await withCollectionChips(rows, 'mike');
    expect(out).toEqual([{ id: 'e1', summary: 'uno', collections: [] }, { id: 'e2', summary: 'due', collections: [] }]);
    expect(logWarning).toHaveBeenCalledTimes(1);
  });

  it('ask nothing for an empty list', async () => {
    expect(await withCollectionChips([], 'mike')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('whether a post is the user\'s to read', () => {
  it('is yes when the question finds it, and the user and the post are parameters', async () => {
    vi.mocked(query).mockResolvedValueOnce([{ ok: 1 }]);
    expect(await entryVisibleTo('mike', 'e1')).toBe(true);
    expect(params()).toEqual(['mike', 'e1']);
    expect(sql()).toContain('entry_shares');
    expect(sql()).not.toMatch(/anonymous/);
  });

  it('is no when it does not', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    expect(await entryVisibleTo('mike', 'e9')).toBe(false);
  });
});
