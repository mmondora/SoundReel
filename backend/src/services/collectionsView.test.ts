import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import {
  COLLECTION_VIEW,
  TYPE_IDS,
  TYPE_NAMES,
  buildCollections,
  chipsForEntries,
  collectionDetail,
  collectionList,
  describeCollection,
  explainTheme,
  findCollection,
  groupVenues,
  isComputedId,
  parseCollectionId,
  pickChips,
  placeCollectionId,
  slugify,
  type ChipPlaceRow,
  type ChipSources,
  type ChipThemeRow,
  type DetailQuery,
  type DetailSources,
  type EntryFact,
  type ListSources,
  type MemberRef,
  type MemberRow,
  type PlaceFacts,
  type ThemeRow,
  type VenueEntryRef,
  type WhyMember,
} from './collectionsView';
import type { EntryPlaceRow, EntryVenueRow } from './collectionsStore';

// The view layer of the collections (docs/collections.md, spec 2026-11-09-library-collections-auto-topics-design.md §4, §6, §8): the RULES that turn
// what the store and the journal hold into what the site draws. Pure: the sources are injected, so none of this touches a database.

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

const fact = (id: string, createdAt = ago(1), thumbnailUrl: string | null = `https://img.example/${id}.jpg`): EntryFact => ({ id, createdAt, thumbnailUrl });
const facts = (n: number, withThumb = n): EntryFact[] =>
  Array.from({ length: n }, (_, i) => fact(`e${i}`, ago(i + 1), i < withThumb ? `https://img.example/e${i}.jpg` : null));

describe('the ids of the collections', () => {
  it('has exactly the five types, in the order they are shown, each with its name', () => {
    expect(TYPE_IDS).toEqual(['type:music', 'type:films', 'type:software', 'type:places', 'type:books']);
    expect(TYPE_NAMES).toEqual({
      'type:music': 'Musica',
      'type:films': 'Film e serie',
      'type:software': 'Software e app',
      'type:places': 'Luoghi',
      'type:books': 'Libri',
    });
  });

  it.each([
    ['Milano', 'milano'],
    ['Reggio Emilia', 'reggio-emilia'],
    ['São Paulo', 'sao-paulo'],
    ['Friuli-Venezia Giulia', 'friuli-venezia-giulia'],
    ["L'Aquila", 'l-aquila'],
    ['Area 51', 'area-51'],
    ['  Trentino   Alto Adige ', 'trentino-alto-adige'],
    ['Zürich', 'zurich'],
  ])('the slug of %s is %s: lower case, no accents, anything that is not a letter or a digit becomes one dash', (name, slug) => {
    expect(slugify(name)).toBe(slug);
    expect(placeCollectionId(name)).toBe(`place:${slug}`);
  });

  it('a slug has no dash at either end and never two in a row', () => {
    expect(slugify('--Roma!!--')).toBe('roma');
    expect(slugify('A & B')).toBe('a-b');
  });

  it('tells a type, a place and a theme apart by the id', () => {
    expect(parseCollectionId('type:music')).toEqual({ kind: 'type', type: 'type:music' });
    expect(parseCollectionId('type:books')).toEqual({ kind: 'type', type: 'type:books' });
    expect(parseCollectionId('place:milano')).toEqual({ kind: 'place', slug: 'milano' });
    expect(parseCollectionId('3f2b6c1e-0b44-4f0a-9d10-0a1f1c2d3e4f')).toEqual({ kind: 'theme', id: '3f2b6c1e-0b44-4f0a-9d10-0a1f1c2d3e4f' });
  });

  it('a type or a place the site does not know is an unknown computed id, never a theme', () => {
    expect(parseCollectionId('type:podcasts')).toEqual({ kind: 'unknown-computed' });
    expect(parseCollectionId('type:')).toEqual({ kind: 'unknown-computed' });
    expect(parseCollectionId('place:')).toEqual({ kind: 'unknown-computed' });
  });

  it('says which ids are computed (they have no row and cannot be corrected)', () => {
    expect(isComputedId('type:music')).toBe(true);
    expect(isComputedId('type:whatever')).toBe(true);
    expect(isComputedId('place:milano')).toBe(true);
    expect(isComputedId('abc-123')).toBe(false);
    expect(isComputedId('typeface')).toBe(false);
  });
});

describe('describing a collection from its entries', () => {
  const base = { id: 'c1', name: 'Vino', kind: 'theme' as const, group: 'Cibo e bevande', parentId: null, createdAt: ago(30) };

  it('counts the entries', () => {
    expect(describeCollection(base, facts(7), NOW).count).toBe(7);
  });

  it('keeps the fixed fields as the server decided them', () => {
    const item = describeCollection({ ...base, parentId: 'p1' }, facts(5), NOW);
    expect(item).toMatchObject({ id: 'c1', name: 'Vino', kind: 'theme', group: 'Cibo e bevande', parentId: 'p1' });
  });

  it('shows up to four pictures: those of the newest entries that have one', () => {
    const list = [fact('new', ago(1)), fact('mid', ago(5), null), fact('a', ago(6)), fact('b', ago(7)), fact('c', ago(8)), fact('old', ago(9))];
    expect(describeCollection(base, list, NOW).thumbs).toEqual([
      'https://img.example/new.jpg', 'https://img.example/a.jpg', 'https://img.example/b.jpg', 'https://img.example/c.jpg',
    ]);
  });

  it('takes the pictures from the newest, whatever order the entries come in', () => {
    const list = [fact('old', ago(40)), fact('new', ago(1)), fact('mid', ago(10))];
    expect(describeCollection(base, list, NOW).thumbs).toEqual([
      'https://img.example/new.jpg', 'https://img.example/mid.jpg', 'https://img.example/old.jpg',
    ]);
  });

  it('shows a picture once, even when two entries share it', () => {
    const list = [fact('a', ago(1), 'https://img.example/same.jpg'), fact('b', ago(2), 'https://img.example/same.jpg'), fact('c', ago(3), 'https://img.example/other.jpg')];
    expect(describeCollection(base, list, NOW).thumbs).toEqual(['https://img.example/same.jpg', 'https://img.example/other.jpg']);
  });

  it('an empty address is not a picture', () => {
    expect(describeCollection(base, [fact('a', ago(1), ''), fact('b', ago(2), '   ')], NOW).thumbs).toEqual([]);
  });

  it('has no picture when no entry has one', () => {
    expect(describeCollection(base, facts(5, 0), NOW).thumbs).toEqual([]);
  });

  describe('which views it offers, from what the data can fill', () => {
    it('offers only the list when fewer than a quarter of the entries have a picture', () => {
      const item = describeCollection(base, facts(100, 24), NOW);
      expect(item.views).toEqual(['list']);
      expect(item.defaultView).toBe('list');
    });

    it('offers the grid, but starts on the list, from a quarter of the entries', () => {
      const item = describeCollection(base, facts(100, 25), NOW);
      expect(item.views).toEqual(['grid', 'list']);
      expect(item.defaultView).toBe('list');
    });

    it('still starts on the list just below 60 %', () => {
      const item = describeCollection(base, facts(100, 59), NOW);
      expect(item.views).toEqual(['grid', 'list']);
      expect(item.defaultView).toBe('list');
    });

    it('starts on the grid from 60 % of the entries with a picture', () => {
      const item = describeCollection(base, facts(100, 60), NOW);
      expect(item.views).toEqual(['grid', 'list']);
      expect(item.defaultView).toBe('grid');
    });

    it('starts on the grid when every entry has a picture', () => {
      expect(describeCollection(base, facts(6, 6), NOW).defaultView).toBe('grid');
    });

    it('five entries, three with a picture: 60 % exactly is a grid', () => {
      expect(describeCollection(base, facts(5, 3), NOW).defaultView).toBe('grid');
    });

    it('an empty collection has only the list', () => {
      const item = describeCollection(base, [], NOW);
      expect(item.count).toBe(0);
      expect(item.views).toEqual(['list']);
      expect(item.defaultView).toBe('list');
    });

    it('the music is for playing: the views are «play» and «list», it starts on «play», whatever its pictures', () => {
      const music = { id: 'type:music', name: 'Musica', kind: 'type' as const, group: 'Tipi', parentId: null, createdAt: null };
      for (const withThumb of [0, 50, 100]) {
        const item = describeCollection(music, facts(100, withThumb), NOW);
        expect(item.views).toEqual(['play', 'list']);
        expect(item.defaultView).toBe('play');
      }
    });

    it('only the music has «play»', () => {
      const films = { id: 'type:films', name: 'Film e serie', kind: 'type' as const, group: 'Tipi', parentId: null, createdAt: null };
      expect(describeCollection(films, facts(10, 10), NOW).views).not.toContain('play');
      expect(describeCollection(base, facts(10, 10), NOW).views).not.toContain('play');
    });

    it('uses the numbers of COLLECTION_VIEW, which are the ones of the contract', () => {
      expect(COLLECTION_VIEW.gridOffered).toBe(0.25);
      expect(COLLECTION_VIEW.gridDefault).toBe(0.6);
      expect(COLLECTION_VIEW.thumbs).toBe(4);
    });
  });

  describe('«New»', () => {
    it('is new when it was made less than seven days ago', () => {
      expect(describeCollection({ ...base, createdAt: ago(6.9) }, facts(5), NOW).isNew).toBe(true);
      expect(describeCollection({ ...base, createdAt: ago(0) }, facts(5), NOW).isNew).toBe(true);
    });

    it('is not new at seven days exactly, nor after', () => {
      expect(describeCollection({ ...base, createdAt: ago(7) }, facts(5), NOW).isNew).toBe(false);
      expect(describeCollection({ ...base, createdAt: ago(8) }, facts(5), NOW).isNew).toBe(false);
    });

    it('is not new when the date is not a date (nothing is invented)', () => {
      expect(describeCollection({ ...base, createdAt: 'yesterday' }, facts(5), NOW).isNew).toBe(false);
    });

    it('a type and a place are never new: they have no birth', () => {
      expect(describeCollection({ id: 'type:films', name: 'Film e serie', kind: 'type', group: 'Tipi', parentId: null, createdAt: null }, facts(5), NOW).isNew).toBe(false);
      expect(describeCollection({ id: 'place:milano', name: 'Milano', kind: 'place', group: 'Luoghi', parentId: null, createdAt: ago(1) }, facts(9), NOW).isNew).toBe(false);
    });
  });
});


// ---------------------------------------------------------------------------------------------------------------- the list

const theme = (id: string, over: Partial<ThemeRow> = {}): ThemeRow => ({
  id, name: `Tema ${id}`, nameBy: 'auto', groupLabel: null, parentId: null, state: 'active', createdAt: ago(60), ...over,
});

interface World {
  types?: Partial<Record<(typeof TYPE_IDS)[number], EntryFact[]>>;
  places?: PlaceFacts[];
  themes?: ThemeRow[];
  members?: Record<string, EntryFact[]>;
}

/** Sources that answer for the one user the world is about, and write down who was asked. */
function sources(world: World = {}, asked: string[] = []): ListSources {
  return {
    typeEntries: async (userId) => { asked.push(`types:${userId}`); return world.types ?? {}; },
    placeEntries: async (userId) => { asked.push(`places:${userId}`); return world.places ?? []; },
    themeRows: async (userId) => { asked.push(`themes:${userId}`); return world.themes ?? []; },
    themeMembers: async (userId) => { asked.push(`members:${userId}`); return world.members ?? {}; },
  };
}

const ids = (list: Array<{ id: string }>): string[] => list.map((c) => c.id);
const placeFacts = (name: string, n: number, kind: 'city' | 'region' | 'country' = 'city'): PlaceFacts => ({
  name, kind, entries: Array.from({ length: n }, (_, i) => fact(`${name}-${i}`, ago(i + 20))),
});

describe('the list of collections', () => {
  describe('the types', () => {
    it('are first, in the fixed order, each with its name, its heading «Tipi» and the number of posts', async () => {
      const world: World = { types: { 'type:books': facts(3), 'type:music': facts(719, 600), 'type:software': facts(701, 0), 'type:films': facts(256, 10) } };
      const list = await collectionList('mike', 'active', sources(world), NOW);
      expect(ids(list)).toEqual(['type:music', 'type:films', 'type:software', 'type:books']);
      expect(list[0]).toMatchObject({ name: 'Musica', kind: 'type', group: 'Tipi', parentId: null, count: 719, isNew: false });
      expect(list[1]).toMatchObject({ name: 'Film e serie', count: 256 });
      expect(list[2]).toMatchObject({ name: 'Software e app', count: 701 });
      expect(list[3]).toMatchObject({ name: 'Libri', count: 3 });
    });

    it('are left out when they have no post (only the ones with posts)', async () => {
      const list = await collectionList('mike', 'active', sources({ types: { 'type:music': facts(2), 'type:films': [], 'type:places': undefined } }), NOW);
      expect(ids(list)).toEqual(['type:music']);
    });

    it('come before every theme and every place, whatever their size', async () => {
      const world: World = {
        types: { 'type:books': facts(1) },
        themes: [theme('t1', { name: 'Vino' })],
        members: { t1: facts(500) },
        places: [placeFacts('Milano', 400)],
      };
      expect(ids(await collectionList('mike', 'active', sources(world), NOW))).toEqual(['type:books', 't1', 'place:milano']);
    });
  });

  describe('the themes', () => {
    it('are listed when they are active, with the heading of the seed list, their parent and the posts they hold', async () => {
      const world: World = {
        themes: [theme('t1', { name: 'Vino', groupLabel: 'Cibo e bevande', createdAt: ago(40) })],
        members: { t1: facts(12, 10) },
      };
      const [item] = await collectionList('mike', 'active', sources(world), NOW);
      expect(item).toMatchObject({ id: 't1', name: 'Vino', kind: 'theme', group: 'Cibo e bevande', parentId: null, count: 12, isNew: false });
      expect(item.defaultView).toBe('grid');
    });

    it('a theme with no heading goes under «Altre» (null)', async () => {
      const [item] = await collectionList('mike', 'active', sources({ themes: [theme('t1')], members: { t1: facts(5) } }), NOW);
      expect(item.group).toBeNull();
    });

    it('only the ACTIVE ones are in the default list: not hidden, not under observation, not merged', async () => {
      const world: World = {
        themes: [theme('a'), theme('h', { state: 'hidden' }), theme('w', { state: 'watching' }), theme('m', { state: 'merged', parentId: 'a' })],
        members: { a: facts(5), h: facts(5), w: facts(4), m: facts(5) },
      };
      expect(ids(await collectionList('mike', 'active', sources(world), NOW))).toEqual(['a']);
    });

    it('the hidden ones are a list of their own, to bring them back', async () => {
      const world: World = { themes: [theme('a'), theme('h', { state: 'hidden' })], members: { a: facts(5), h: facts(6) } };
      expect(ids(await collectionList('mike', 'hidden', sources(world), NOW))).toEqual(['h']);
    });

    it('the ones under observation are a list of their own (the route lets only the administrator read it)', async () => {
      const world: World = { themes: [theme('a'), theme('w', { state: 'watching' })], members: { a: facts(5), w: facts(3) } };
      expect(ids(await collectionList('mike', 'watching', sources(world), NOW))).toEqual(['w']);
    });

    it('a theme that has no post left (everything was deleted or unshared) is left out', async () => {
      const world: World = { themes: [theme('a'), theme('empty')], members: { a: facts(5) } };
      expect(ids(await collectionList('mike', 'active', sources(world), NOW))).toEqual(['a']);
    });

    it('a theme that is new says so for a week', async () => {
      const world: World = { themes: [theme('n', { createdAt: ago(2) }), theme('o', { createdAt: ago(9) })], members: { n: facts(5), o: facts(5) } };
      const list = await collectionList('mike', 'active', sources(world), NOW);
      expect(list.find((c) => c.id === 'n')?.isNew).toBe(true);
      expect(list.find((c) => c.id === 'o')?.isNew).toBe(false);
    });

    it('a theme keeps its parent only while the parent is in the list: a hidden or merged parent is no parent for the site', async () => {
      const world: World = {
        themes: [theme('p'), theme('c1', { parentId: 'p' }), theme('hp', { state: 'hidden' }), theme('c2', { parentId: 'hp' }), theme('gone', { parentId: 'nobody' })],
        members: { p: facts(9), c1: facts(5), hp: facts(7), c2: facts(5), gone: facts(5) },
      };
      const list = await collectionList('mike', 'active', sources(world), NOW);
      const parentOf = (id: string) => list.find((c) => c.id === id)?.parentId;
      expect(parentOf('c1')).toBe('p');
      expect(parentOf('c2')).toBeNull();
      expect(parentOf('gone')).toBeNull();
    });
  });

  describe('the places', () => {
    it('are collections from eight posts, with the heading «Luoghi», the place as name and the slug as id', async () => {
      const [item] = await collectionList('mike', 'active', sources({ places: [placeFacts('São Paulo', 9, 'city')] }), NOW);
      expect(item).toMatchObject({ id: 'place:sao-paulo', name: 'São Paulo', kind: 'place', group: 'Luoghi', parentId: null, count: 9, isNew: false });
    });

    it('a country is no collection, however many posts name it: «Italia» or «Cina» are named in passing far more often than they are the subject, and a place cannot be hidden; a city and a region from eight posts are', async () => {
      const list = await collectionList('mike', 'active', sources({ places: [placeFacts('Italia', 20, 'country'), placeFacts('Milano', 8, 'city'), placeFacts('Toscana', 8, 'region')] }), NOW);
      expect(ids(list).sort()).toEqual(['place:milano', 'place:toscana']);
    });

    it('seven posts are not a collection, eight are', async () => {
      expect(ids(await collectionList('mike', 'active', sources({ places: [placeFacts('Prato', 7)] }), NOW))).toEqual([]);
      expect(ids(await collectionList('mike', 'active', sources({ places: [placeFacts('Prato', 8)] }), NOW))).toEqual(['place:prato']);
      expect(COLLECTION_VIEW.placeCollectionMin).toBe(8);
    });

    it('count a post once, however many times the source repeats it', async () => {
      const one = fact('same', ago(3));
      const dup: PlaceFacts = { name: 'Roma', kind: 'city', entries: [one, one, one, ...facts(7)] };   // 1 + 7 = eight different posts
      const [item] = await collectionList('mike', 'active', sources({ places: [dup] }), NOW);
      expect(item.count).toBe(8);
      const short: PlaceFacts = { name: 'Roma', kind: 'city', entries: [one, one, one, one, ...facts(6)] };   // 1 + 6 = seven posts, ten rows
      expect(await collectionList('mike', 'active', sources({ places: [short] }), NOW)).toEqual([]);
    });

    it('two spellings of one place are one collection, called what most posts call it, and the posts that name both count once', async () => {
      const a: PlaceFacts = { name: 'Milano', kind: 'city', entries: facts(6) };
      const b: PlaceFacts = { name: 'milano', kind: 'region', entries: [...facts(6).slice(4), fact('x1'), fact('x2')] };   // two posts in common, four in all
      const list = await collectionList('mike', 'active', sources({ places: [a, b] }), NOW);
      expect(ids(list)).toEqual(['place:milano']);
      expect(list[0].count).toBe(8);
      expect(list[0].name).toBe('Milano');
      const swapped = await collectionList('mike', 'active', sources({ places: [b, a] }), NOW);
      expect(swapped[0].name).toBe('Milano');
    });

    it('a name with no letter or digit has no slug, so it is no collection (and the id «place:» is never made)', async () => {
      expect(await collectionList('mike', 'active', sources({ places: [placeFacts('???', 12)] }), NOW)).toEqual([]);
    });

    it('are not in the hidden or the watching lists (they have no state to correct)', async () => {
      const world: World = { places: [placeFacts('Milano', 9)] };
      expect(await collectionList('mike', 'hidden', sources(world), NOW)).toEqual([]);
      expect(await collectionList('mike', 'watching', sources(world), NOW)).toEqual([]);
    });
  });

  describe('the order of the themes and the places', () => {
    it('new first, then the ones with a post of the last two weeks, then the rest; by size inside each', async () => {
      const world: World = {
        themes: [
          theme('old-big', { name: 'Old big' }), theme('old-small', { name: 'Old small' }), theme('recent-small', { name: 'Recent small' }),
          theme('recent-big', { name: 'Recent big' }), theme('new-small', { name: 'New small', createdAt: ago(1) }), theme('new-big', { name: 'New big', createdAt: ago(3) }),
        ],
        members: {
          'old-big': facts(40).map((f, i) => fact(f.id, ago(30 + i))),
          'old-small': facts(6).map((f, i) => fact(f.id, ago(30 + i))),
          'recent-small': [fact('r1', ago(2)), ...facts(5).map((f, i) => fact(`rs${i}`, ago(40 + i)))],
          'recent-big': [fact('r2', ago(5)), ...facts(20).map((f, i) => fact(`rb${i}`, ago(40 + i)))],
          'new-small': facts(5).map((f, i) => fact(`ns${i}`, ago(50 + i))),
          'new-big': facts(9).map((f, i) => fact(`nb${i}`, ago(50 + i))),
        },
      };
      expect(ids(await collectionList('mike', 'active', sources(world), NOW))).toEqual([
        'new-big', 'new-small', 'recent-big', 'recent-small', 'old-big', 'old-small',
      ]);
    });

    it('a post of 14 days ago exactly is no longer recent; one of 13 days is', async () => {
      const world: World = {
        themes: [theme('a', { name: 'A' }), theme('b', { name: 'B' })],
        members: { a: [fact('a0', ago(14)), ...facts(2).map((f, i) => fact(`a${i + 1}`, ago(60 + i)))], b: [fact('b0', ago(13)), fact('b1', ago(60))] },
      };
      expect(ids(await collectionList('mike', 'active', sources(world), NOW))).toEqual(['b', 'a']);
      expect(COLLECTION_VIEW.recentDays).toBe(14);
    });

    it('places are ordered with the themes by the same rule (a place has no birth: it can only be recent)', async () => {
      const world: World = {
        themes: [theme('t', { name: 'Tema' })],
        members: { t: facts(30).map((f, i) => fact(f.id, ago(30 + i))) },
        places: [{ name: 'Milano', kind: 'city', entries: [fact('m0', ago(1)), ...facts(8).map((f, i) => fact(`m${i + 1}`, ago(40 + i)))] }],
      };
      expect(ids(await collectionList('mike', 'active', sources(world), NOW))).toEqual(['place:milano', 't']);
    });

    it('two of the same rank and size go by name, the way a person reads it (no case, no accents), then by id', async () => {
      const world: World = {
        themes: [theme('1', { name: 'zucchero' }), theme('4', { name: 'Àncora' }), theme('3', { name: 'ancora' }), theme('2', { name: 'Bar' })],
        members: { '1': facts(5), '4': facts(5), '3': facts(5), '2': facts(5) },
      };
      // by name: ancora, Àncora, Bar, zucchero (the ids go the other way round, so the name is what decides)
      expect(ids(await collectionList('mike', 'active', sources(world), NOW))).toEqual(['3', '4', '2', '1']);
    });

    it('two with the very same name, rank and size go by id, whatever order the store gave them in', async () => {
      const themes = [theme('x2', { name: 'Same' }), theme('x1', { name: 'Same' })];
      const members = { x1: facts(5), x2: facts(5) };
      expect(ids(await collectionList('mike', 'active', sources({ themes, members }), NOW))).toEqual(['x1', 'x2']);
      expect(ids(await collectionList('mike', 'active', sources({ themes: [...themes].reverse(), members }), NOW))).toEqual(['x1', 'x2']);
    });

    it('the order is the same whatever order the store gave the themes in', async () => {
      const themes = [theme('x', { name: 'X' }), theme('y', { name: 'Y' }), theme('w', { name: 'W' })];
      const members = { x: facts(5), y: facts(7), w: facts(6) };
      const one = ids(await collectionList('mike', 'active', sources({ themes, members }), NOW));
      const two = ids(await collectionList('mike', 'active', sources({ themes: [...themes].reverse(), members }), NOW));
      expect(one).toEqual(['y', 'w', 'x']);
      expect(two).toEqual(one);
    });
  });

  describe('whose it is', () => {
    it('asks every source for the user it is building the list of, and for no other', async () => {
      const asked: string[] = [];
      await collectionList('sara', 'active', sources({}, asked), NOW);
      expect(asked.sort()).toEqual(['members:sara', 'places:sara', 'themes:sara', 'types:sara']);
    });

    it('builds the list from what the sources answered for THAT user: two users, two lists', async () => {
      const perUser: Record<string, World> = {
        mike: { types: { 'type:music': facts(3) } },
        sara: { types: { 'type:films': facts(4) } },
      };
      const src = (user: string): ListSources => sources(perUser[user]);
      expect(ids(await collectionList('mike', 'active', src('mike'), NOW))).toEqual(['type:music']);
      expect(ids(await collectionList('sara', 'active', src('sara'), NOW))).toEqual(['type:films']);
    });

    it('a user with no post gets an empty list, not an error', async () => {
      expect(await collectionList('nobody', 'active', sources({}), NOW)).toEqual([]);
    });

    it('a source that fails fails the list (the route answers 500 and logs it; nothing half built is sent)', async () => {
      const broken: ListSources = { ...sources({}), typeEntries: async () => { throw new Error('db down'); } };
      await expect(collectionList('mike', 'active', broken, NOW)).rejects.toThrow('db down');
    });
  });
});

describe('finding one collection after a correction', () => {
  const world: World = {
    types: { 'type:music': facts(5) },
    places: [placeFacts('Milano', 9)],
    themes: [theme('a', { name: 'Vino' }), theme('h', { state: 'hidden', name: 'Nascosta' }), theme('w', { state: 'watching' }), theme('m', { state: 'merged', parentId: 'a' })],
    members: { a: facts(5), h: facts(6), w: facts(3), m: facts(5) },
  };

  it('finds a theme whatever it is doing, a type and a place, with its state', async () => {
    const src = sources(world);
    expect((await findCollection('mike', 'a', src, NOW))?.item.name).toBe('Vino');
    expect((await findCollection('mike', 'h', src, NOW))?.state).toBe('hidden');
    expect((await findCollection('mike', 'w', src, NOW))?.state).toBe('watching');
    expect((await findCollection('mike', 'type:music', src, NOW))?.state).toBe('computed');
    expect((await findCollection('mike', 'place:milano', src, NOW))?.state).toBe('computed');
  });

  it('does not find a country as a place (it is no collection), though a city with as many posts is found', async () => {
    const src = sources({ places: [placeFacts('Italia', 20, 'country'), placeFacts('Roma', 20, 'city')] });
    expect(await findCollection('mike', 'place:italia', src, NOW)).toBeNull();
    expect((await findCollection('mike', 'place:roma', src, NOW))?.state).toBe('computed');
  });

  it('does not find a merged one (it is no longer a collection), nor one that does not exist', async () => {
    const src = sources(world);
    expect(await findCollection('mike', 'm', src, NOW)).toBeNull();
    expect(await findCollection('mike', 'nope', src, NOW)).toBeNull();
    expect(await findCollection('mike', 'type:films', src, NOW)).toBeNull();
  });

  it('builds the same line as the list does', async () => {
    const src = sources(world);
    const found = await findCollection('mike', 'a', src, NOW);
    const listed = (await collectionList('mike', 'active', src, NOW)).find((c) => c.id === 'a');
    expect(found?.item).toEqual(listed);
  });

  it('every collection comes out with its state, merged ones left out', async () => {
    const all = await buildCollections('mike', sources(world), NOW);
    expect(all.map((c) => [c.item.id, c.state]).sort()).toEqual([
      ['a', 'active'], ['h', 'hidden'], ['place:milano', 'computed'], ['type:music', 'computed'], ['w', 'watching'],
    ]);
  });
});


// ---------------------------------------------------------------------------------------------------------------- the chips of a post

const chipTheme = (entryId: string, id: string, name: string, score: number, parentId: string | null = null): ChipThemeRow => ({ entryId, id, name, score, parentId });
const chipPlace = (entryId: string, name: string, entries: number, kind: 'city' | 'region' | 'country' = 'city'): ChipPlaceRow => ({ entryId, name, kind, entries });

describe('the chips of a post', () => {
  it('are the two themes the post is most sure about, the best first', () => {
    const chips = pickChips([chipTheme('e1', 'a', 'Vino', 0.5), chipTheme('e1', 'b', 'Cantine', 0.9), chipTheme('e1', 'c', 'Viaggi', 0.7)], []);
    expect(chips.get('e1')).toEqual([{ id: 'b', name: 'Cantine' }, { id: 'c', name: 'Viaggi' }]);
    expect(COLLECTION_VIEW.themeChips).toBe(2);
  });

  it('one theme is one chip', () => {
    expect(pickChips([chipTheme('e1', 'a', 'Vino', 0.5)], []).get('e1')).toEqual([{ id: 'a', name: 'Vino' }]);
  });

  it('two themes with the same score go by name, then by id', () => {
    const chips = pickChips([chipTheme('e1', 'z', 'Ricette', 0.8), chipTheme('e1', 'a', 'Vino', 0.8), chipTheme('e1', 'b', 'Vino', 0.8)], []);
    expect(chips.get('e1')).toEqual([{ id: 'z', name: 'Ricette' }, { id: 'a', name: 'Vino' }]);
  });

  it('the same theme twice is one chip, and it counts with its best score', () => {
    const chips = pickChips([chipTheme('e1', 'a', 'Vino', 0.5), chipTheme('e1', 'b', 'Viaggi', 0.6), chipTheme('e1', 'a', 'Vino', 0.9)], []);
    expect(chips.get('e1')).toEqual([{ id: 'a', name: 'Vino' }, { id: 'b', name: 'Viaggi' }]);
    const reversed = pickChips([chipTheme('e1', 'a', 'Vino', 0.9), chipTheme('e1', 'b', 'Viaggi', 0.6), chipTheme('e1', 'a', 'Vino', 0.5)], []);
    expect(reversed.get('e1')).toEqual([{ id: 'a', name: 'Vino' }, { id: 'b', name: 'Viaggi' }]);
  });

  it('a cycle of parents (it never happens) leaves a post with no chip, and no key in the map', () => {
    const chips = pickChips([chipTheme('e1', 'a', 'A', 0.5, 'b'), chipTheme('e1', 'b', 'B', 0.5, 'a')], []);
    expect(chips.has('e1')).toBe(false);
  });

  it('a post whose only place is too small to be a collection has no chip at all (it is not in the map)', () => {
    expect(pickChips([], [chipPlace('e1', 'Prato', 7)]).has('e1')).toBe(false);
  });

  it('a country is no chip, however many posts name it: there is no collection for it to open', () => {
    expect(pickChips([], [chipPlace('e1', 'Italia', 20, 'country')]).has('e1')).toBe(false);
    expect(pickChips([], [chipPlace('e1', 'Roma', 20, 'city')]).get('e1')).toEqual([{ id: 'place:roma', name: 'Roma' }]);
  });

  it('a place with no letter or digit is no chip', () => {
    expect(pickChips([], [chipPlace('e1', '???', 20)]).has('e1')).toBe(false);
  });

  describe('a theme and its parent', () => {
    it('show the child only: the post is in both, but the child says more', () => {
      const chips = pickChips([chipTheme('e1', 'parent', 'Intelligenza artificiale', 0.95), chipTheme('e1', 'child', 'Agenti', 0.6, 'parent')], []);
      expect(chips.get('e1')).toEqual([{ id: 'child', name: 'Agenti' }]);
    });

    it('show the parent when the post is not in any of its children', () => {
      const chips = pickChips([chipTheme('e1', 'parent', 'Intelligenza artificiale', 0.95), chipTheme('e2', 'child', 'Agenti', 0.6, 'parent')], []);
      expect(chips.get('e1')).toEqual([{ id: 'parent', name: 'Intelligenza artificiale' }]);
    });

    it('a child that is the parent of nothing is a leaf: two leaves and the parent give the two leaves', () => {
      const chips = pickChips(
        [chipTheme('e1', 'p', 'Tecnologia', 0.99), chipTheme('e1', 'c1', 'Agenti', 0.7, 'p'), chipTheme('e1', 'c2', 'Modelli', 0.6, 'p'), chipTheme('e1', 'x', 'Altro', 0.5)],
        [],
      );
      expect(chips.get('e1')).toEqual([{ id: 'c1', name: 'Agenti' }, { id: 'c2', name: 'Modelli' }]);
    });
  });

  describe('the place', () => {
    it('is a chip with the id of its collection when eight posts name it', () => {
      const chips = pickChips([chipTheme('e1', 'a', 'Ristoranti', 0.8)], [chipPlace('e1', 'Milano', 8)]);
      expect(chips.get('e1')).toEqual([{ id: 'a', name: 'Ristoranti' }, { id: 'place:milano', name: 'Milano' }]);
    });

    it('is no chip when fewer than eight posts name it: its collection does not exist, and the chip would lead nowhere', () => {
      expect(pickChips([chipTheme('e1', 'a', 'Ristoranti', 0.8)], [chipPlace('e1', 'Milano', 7)]).get('e1')).toEqual([{ id: 'a', name: 'Ristoranti' }]);
      expect(COLLECTION_VIEW.placeCollectionMin).toBe(8);
    });

    it('comes after the themes, and a post with no theme still has it', () => {
      expect(pickChips([], [chipPlace('e1', 'São Paulo', 12)]).get('e1')).toEqual([{ id: 'place:sao-paulo', name: 'São Paulo' }]);
    });

    it('is one chip: the most precise place that is a collection (city, then region, then country)', () => {
      const chips = pickChips([], [chipPlace('e1', 'Italia', 90, 'country'), chipPlace('e1', 'Lombardia', 30, 'region'), chipPlace('e1', 'Milano', 9, 'city')]);
      expect(chips.get('e1')).toEqual([{ id: 'place:milano', name: 'Milano' }]);
    });

    it('is the region when the city is not a collection, and none when neither is: a country is never a chip (it is no collection)', () => {
      expect(pickChips([], [chipPlace('e1', 'Lombardia', 30, 'region'), chipPlace('e1', 'Seregno', 2, 'city')]).get('e1')).toEqual([{ id: 'place:lombardia', name: 'Lombardia' }]);
      expect(pickChips([], [chipPlace('e1', 'Italia', 90, 'country'), chipPlace('e1', 'Seregno', 2, 'city')]).has('e1')).toBe(false);
    });

    it('two places of the same kind: the one that more posts name, then the first by name', () => {
      expect(pickChips([], [chipPlace('e1', 'Monza', 9), chipPlace('e1', 'Milano', 20)]).get('e1')).toEqual([{ id: 'place:milano', name: 'Milano' }]);
      expect(pickChips([], [chipPlace('e1', 'Monza', 9), chipPlace('e1', 'Lecco', 9)]).get('e1')).toEqual([{ id: 'place:lecco', name: 'Lecco' }]);
    });
  });

  describe('the collection that is open', () => {
    it('is always among the chips of its posts, first, even when the post is surer of others', () => {
      const rows = [chipTheme('e1', 'a', 'Vino', 0.2), chipTheme('e1', 'b', 'Cantine', 0.9), chipTheme('e1', 'c', 'Viaggi', 0.7)];
      expect(pickChips(rows, [], { keep: 'a' }).get('e1')).toEqual([{ id: 'a', name: 'Vino' }, { id: 'b', name: 'Cantine' }]);
    });

    it('changes nothing for a post that is not in it, nor when it is a type or a place', () => {
      const rows = [chipTheme('e1', 'b', 'Cantine', 0.9), chipTheme('e1', 'c', 'Viaggi', 0.7)];
      expect(pickChips(rows, [], { keep: 'a' }).get('e1')).toEqual([{ id: 'b', name: 'Cantine' }, { id: 'c', name: 'Viaggi' }]);
      expect(pickChips(rows, [], { keep: 'type:music' }).get('e1')).toEqual([{ id: 'b', name: 'Cantine' }, { id: 'c', name: 'Viaggi' }]);
    });

    it('keeps the child when it is the open one (the parent was skipped for it anyway)', () => {
      const rows = [chipTheme('e1', 'p', 'Tecnologia', 0.99), chipTheme('e1', 'c', 'Agenti', 0.4, 'p')];
      expect(pickChips(rows, [], { keep: 'c' }).get('e1')).toEqual([{ id: 'c', name: 'Agenti' }]);
    });
  });

  it('gives every post its own chips, and the posts that have none an empty list is NOT in the map (the caller says «none»)', () => {
    const chips = pickChips([chipTheme('e1', 'a', 'Vino', 0.5), chipTheme('e2', 'b', 'Viaggi', 0.5)], [chipPlace('e3', 'Milano', 10)]);
    expect([...chips.keys()].sort()).toEqual(['e1', 'e2', 'e3']);
    expect(chips.get('e1')).toEqual([{ id: 'a', name: 'Vino' }]);
    expect(chips.get('e2')).toEqual([{ id: 'b', name: 'Viaggi' }]);
    expect(chips.get('e3')).toEqual([{ id: 'place:milano', name: 'Milano' }]);
    expect(chips.get('e4')).toBeUndefined();
  });
});

describe('the chips of a page of posts', () => {
  const stand = (themes: ChipThemeRow[] = [], places: ChipPlaceRow[] = []): { src: ChipSources; asked: Array<[string, string, string[]]> } => {
    const asked: Array<[string, string, string[]]> = [];
    return {
      asked,
      src: {
        chipThemes: async (userId, entryIds) => { asked.push(['themes', userId, entryIds]); return themes; },
        chipPlaces: async (userId, entryIds) => { asked.push(['places', userId, entryIds]); return places; },
      },
    };
  };

  it('asks each source ONCE for the whole page (no question for each post), for the user it is for', async () => {
    const { src, asked } = stand([chipTheme('e1', 'a', 'Vino', 0.5)], [chipPlace('e2', 'Milano', 9)]);
    const chips = await chipsForEntries('sara', ['e1', 'e2', 'e3'], src);
    expect(asked).toEqual([['themes', 'sara', ['e1', 'e2', 'e3']], ['places', 'sara', ['e1', 'e2', 'e3']]]);
    expect(chips.get('e1')).toEqual([{ id: 'a', name: 'Vino' }]);
    expect(chips.get('e2')).toEqual([{ id: 'place:milano', name: 'Milano' }]);
  });

  it('asks nothing for an empty page', async () => {
    const { src, asked } = stand();
    expect((await chipsForEntries('sara', [], src)).size).toBe(0);
    expect(asked).toEqual([]);
  });

  it('passes the open collection on, so that its chip is among those of its posts', async () => {
    const { src } = stand([chipTheme('e1', 'a', 'Vino', 0.1), chipTheme('e1', 'b', 'Cantine', 0.9), chipTheme('e1', 'c', 'Viaggi', 0.8)]);
    expect((await chipsForEntries('sara', ['e1'], src, { keep: 'a' })).get('e1')?.[0]).toEqual({ id: 'a', name: 'Vino' });
  });

  it('lets a failure of a source go to the caller (the route logs it and answers without chips; nothing is invented here)', async () => {
    const src: ChipSources = { chipThemes: async () => { throw new Error('db down'); }, chipPlaces: async () => [] };
    await expect(chipsForEntries('sara', ['e1'], src)).rejects.toThrow('db down');
  });
});


// ---------------------------------------------------------------------------------------------------------------- «Why is it here?»

let whySeq = 0;
const why = (over: Partial<WhyMember> = {}): WhyMember => ({
  id: `w${++whySeq}`, createdAt: ago(10), summary: null, tags: [], score: 0.5, source: 'auto', ...over,
});

describe('«Why is it here?»: the posts that are most typical', () => {
  it('are the two with the highest score', () => {
    const members = [why({ id: 'a', score: 0.4 }), why({ id: 'b', score: 0.9 }), why({ id: 'c', score: 0.7 }), why({ id: 'd', score: 0.8 })];
    expect(explainTheme(members).entryIds).toEqual(['b', 'd']);
    expect(COLLECTION_VIEW.whyEntries).toBe(2);
  });

  it('go, at the same score, to the newest post, then by id', () => {
    const members = [why({ id: 'old', score: 0.9, createdAt: ago(30) }), why({ id: 'new', score: 0.9, createdAt: ago(1) }), why({ id: 'mid', score: 0.9, createdAt: ago(10) })];
    expect(explainTheme(members).entryIds).toEqual(['new', 'mid']);
    const same = [why({ id: 'b', score: 0.9, createdAt: ago(5) }), why({ id: 'a', score: 0.9, createdAt: ago(5) })];
    expect(explainTheme(same).entryIds).toEqual(['a', 'b']);
  });

  it('are not the ones the user put in by hand (their score is a formality): the posts the grouping found come first', () => {
    const members = [why({ id: 'hand', score: 1, source: 'user_add' }), why({ id: 'auto1', score: 0.6 }), why({ id: 'auto2', score: 0.5 }), why({ id: 'auto3', score: 0.4 })];
    expect(explainTheme(members).entryIds).toEqual(['auto1', 'auto2']);
  });

  it('are the ones put in by hand, newest first, when the grouping found fewer than two', () => {
    const members = [why({ id: 'auto', score: 0.2 }), why({ id: 'h1', source: 'user_add', createdAt: ago(9) }), why({ id: 'h2', source: 'user_add', createdAt: ago(2) })];
    expect(explainTheme(members).entryIds).toEqual(['auto', 'h2']);
  });

  it('are one when the theme has one post, and none when it has none', () => {
    expect(explainTheme([why({ id: 'only' })]).entryIds).toEqual(['only']);
    expect(explainTheme([])).toEqual({ words: [], entryIds: [] });
  });
});

describe('«Why is it here?»: the words', () => {
  const tagged = (...tags: string[][]): WhyMember[] => tags.map((t) => why({ tags: t }));

  it('start from the tags that at least two posts share, the most common first, without the hash', () => {
    const members = tagged(['#vino', '#cantina', '#solo1'], ['#vino', '#cantina'], ['#vino', '#barolo', '#solo2'], ['#barolo', '#cantina', '#vino']);
    expect(explainTheme(members).words).toEqual(['vino', 'cantina', 'barolo']);
  });

  it('count a tag once for a post, even when the post says it twice', () => {
    expect(explainTheme(tagged(['#vino', '#vino', 'vino'], ['#cantina'])).words).toEqual([]);
  });

  it('say the same tag the same way whatever the case or the hash, and show the way most posts write it', () => {
    const members = tagged(['#Vino'], ['#vino'], ['#VINO', '#x1'], ['vino']);
    expect(explainTheme(members).words).toEqual(['vino']);
    expect(explainTheme(tagged(['#AI'], ['#AI'], ['#ai'])).words).toEqual(['AI']);
  });

  it('never include the words of the model’s own prompt, the handles, or the tags of the feed', () => {
    const noise = ['#tag', '#utente', '#hashtag', '@mario', '#fyp', '#viral', '#reels', '#instagram', '#foryou', '#trending'];
    expect(explainTheme(tagged(noise, noise, noise)).words).toEqual([]);
  });

  it('take at most four, tags first', () => {
    const t = ['#a1', '#b2', '#c3', '#d4', '#e5', '#f6'];
    const words = explainTheme(tagged(t, t, t)).words;
    expect(words).toHaveLength(4);
    expect(words).toEqual(['a1', 'b2', 'c3', 'd4']);
    expect(COLLECTION_VIEW.whyWords).toBe(4);
  });

  it('with two tags in common, fill up with the words the summaries repeat', () => {
    const members = [
      why({ tags: ['#vino', '#cantina'], summary: 'Una cantina storica in Langa dove si produce il barolo.' }),
      why({ tags: ['#vino', '#cantina'], summary: 'Come scegliere un barolo per la cena.' }),
      why({ tags: ['#vino'], summary: 'Il barolo spiegato in pochi minuti.' }),
      why({ tags: [], summary: 'Un altro post sul barolo e la sua storia.' }),
    ];
    expect(explainTheme(members).words).toEqual(['vino', 'cantina', 'barolo']);
  });

  it('use only the words that a quarter of the posts with a summary say, and at least two of them', () => {
    const members = [
      why({ summary: 'Cantina e barolo in Langa.' }), why({ summary: 'Barolo e nebbiolo, un confronto.' }), why({ summary: 'Il nebbiolo del Piemonte.' }),
      why({ summary: 'Altro vitigno raro e prezioso.' }), why({ summary: 'Qualcosa sulla degustazione guidata.' }), why({ summary: 'Ancora un tema diverso del tutto.' }),
      why({ summary: 'Un bicchiere di rosso fermo.' }), why({ summary: 'La vendemmia in collina.' }),
    ];
    // «barolo» and «nebbiolo» are in 2 of 8 posts = a quarter exactly: they count; the single words do not
    expect(explainTheme(members).words.sort()).toEqual(['barolo', 'nebbiolo']);
  });

  it('ignore the words that are too short, the numbers and the words of the grammar', () => {
    const members = Array.from({ length: 4 }, () => why({ summary: 'Il post parla di una cosa che con 2026 mostra anche questo video, con la sua.' }));
    expect(explainTheme(members).words).toEqual([]);
  });

  it('a quarter of ten posts is three: a word in two of them is not enough (the quarter is rounded up)', () => {
    const members = [
      why({ summary: 'Il barolo a cena.' }), why({ summary: 'Un barolo giovane.' }),
      ...['amaro', 'brano', 'corso', 'denso', 'esame', 'fiore', 'gatto', 'istmo'].map((word) => why({ summary: `${word}.` })),
    ];
    expect(explainTheme(members).words).toEqual([]);
  });

  it('never go over four, whatever the summaries repeat', () => {
    const members = [0, 1, 2].map(() => why({ tags: ['#vino', '#cantina'], summary: 'Alfa bravo charlie delta echo foxtrot golf hotel.' }));
    expect(explainTheme(members).words).toEqual(['cantina', 'vino', 'alfa', 'bravo']);
  });

  it('do not count the posts without a summary against the words', () => {
    const members = [
      why({ summary: 'Il barolo in cantina.' }), why({ summary: 'Un barolo giovane.' }),
      why({ summary: null }), why({ summary: null }), why({ summary: null }), why({ summary: null }), why({ summary: null }), why({ summary: null }),
    ];
    expect(explainTheme(members).words).toEqual(['barolo']);
  });

  it('count a word once for a post, even when the post repeats it', () => {
    const members = [why({ summary: 'Barolo barolo barolo.' }), why({ summary: 'Qualcosa diverso.' }), why({ summary: 'Altra cosa.' })];
    expect(explainTheme(members).words).toEqual([]);
  });

  it('put «vino» and «vini» together even when no post says the same one twice (one post each is two posts)', () => {
    const members = [why({ summary: 'Il vino rosso.' }), why({ summary: 'I vini bianchi.' }), why({ summary: 'Altro tema.' }), why({ summary: 'Altro ancora.' })];
    expect(explainTheme(members).words).toEqual(['vini']);   // one post each: the tie goes to the first in alphabetical order
  });

  it('say a word once whatever its ending: «vino» and «vini» are one, shown the way most posts write it', () => {
    const members = [why({ summary: 'Il vino rosso.' }), why({ summary: 'I vini bianchi.' }), why({ summary: 'Un vino leggero.' }), why({ summary: 'Altro vino buono.' })];
    expect(explainTheme(members).words).toEqual(['vino']);
  });

  it('do not repeat a tag as a word', () => {
    const members = [
      why({ tags: ['#vino', '#cantina'], summary: 'Il vino della cantina storica.' }), why({ tags: ['#vino', '#cantina'], summary: 'Il vino della cantina nuova.' }),
      why({ tags: [], summary: 'Un vino della cantina.' }),
    ];
    expect(explainTheme(members).words).toEqual(['cantina', 'vino']);   // two posts each: the tie goes by the alphabet
  });

  it('are lower case and keep the accents', () => {
    const members = [why({ summary: 'La qualità conta.' }), why({ summary: 'Una QUALITÀ rara.' })];
    expect(explainTheme(members).words).toEqual(['qualità']);
  });

  it('sort the words that tie by count, then in alphabetical order, so the answer does not wobble', () => {
    const members = [why({ summary: 'Zeta alfa.' }), why({ summary: 'Alfa zeta.' })];
    expect(explainTheme(members).words).toEqual(['alfa', 'zeta']);
  });

  it('are none for a theme whose posts say nothing in common', () => {
    expect(explainTheme([why({ summary: 'Uno.', tags: ['#a1'] }), why({ summary: 'Due.', tags: ['#b2'] })]).words).toEqual([]);
  });
});


// ---------------------------------------------------------------------------------------------------------------- the venues

const post = (id: string, createdAt: string, platform = 'instagram'): VenueEntryRef => ({ id, sourceUrl: `https://www.${platform}.com/p/${id}/`, sourcePlatform: platform, createdAt });
const posts = (...list: VenueEntryRef[]): Map<string, VenueEntryRef> => new Map(list.map((p) => [p.id, p]));
const vrow = (entryId: string, key: string, name: string, kind = 'restaurant', place: string | null = 'Milano'): EntryVenueRow => ({ entryId, key, name, kind, place });

describe('the venues of a collection', () => {
  it('are one row for each venue, with the posts that name it', () => {
    const venues = groupVenues([vrow('e1', 'trattoria dei navigli|milano', 'Trattoria dei Navigli')], posts(post('e1', ago(3))));
    expect(venues).toEqual([{
      key: 'trattoria dei navigli|milano', name: 'Trattoria dei Navigli', kind: 'restaurant', place: 'Milano',
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli%2C%20Milano',
      posts: [{ entryId: 'e1', sourceUrl: 'https://www.instagram.com/p/e1/', sourcePlatform: 'instagram', createdAt: ago(3) }],
    }]);
  });

  it('are ONE row when two posts name the same venue, with the two posts, the newest first (one thing = one entry)', () => {
    const rows = [vrow('old', 'bar luce|milano', 'Bar Luce', 'bar'), vrow('new', 'bar luce|milano', 'Bar Luce', 'bar'), vrow('mid', 'bar luce|milano', 'Bar Luce', 'bar')];
    const venues = groupVenues(rows, posts(post('old', ago(30)), post('new', ago(1)), post('mid', ago(10), 'tiktok')));
    expect(venues).toHaveLength(1);
    expect(venues[0].posts.map((p) => p.entryId)).toEqual(['new', 'mid', 'old']);
    expect(venues[0].posts[1]).toMatchObject({ sourcePlatform: 'tiktok', sourceUrl: 'https://www.tiktok.com/p/mid/' });
  });

  it('count a post once for a venue, however many rows say so', () => {
    const rows = [vrow('e1', 'k|', 'Bar', 'bar', null), vrow('e1', 'k|', 'Bar', 'bar', null)];
    expect(groupVenues(rows, posts(post('e1', ago(1))))[0].posts).toHaveLength(1);
  });

  it('say the post the way the card says it: a stray character in front of the address is dropped', () => {
    const odd: VenueEntryRef = { id: 'e1', sourceUrl: 'xhttps://www.instagram.com/p/abc/', sourcePlatform: 'instagram', createdAt: ago(1) };
    expect(groupVenues([vrow('e1', 'k|', 'Bar')], posts(odd))[0].posts[0].sourceUrl).toBe('https://www.instagram.com/p/abc/');
  });

  it('build the address of Maps here, from the name and the city: accents, apostrophe and ampersand encoded', () => {
    const venues = groupVenues([vrow('e1', "caffe dell'orto & c|forli", "Caffè dell'Orto & C.", 'cafe', 'Forlì')], posts(post('e1', ago(1))));
    expect(venues[0].mapsUrl).toBe('https://www.google.com/maps/search/?api=1&query=Caff%C3%A8%20dell%27Orto%20%26%20C.%2C%20Forl%C3%AC');
  });

  it('build it from the name alone when the venue has no city', () => {
    const venues = groupVenues([vrow('e1', 'rifugio monte rosa|', 'Rifugio Monte Rosa', 'refuge', null)], posts(post('e1', ago(1))));
    expect(venues[0].place).toBeNull();
    expect(venues[0].mapsUrl).toBe('https://www.google.com/maps/search/?api=1&query=Rifugio%20Monte%20Rosa');
  });

  it('are ordered by how many posts name them, then by name the way a person reads it, then by key', () => {
    const rows = [
      vrow('a', 'zeta|', 'Zeta', 'bar', null), vrow('a', 'alfa|', 'alfa', 'bar', null), vrow('b', 'alfa|', 'alfa', 'bar', null),
      vrow('a', 'bar x|', 'Bar X', 'bar', null), vrow('c', 'bar x|', 'Bar X', 'bar', null), vrow('b', 'bar x|', 'Bar X', 'bar', null),
      vrow('a', 'amico|', 'Àmico', 'bar', null),
    ];
    const venues = groupVenues(rows, posts(post('a', ago(1)), post('b', ago(2)), post('c', ago(3))));
    expect(venues.map((v) => v.key)).toEqual(['bar x|', 'alfa|', 'amico|', 'zeta|']);
  });

  it('call a venue what most of its posts call it, and its kind what most say (an «other» is no information)', () => {
    const rows = [
      vrow('a', 'k|milano', 'Da Gennaro', 'other'), vrow('b', 'k|milano', 'Pizzeria Da Gennaro', 'pizzeria'), vrow('c', 'k|milano', 'Pizzeria Da Gennaro', 'pizzeria'), vrow('d', 'k|milano', 'Pizzeria Da Gennaro', 'restaurant'),
    ];
    const [venue] = groupVenues(rows, posts(post('a', ago(1)), post('b', ago(2)), post('c', ago(3)), post('d', ago(4))));
    expect(venue.name).toBe('Pizzeria Da Gennaro');
    expect(venue.kind).toBe('pizzeria');
  });

  it('call a venue «other» only when no post says better, even if «other» is what most say', () => {
    const rows = [vrow('a', 'k|', 'Posto', 'other', null), vrow('b', 'k|', 'Posto', 'other', null), vrow('c', 'k|', 'Posto', 'bar', null)];
    expect(groupVenues(rows, posts(post('a', ago(1)), post('b', ago(2)), post('c', ago(3))))[0].kind).toBe('bar');
  });

  it('build the address from the name most posts use, not from the first or the last post', () => {
    const rows = [vrow('new', 'k|milano', 'Bar C'), vrow('mid', 'k|milano', 'Bar A'), vrow('old', 'k|milano', 'Bar B'), vrow('mid2', 'k|milano', 'Bar A')];
    const [venue] = groupVenues(rows, posts(post('new', ago(1)), post('mid', ago(2)), post('mid2', ago(3)), post('old', ago(4))));
    expect(venue.name).toBe('Bar A');
    expect(venue.mapsUrl).toBe('https://www.google.com/maps/search/?api=1&query=Bar%20A%2C%20Milano');
  });

  it('are ordered by key when the posts that cite them and their names are the same', () => {
    const rows = [vrow('a', 'bar|roma', 'Bar', 'bar', 'Roma'), vrow('a', 'bar|milano', 'Bar', 'bar', 'Milano')];
    expect(groupVenues(rows, posts(post('a', ago(1)))).map((v) => v.key)).toEqual(['bar|milano', 'bar|roma']);
  });

  it('go by the newest post when the posts do not agree on a name', () => {
    const rows = [vrow('old', 'k|milano', 'Osteria Vecchia'), vrow('new', 'k|milano', 'Osteria Nuova')];
    expect(groupVenues(rows, posts(post('old', ago(30)), post('new', ago(1))))[0].name).toBe('Osteria Nuova');
  });

  it('say the city most of the posts say, and none when only one post names it among many that do not', () => {
    const rows = [vrow('a', 'k|', 'Bar', 'bar', 'Milano'), vrow('b', 'k|', 'Bar', 'bar', null), vrow('c', 'k|', 'Bar', 'bar', null)];
    expect(groupVenues(rows, posts(post('a', ago(1)), post('b', ago(2)), post('c', ago(3))))[0].place).toBe('Milano');   // the one post that names it beats the two that do not
    const none = [vrow('a', 'k|', 'Bar', 'bar', null), vrow('b', 'k|', 'Bar', 'bar', null)];
    expect(groupVenues(none, posts(post('a', ago(1)), post('b', ago(2))))[0].place).toBeNull();
  });

  it('are ordered by name, not by key, when the posts that cite them are as many', () => {
    const rows = [vrow('a', 'z-key|', 'Alpha', 'bar', null), vrow('a', 'a-key|', 'Zulu', 'bar', null)];
    expect(groupVenues(rows, posts(post('a', ago(1)))).map((v) => v.name)).toEqual(['Alpha', 'Zulu']);
  });

  it('are «other» when no post says what kind it is', () => {
    expect(groupVenues([vrow('e1', 'k|', 'Posto', 'other', null)], posts(post('e1', ago(1))))[0].kind).toBe('other');
  });

  it('leave out a post the collection does not hold (nothing is invented), and a venue left with no post', () => {
    const rows = [vrow('known', 'a|', 'Alfa', 'bar', null), vrow('stranger', 'a|', 'Alfa', 'bar', null), vrow('stranger', 'b|', 'Beta', 'bar', null)];
    const venues = groupVenues(rows, posts(post('known', ago(1))));
    expect(venues.map((v) => [v.key, v.posts.map((p) => p.entryId)])).toEqual([['a|', ['known']]]);
  });

  it('are none when no post names one', () => {
    expect(groupVenues([], posts(post('e1', ago(1))))).toEqual([]);
  });
});


// ---------------------------------------------------------------------------------------------------------------- one collection

let rowSeq = 0;
const mrow = (id: string, over: Partial<MemberRow> = {}): MemberRow => ({
  id, sourceUrl: `https://www.instagram.com/reel/${id}/`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: `https://img.example/${id}.jpg`, status: 'completed',
  createdAt: ago(++rowSeq), summary: `Riassunto di ${id}`, songCount: 0, filmCount: 0, noteCount: 0, tags: [], score: 0.5, source: 'auto', ...over,
});
const prow = (entryId: string, name: string, kind: 'city' | 'region' | 'country' = 'city'): EntryPlaceRow => ({ entryId, name, kind });

interface DetailWorld extends World {
  rows?: MemberRow[];
  placeRows?: EntryPlaceRow[];
  venueRows?: EntryVenueRow[];
  chipThemes?: ChipThemeRow[];
  chipPlaces?: ChipPlaceRow[];
  songs?: Array<{ key: string; at: string }>;
}

/** Sources of one world, writing down what was asked of the ones that are asked about posts. */
function detailSources(world: DetailWorld = {}, log: { refs: MemberRef[]; placesOf: string[][]; venuesOf: string[][]; chipIds: string[][] } = { refs: [], placesOf: [], venuesOf: [], chipIds: [] }): DetailSources {
  return {
    ...sources(world),
    members: async (_user, ref) => { log.refs.push(ref); return world.rows ?? []; },
    placesOf: async (entryIds) => { log.placesOf.push(entryIds); return (world.placeRows ?? []).filter((p) => entryIds.includes(p.entryId)); },
    venuesOf: async (entryIds) => { log.venuesOf.push(entryIds); return (world.venueRows ?? []).filter((v) => entryIds.includes(v.entryId)); },
    chipThemes: async (_user, entryIds) => { log.chipIds.push(entryIds); return (world.chipThemes ?? []).filter((c) => entryIds.includes(c.entryId)); },
    chipPlaces: async (_user, entryIds) => (world.chipPlaces ?? []).filter((c) => entryIds.includes(c.entryId)),
    songs: async () => world.songs ?? [],
  };
}

const q = (over: Partial<DetailQuery> = {}): DetailQuery => ({ offset: 0, limit: 40, ...over });
const rowIds = (d: { entries: Array<{ id: string }> } | null): string[] => (d?.entries ?? []).map((e) => e.id);

describe('one collection', () => {
  describe('which one it is', () => {
    it('is a theme of the user: its line comes from its own posts', async () => {
      const world: DetailWorld = {
        themes: [theme('t1', { name: 'Vino', groupLabel: 'Cibo e bevande', createdAt: ago(3) })],
        rows: [mrow('a'), mrow('b'), mrow('c')],
      };
      const log = { refs: [] as MemberRef[], placesOf: [] as string[][], venuesOf: [] as string[][], chipIds: [] as string[][] };
      const detail = await collectionDetail('mike', 't1', q(), detailSources(world, log), NOW);
      expect(detail?.collection).toMatchObject({ id: 't1', name: 'Vino', kind: 'theme', group: 'Cibo e bevande', count: 3, isNew: true });
      expect(detail?.collection.defaultView).toBe('grid');
      expect(log.refs).toEqual([{ kind: 'theme', id: 't1' }]);
    });

    it('is a type: its posts are asked for by the type', async () => {
      const log = { refs: [] as MemberRef[], placesOf: [] as string[][], venuesOf: [] as string[][], chipIds: [] as string[][] };
      const detail = await collectionDetail('mike', 'type:films', q(), detailSources({ rows: [mrow('a', { filmCount: 1 })] }, log), NOW);
      expect(detail?.collection).toMatchObject({ id: 'type:films', name: 'Film e serie', kind: 'type', group: 'Tipi', count: 1 });
      expect(log.refs).toEqual([{ kind: 'type', type: 'type:films' }]);
    });

    it('is a place: its posts are asked for by the spellings of the place the user has', async () => {
      const log = { refs: [] as MemberRef[], placesOf: [] as string[][], venuesOf: [] as string[][], chipIds: [] as string[][] };
      const world: DetailWorld = { places: [placeFacts('Milano', 6), { name: 'milano', kind: 'region', entries: facts(3).map((f) => fact(`r-${f.id}`)) }, placeFacts('Roma', 12)], rows: facts(9).map((f) => mrow(f.id)) };
      const detail = await collectionDetail('mike', 'place:milano', q(), detailSources(world, log), NOW);
      expect(detail?.collection).toMatchObject({ id: 'place:milano', name: 'Milano', kind: 'place', group: 'Luoghi' });
      expect(log.refs).toEqual([{ kind: 'place', names: ['Milano', 'milano'] }]);
    });

    it('is not there for a country, whatever its posts (it is no collection)', async () => {
      const w: DetailWorld = { places: [placeFacts('Italia', 20, 'country')], rows: facts(20).map((f) => mrow(f.id)) };
      expect(await collectionDetail('mike', 'place:italia', q(), detailSources(w), NOW)).toBeNull();
    });

    it('is there for a place of exactly eight posts', async () => {
      const w: DetailWorld = { places: [placeFacts('Prato', 8)], rows: facts(8).map((f) => mrow(f.id)) };
      expect((await collectionDetail('mike', 'place:prato', q(), detailSources(w), NOW))?.collection.count).toBe(8);
    });

    it('is not there for an id that is none of them, a merged theme, a place with fewer than eight posts, a collection with no post', async () => {
      const world: DetailWorld = {
        themes: [theme('m', { state: 'merged' }), theme('empty')],
        places: [placeFacts('Prato', 7)],
        rows: [mrow('a')],
      };
      expect(await collectionDetail('mike', 'nope', q(), detailSources(world), NOW)).toBeNull();
      expect(await collectionDetail('mike', 'm', q(), detailSources(world), NOW)).toBeNull();
      expect(await collectionDetail('mike', 'place:prato', q(), detailSources(world), NOW)).toBeNull();
      expect(await collectionDetail('mike', 'type:podcasts', q(), detailSources(world), NOW)).toBeNull();
      expect(await collectionDetail('mike', 'empty', q(), detailSources({ ...world, rows: [] }), NOW)).toBeNull();
      expect(await collectionDetail('mike', 'type:books', q(), detailSources({ rows: [] }), NOW)).toBeNull();
    });

    it('does not read another user\'s theme: the rows are the ones of the user asking, so a foreign id is simply not there', async () => {
      const mine: DetailWorld = { themes: [theme('mine')], rows: [mrow('a')] };
      expect(await collectionDetail('sara', 'mine', q(), detailSources({ themes: [], rows: [] }), NOW)).toBeNull();
      expect(await collectionDetail('mike', 'mine', q(), detailSources(mine), NOW)).not.toBeNull();
    });

    it('a theme under observation is for the administrator only', async () => {
      const world: DetailWorld = { themes: [theme('w', { state: 'watching' })], rows: [mrow('a'), mrow('b'), mrow('c')] };
      expect(await collectionDetail('mike', 'w', q(), detailSources(world), NOW)).toBeNull();
      expect(await collectionDetail('mike', 'w', q(), detailSources(world), NOW, { includeWatching: true })).not.toBeNull();
    });

    it('a hidden theme can still be opened (the user hid it from the list, not from himself)', async () => {
      const world: DetailWorld = { themes: [theme('h', { state: 'hidden' })], rows: [mrow('a')] };
      expect((await collectionDetail('mike', 'h', q(), detailSources(world), NOW))?.collection.id).toBe('h');
    });

    it('has a parent only when that parent is an active theme', async () => {
      const world: DetailWorld = { themes: [theme('p'), theme('c', { parentId: 'p' }), theme('hp', { state: 'hidden' }), theme('c2', { parentId: 'hp' })], rows: [mrow('a')] };
      expect((await collectionDetail('mike', 'c', q(), detailSources(world), NOW))?.collection.parentId).toBe('p');
      expect((await collectionDetail('mike', 'c2', q(), detailSources(world), NOW))?.collection.parentId).toBeNull();
    });
  });

  describe('its posts', () => {
    const world = (): DetailWorld => ({
      themes: [theme('t')],
      rows: [
        mrow('a', { createdAt: '2026-11-09T10:00:00.000Z', sourcePlatform: 'instagram', summary: 'Un BAROLO della Langa', tags: ['#vino'] }),
        mrow('b', { createdAt: '2026-10-20T10:00:00.000Z', sourcePlatform: 'tiktok', summary: 'Il chianti del weekend', caption: 'cena con amici', tags: ['#toscana'] }),
        mrow('c', { createdAt: '2026-10-02T10:00:00.000Z', sourcePlatform: 'instagram', summary: null, caption: 'Perché il Nebbiolo è così', tags: [] }),
        mrow('d', { createdAt: '2026-09-15T10:00:00.000Z', sourcePlatform: 'youtube', summary: 'Una cantina in Sicilia', tags: ['#sicilia', '#vino'] }),
      ],
      placeRows: [prow('a', 'Alba'), prow('b', 'Firenze'), prow('c', 'Alba'), prow('d', 'Palermo')],
    });

    it('come newest first, with the total, as the summary rows of the entries list', async () => {
      const detail = await collectionDetail('mike', 't', q(), detailSources(world()), NOW);
      expect(rowIds(detail)).toEqual(['a', 'b', 'c', 'd']);
      expect(detail?.total).toBe(4);
      expect(Object.keys(detail?.entries[0] ?? {}).sort()).toEqual([
        'caption', 'collections', 'createdAt', 'filmCount', 'id', 'noteCount', 'songCount', 'sourcePlatform', 'sourceUrl', 'status', 'summary', 'tags', 'thumbnailUrl',
      ]);
    });

    it('come newest first even when the source gives them in another order', async () => {
      const w = world();
      w.rows = [...(w.rows as MemberRow[])].reverse();
      expect(rowIds(await collectionDetail('mike', 't', q(), detailSources(w), NOW))).toEqual(['a', 'b', 'c', 'd']);
    });

    it('are a page: the limit and the offset, and the total is of all of them', async () => {
      const detail = await collectionDetail('mike', 't', q({ offset: 1, limit: 2 }), detailSources(world()), NOW);
      expect(rowIds(detail)).toEqual(['b', 'c']);
      expect(detail?.total).toBe(4);
      expect(rowIds(await collectionDetail('mike', 't', q({ offset: 3, limit: 40 }), detailSources(world()), NOW))).toEqual(['d']);
      expect(rowIds(await collectionDetail('mike', 't', q({ offset: 9, limit: 40 }), detailSources(world()), NOW))).toEqual([]);
    });

    it('can be narrowed to a platform (the case and the spaces around it do not matter)', async () => {
      const detail = await collectionDetail('mike', 't', q({ fonte: 'TikTok' }), detailSources(world()), NOW);
      expect(rowIds(detail)).toEqual(['b']);
      expect(detail?.total).toBe(1);
      expect(rowIds(await collectionDetail('mike', 't', q({ fonte: '  tiktok ' }), detailSources(world()), NOW))).toEqual(['b']);
    });

    it('can be narrowed to a month (the month of the date of the post, in UTC)', async () => {
      expect(rowIds(await collectionDetail('mike', 't', q({ quando: '2026-10' }), detailSources(world()), NOW))).toEqual(['b', 'c']);
      expect(rowIds(await collectionDetail('mike', 't', q({ quando: '2026-08' }), detailSources(world()), NOW))).toEqual([]);
    });

    it('a post saved at the very end of a month in UTC belongs to that month', async () => {
      const w = world();
      w.rows = [mrow('edge', { createdAt: '2026-10-31T23:59:59.999Z' }), mrow('next', { createdAt: '2026-11-01T00:00:00.000Z' })];
      expect(rowIds(await collectionDetail('mike', 't', q({ quando: '2026-10' }), detailSources(w), NOW))).toEqual(['edge']);
    });

    it('can be narrowed to a place the post names (no case, no accents)', async () => {
      const detail = await collectionDetail('mike', 't', q({ dove: 'alba' }), detailSources(world()), NOW);
      expect(rowIds(detail)).toEqual(['a', 'c']);
      expect(rowIds(await collectionDetail('mike', 't', q({ dove: 'Roma' }), detailSources(world()), NOW))).toEqual([]);
    });

    it('can be searched: every word must be in the summary, the caption or the tags, in any order, without case or accents', async () => {
      expect(rowIds(await collectionDetail('mike', 't', q({ q: 'langa barolo' }), detailSources(world()), NOW))).toEqual(['a']);
      expect(rowIds(await collectionDetail('mike', 't', q({ q: 'PERCHE nebbiolo' }), detailSources(world()), NOW))).toEqual(['c']);
      expect(rowIds(await collectionDetail('mike', 't', q({ q: 'vino' }), detailSources(world()), NOW))).toEqual(['a', 'd']);
      expect(rowIds(await collectionDetail('mike', 't', q({ q: 'cena' }), detailSources(world()), NOW))).toEqual(['b']);
      expect(rowIds(await collectionDetail('mike', 't', q({ q: 'barolo sicilia' }), detailSources(world()), NOW))).toEqual([]);
    });

    it('a search with nothing to search for (only signs) is no search', async () => {
      expect(rowIds(await collectionDetail('mike', 't', q({ q: '  #  ' }), detailSources(world()), NOW))).toHaveLength(4);
      expect(rowIds(await collectionDetail('mike', 't', q({ q: '' }), detailSources(world()), NOW))).toHaveLength(4);
    });

    it('the filters are combined, and the paging follows them', async () => {
      const detail = await collectionDetail('mike', 't', q({ fonte: 'instagram', dove: 'Alba', limit: 1 }), detailSources(world()), NOW);
      expect(rowIds(detail)).toEqual(['a']);
      expect(detail?.total).toBe(2);
    });

    it('do not carry the score or where they came from: that is the server\'s business', async () => {
      const detail = await collectionDetail('mike', 't', q(), detailSources(world()), NOW);
      expect(detail?.entries[0]).not.toHaveProperty('score');
      expect(detail?.entries[0]).not.toHaveProperty('source');
    });
  });

  describe('its facets', () => {
    const world = (): DetailWorld => ({
      themes: [theme('t')],
      rows: [
        mrow('a', { createdAt: '2026-11-09T10:00:00.000Z', sourcePlatform: 'instagram' }),
        mrow('b', { createdAt: '2026-11-02T10:00:00.000Z', sourcePlatform: 'tiktok' }),
        mrow('c', { createdAt: '2026-10-20T10:00:00.000Z', sourcePlatform: 'instagram' }),
        mrow('d', { createdAt: '2026-10-01T10:00:00.000Z', sourcePlatform: 'instagram' }),
        mrow('e', { createdAt: '2025-12-31T10:00:00.000Z', sourcePlatform: 'youtube' }),
      ],
      placeRows: [prow('a', 'Milano'), prow('b', 'Milano'), prow('c', 'Milano'), prow('d', 'Roma'), prow('e', 'Lombardia', 'region'), prow('a', 'Lombardia', 'region')],
    });

    it('«where» lists the places that at least two posts name, the most named first', async () => {
      const detail = await collectionDetail('mike', 't', q(), detailSources(world()), NOW);
      expect(detail?.facets.places).toEqual([{ name: 'Milano', count: 3 }, { name: 'Lombardia', count: 2 }]);
      expect(COLLECTION_VIEW.placeFacetMin).toBe(2);
    });

    it('«where» puts the places that tie in alphabetical order', async () => {
      const w = world();
      w.placeRows = [prow('a', 'Roma'), prow('b', 'Roma'), prow('c', 'Alba'), prow('d', 'Alba')];
      expect((await collectionDetail('mike', 't', q(), detailSources(w), NOW))?.facets.places).toEqual([{ name: 'Alba', count: 2 }, { name: 'Roma', count: 2 }]);
    });

    it('«where» counts a post once for a place, even when the store has the place twice for it (a city and a region of the same name)', async () => {
      const w = world();
      w.placeRows = [prow('a', 'Milano', 'city'), prow('a', 'Milano', 'region')];
      expect((await collectionDetail('mike', 't', q(), detailSources(w), NOW))?.facets.places).toEqual([]);
    });

    it('«source» leaves out a post that has no platform', async () => {
      const w = world();
      w.rows = [mrow('a', { sourcePlatform: '' }), mrow('b', { sourcePlatform: 'tiktok' })];
      expect((await collectionDetail('mike', 't', q(), detailSources(w), NOW))?.facets.sources).toEqual([{ platform: 'tiktok', count: 1 }]);
    });

    it('«where» is the same for a place that is named by one post only: it is not offered', async () => {
      const w = world();
      w.placeRows = [prow('a', 'Roma')];
      expect((await collectionDetail('mike', 't', q(), detailSources(w), NOW))?.facets.places).toEqual([]);
    });

    it('«source» lists every platform, the most used first', async () => {
      const detail = await collectionDetail('mike', 't', q(), detailSources(world()), NOW);
      expect(detail?.facets.sources).toEqual([{ platform: 'instagram', count: 3 }, { platform: 'tiktok', count: 1 }, { platform: 'youtube', count: 1 }]);
    });

    it('«when» lists the months of the posts, the newest month first', async () => {
      const detail = await collectionDetail('mike', 't', q(), detailSources(world()), NOW);
      expect(detail?.facets.months).toEqual([{ month: '2026-11', count: 2 }, { month: '2026-10', count: 2 }, { month: '2025-12', count: 1 }]);
    });

    it('are counted on ALL the posts of the collection, not on the ones a filter leaves (so the user can still pick another)', async () => {
      const detail = await collectionDetail('mike', 't', q({ fonte: 'youtube' }), detailSources(world()), NOW);
      expect(detail?.total).toBe(1);
      expect(detail?.facets.sources).toHaveLength(3);
      expect(detail?.facets.months).toHaveLength(3);
    });

    it('«where» of a place collection leaves out the place itself (every post names it: it would filter nothing)', async () => {
      const w: DetailWorld = {
        places: [placeFacts('Milano', 9)],
        rows: facts(9).map((f) => mrow(f.id)),
        placeRows: [...facts(9).map((f) => prow(f.id, 'Milano')), prow('e0', 'Lombardia', 'region'), prow('e1', 'Lombardia', 'region')],
      };
      const detail = await collectionDetail('mike', 'place:milano', q(), detailSources(w), NOW);
      expect(detail?.facets.places).toEqual([{ name: 'Lombardia', count: 2 }]);
    });

    it('a post without a date is in no month', async () => {
      const w: DetailWorld = { themes: [theme('t')], rows: [mrow('a', { createdAt: 'not a date' }), mrow('b', { createdAt: '2026-11-02T10:00:00.000Z' })] };
      expect((await collectionDetail('mike', 't', q(), detailSources(w), NOW))?.facets.months).toEqual([{ month: '2026-11', count: 1 }]);
    });
  });

  describe('its venues', () => {
    it('are those of ALL its posts (not only the page, not only the ones a filter leaves), one row each', async () => {
      const w: DetailWorld = {
        themes: [theme('t')],
        rows: [mrow('a', { sourcePlatform: 'instagram' }), mrow('b', { sourcePlatform: 'tiktok' }), mrow('c')],
        venueRows: [vrow('a', 'bar luce|milano', 'Bar Luce', 'bar'), vrow('b', 'bar luce|milano', 'Bar Luce', 'bar'), vrow('c', 'da gennaro|milano', 'Da Gennaro', 'pizzeria')],
      };
      const log = { refs: [] as MemberRef[], placesOf: [] as string[][], venuesOf: [] as string[][], chipIds: [] as string[][] };
      const detail = await collectionDetail('mike', 't', q({ fonte: 'tiktok', limit: 1 }), detailSources(w, log), NOW);
      expect(detail?.venues.map((v) => [v.key, v.posts.length])).toEqual([['bar luce|milano', 2], ['da gennaro|milano', 1]]);
      expect(log.venuesOf).toEqual([['a', 'b', 'c']]);
      expect(detail?.venues[0].mapsUrl).toBe('https://www.google.com/maps/search/?api=1&query=Bar%20Luce%2C%20Milano');
    });

    it('are none when the posts name none', async () => {
      expect((await collectionDetail('mike', 't', q(), detailSources({ themes: [theme('t')], rows: [mrow('a')] }), NOW))?.venues).toEqual([]);
    });
  });

  describe('«why»', () => {
    it('is the words and the typical posts of a theme', async () => {
      const w: DetailWorld = {
        themes: [theme('t')],
        rows: [
          mrow('a', { score: 0.9, tags: ['#vino', '#cantina'], summary: null }), mrow('b', { score: 0.8, tags: ['#vino', '#cantina'], summary: null }), mrow('c', { score: 0.1, tags: [], summary: null }),
        ],
      };
      const detail = await collectionDetail('mike', 't', q(), detailSources(w), NOW);
      expect(detail?.why).toEqual({ words: ['cantina', 'vino'], entryIds: ['a', 'b'] });
    });

    it('is empty for a type and for a place: they are not a subject somebody found', async () => {
      const type = await collectionDetail('mike', 'type:films', q(), detailSources({ rows: [mrow('a', { tags: ['#x1', '#x1'] }), mrow('b', { tags: ['#x1'] })] }), NOW);
      expect(type?.why).toEqual({ words: [], entryIds: [] });
      const place = await collectionDetail('mike', 'place:milano', q(), detailSources({ places: [placeFacts('Milano', 9)], rows: facts(9).map((f) => mrow(f.id, { tags: ['#x1'] })) }), NOW);
      expect(place?.why).toEqual({ words: [], entryIds: [] });
    });

    it('is made on ALL the posts, whatever the filters', async () => {
      const w: DetailWorld = { themes: [theme('t')], rows: [mrow('a', { tags: ['#vino'], sourcePlatform: 'tiktok', summary: null }), mrow('b', { tags: ['#vino'], sourcePlatform: 'instagram', summary: null })] };
      expect((await collectionDetail('mike', 't', q({ fonte: 'tiktok' }), detailSources(w), NOW))?.why.words).toEqual(['vino']);
    });
  });

  describe('the chips of its posts', () => {
    it('are asked ONCE, for the posts of the page only', async () => {
      const w: DetailWorld = { themes: [theme('t')], rows: [mrow('a'), mrow('b'), mrow('c')], chipThemes: [{ entryId: 'b', id: 'x', name: 'Viaggi', parentId: null, score: 0.5 }] };
      const log = { refs: [] as MemberRef[], placesOf: [] as string[][], venuesOf: [] as string[][], chipIds: [] as string[][] };
      const detail = await collectionDetail('mike', 't', q({ offset: 1, limit: 1 }), detailSources(w, log), NOW);
      expect(log.chipIds).toEqual([[detail?.entries[0].id]]);
      expect(detail?.entries[0].collections).toEqual([{ id: 'x', name: 'Viaggi' }]);
    });

    it('are an empty list for a post with none', async () => {
      const detail = await collectionDetail('mike', 't', q(), detailSources({ themes: [theme('t')], rows: [mrow('a')] }), NOW);
      expect(detail?.entries[0].collections).toEqual([]);
    });

    it('have the open theme among them, so the page can always take a post out of it', async () => {
      const w: DetailWorld = {
        themes: [theme('t')],
        rows: [mrow('a')],
        chipThemes: [
          { entryId: 'a', id: 't', name: 'Vino', parentId: null, score: 0.1 }, { entryId: 'a', id: 'x', name: 'Viaggi', parentId: null, score: 0.9 }, { entryId: 'a', id: 'y', name: 'Casa', parentId: null, score: 0.8 },
        ],
      };
      expect((await collectionDetail('mike', 't', q(), detailSources(w), NOW))?.entries[0].collections.map((c) => c.id)).toEqual(['t', 'x']);
    });

    it('a failure to read them costs the chips only: the posts are answered without (and the failure is logged)', async () => {
      const w: DetailWorld = { themes: [theme('t')], rows: [mrow('a')] };
      const src = { ...detailSources(w), chipThemes: async () => { throw new Error('chips broke'); } };
      const detail = await collectionDetail('mike', 't', q(), src, NOW);
      expect(rowIds(detail)).toEqual(['a']);
      expect(detail?.entries[0].collections).toEqual([]);
    });
  });

  describe('«play» (the music)', () => {
    const musicWorld = (): DetailWorld => ({
      rows: [mrow('a', { songCount: 2 })],
      songs: [
        { key: 'b::two', at: '2026-11-02T10:00:00.000Z' }, { key: 'a::one', at: '2026-11-09T10:00:00.000Z' }, { key: 'c::three', at: '2026-11-02T10:00:00.000Z' }, { key: 'd::four', at: 'not a date' },
      ],
    });

    it('carries the keys of the songs, the newest first, a tie by key, a song with no readable date at the end', async () => {
      const detail = await collectionDetail('mike', 'type:music', q(), detailSources(musicWorld()), NOW);
      expect(detail?.songKeys).toEqual(['a::one', 'b::two', 'c::three', 'd::four']);
      expect(detail?.collection.views).toEqual(['play', 'list']);
    });

    it('carries at most 500', async () => {
      const w = musicWorld();
      w.songs = Array.from({ length: 650 }, (_, i) => ({ key: `k::${String(i).padStart(3, '0')}`, at: ago(i + 1) }));
      const detail = await collectionDetail('mike', 'type:music', q(), detailSources(w), NOW);
      expect(detail?.songKeys).toHaveLength(500);
      expect(detail?.songKeys?.[0]).toBe('k::000');
      expect(COLLECTION_VIEW.songKeysMax).toBe(500);
    });

    it('is only for the music: any other collection has no `songKeys` at all', async () => {
      const detail = await collectionDetail('mike', 'type:films', q(), detailSources({ ...musicWorld() }), NOW);
      expect(detail).not.toBeNull();
      expect(Object.keys(detail ?? {})).not.toContain('songKeys');
      const theme1 = await collectionDetail('mike', 't', q(), detailSources({ ...musicWorld(), themes: [theme('t')] }), NOW);
      expect(Object.keys(theme1 ?? {})).not.toContain('songKeys');
    });

    it('a failure to read the songs costs «play» only: the page still comes, and says nothing to play', async () => {
      const src = { ...detailSources(musicWorld()), songs: async () => { throw new Error('songs broke'); } };
      const detail = await collectionDetail('mike', 'type:music', q(), src, NOW);
      expect(rowIds(detail)).toEqual(['a']);
      expect(detail?.songKeys).toEqual([]);
    });
  });

  it('asks the places of ALL the posts of the collection at once (the facets and the filter need them all)', async () => {
    const log = { refs: [] as MemberRef[], placesOf: [] as string[][], venuesOf: [] as string[][], chipIds: [] as string[][] };
    await collectionDetail('mike', 't', q({ limit: 1 }), detailSources({ themes: [theme('t')], rows: [mrow('a'), mrow('b'), mrow('c')] }, log), NOW);
    expect(log.placesOf).toEqual([['a', 'b', 'c']]);
  });

  it('a source that fails fails the detail (the route answers 500; nothing half built is sent)', async () => {
    const src = { ...detailSources({ themes: [theme('t')], rows: [mrow('a')] }), members: async () => { throw new Error('db down'); } };
    await expect(collectionDetail('mike', 't', q(), src, NOW)).rejects.toThrow('db down');
  });
});
