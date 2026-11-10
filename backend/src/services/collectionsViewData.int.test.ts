import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../utils/db';
import { PgCollectionsStore } from './collectionsStore';
import { entryVisibleTo, placesAndVenuesOfEntry, realViewSources, withCollectionChips } from './collectionsViewData';
import { chipsForEntries, collectionDetail, collectionList, findCollection } from './collectionsView';
import { buildWebHome } from './webHome';
import { realWebHomeDeps } from './webHomeData';

// The REAL SQL of the view layer, on a real Postgres. Only behind COLLECTIONS_INT=1 and only on a scratch database (recipe of
// collectionsStore.int.test.ts):
//
//   COLLECTIONS_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=collections_check DB_USER=postgres DB_PASSWORD=… \
//     npx vitest run --no-file-parallelism src/services/collectionsViewData.int.test.ts
//
// The database must already have init.sql and the migrations. Everything these tests make has an id or a user that begins with `vtest_` and is
// removed by that prefix; the test refuses the database that is called `soundreel`.

const on = process.env.COLLECTIONS_INT === '1';
if (on && (!process.env.DB_NAME || process.env.DB_NAME === 'soundreel')) {
  throw new Error('COLLECTIONS_INT=1 needs a scratch DB_NAME (never the real one)');
}
const d = on ? describe : describe.skip;

const MIKE = 'vtest_mike';
const SARA = 'vtest_sara';
const ARCHI = 'vtest_archi';
const id = (s: string): string => `vtest_vd_${s}`;
const NOW = new Date();
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 3600 * 1000);

interface EntrySpec {
  id: string;
  owner: string;
  days: number;
  platform?: string;
  thumb?: string | null;
  caption?: string | null;
  results: unknown;
}

const results = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ songs: [], films: [], notes: [], software: [], links: [], tags: [], summary: null, ...over });
const song = (title: string, artist = 'A') => ({ title, artist, album: null, source: 'ai_analysis' });

const ENTRIES: EntrySpec[] = [
  { id: 'e1', owner: MIKE, days: 1, platform: 'instagram', thumb: 'https://img.example/e1.jpg', results: results({ summary: 'Un barolo della Langa', tags: ['#vino', '#tag'], songs: [song('One'), song('Two')], notes: [{ text: 'Alba', category: 'place' }] }) },
  { id: 'e2', owner: MIKE, days: 2, platform: 'tiktok', thumb: null, caption: 'una didascalia', results: results({ summary: 'Un film', films: [{ title: 'Dune' }], notes: [{ text: 'Un libro', category: 'book' }] }) },
  { id: 'e3', owner: MIKE, days: 3, platform: 'youtube', thumb: 'https://img.example/e3.jpg', results: results({ summary: 'Uno strumento', software: [{ title: 'Tool', url: null, tag: 'product' }] }) },
  { id: 'e4', owner: SARA, days: 4, platform: 'instagram', thumb: 'https://img.example/e4.jpg', results: results({ summary: 'Condiviso da Sara', songs: [song('Shared', 'B')] }) },
  { id: 'e5', owner: ARCHI, days: 5, platform: 'instagram', thumb: 'https://img.example/e5.jpg', results: results({ summary: 'Di Archimede', songs: [song('Secret', 'C')] }) },
  // a stored value is not schema-checked (the search vector of the table refuses a list that is not a list, but not `software`, nor what is in a list):
  // none of these may break a question
  { id: 'e6', owner: MIKE, days: 6, thumb: null, results: results({ summary: 'Risultati rotti', software: 'no' }) },
  { id: 'e7', owner: MIKE, days: 7, thumb: null, results: results({ summary: 'Note strane', notes: ['place', null, 5, { text: 'Roma', category: 'place' }] }) },
  { id: 'e9', owner: MIKE, days: 9, thumb: null, results: { summary: 'Senza nessuna lista' } },
  { id: 'e8', owner: 'anonymous', days: 8, thumb: null, results: results({ summary: 'Di nessuno', songs: [song('Orphan', 'D')] }) },
  ...Array.from({ length: 8 }, (_, i): EntrySpec => ({
    id: `p${i + 1}`, owner: MIKE, days: 10 + i, platform: 'instagram', thumb: i % 2 === 0 ? `https://img.example/p${i + 1}.jpg` : null,
    results: results({ summary: `Post di Milano numero ${i + 1}`, tags: ['#milano', '#cantina'] }),
  })),
  ...Array.from({ length: 7 }, (_, i): EntrySpec => ({ id: `q${i + 1}`, owner: MIKE, days: 30 + i, results: results({ summary: `Post di Prato numero ${i + 1}` }) })),
  ...Array.from({ length: 3 }, (_, i): EntrySpec => ({ id: `a${i + 1}`, owner: ARCHI, days: 20 + i, results: results({ summary: `Post di Archimede a Milano ${i + 1}` }) })),
];

const store = new PgCollectionsStore();
const src = realViewSources();

async function clean(): Promise<void> {
  await pool.query("DELETE FROM collections WHERE owner_user LIKE 'vtest\\_%'");
  await pool.query("DELETE FROM entry_shares WHERE entry_id LIKE 'vtest\\_%'");
  await pool.query("DELETE FROM entries WHERE id LIKE 'vtest\\_%'");
}

async function collection(spec: { id: string; owner?: string; name: string; state?: string; group?: string | null; parent?: string | null; days?: number }): Promise<void> {
  await pool.query(
    `INSERT INTO collections (id, owner_user, name, group_label, parent_id, state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [id(spec.id), spec.owner ?? MIKE, spec.name, spec.group ?? null, spec.parent ? id(spec.parent) : null, spec.state ?? 'active', daysAgo(spec.days ?? 60)],
  );
}

async function member(collectionId: string, entry: string, score: number, source = 'auto'): Promise<void> {
  await pool.query('INSERT INTO collection_entries (collection_id, entry_id, score, source) VALUES ($1, $2, $3, $4)', [id(collectionId), id(entry), score, source]);
}

beforeAll(async () => {
  if (!on) return;
  await clean();
  for (const e of ENTRIES) {
    await pool.query(
      `INSERT INTO entries (id, source_url, source_platform, input_channel, status, created_at, owner_user, caption, thumbnail_url, results)
       VALUES ($1, $2, $3, 'web', 'completed', $4, $5, $6, $7, $8::jsonb)`,
      [id(e.id), `https://example.test/${e.id}`, e.platform ?? 'instagram', daysAgo(e.days), e.owner, e.caption ?? null, e.thumb ?? null, JSON.stringify(e.results)],
    );
  }
  // sara shares her post with mike; nobody shares archi's
  await pool.query(`INSERT INTO entry_shares (entry_id, shared_with, shared_by) VALUES ($1, $2, $3)`, [id('e4'), MIKE, SARA]);

  // places: Milano is named by eight posts of mike (and three of archi's that mike cannot see), Prato by seven, Alba by one, a region by two
  const place = (entry: string, name: string, kind: string) => pool.query('INSERT INTO entry_places (entry_id, place, kind) VALUES ($1, $2, $3)', [id(entry), name, kind]);
  for (let i = 1; i <= 8; i++) await place(`p${i}`, 'Milano', 'city');
  for (let i = 1; i <= 3; i++) await place(`a${i}`, 'Milano', 'city');
  for (let i = 1; i <= 7; i++) await place(`q${i}`, 'Prato', 'city');
  for (let i = 1; i <= 2; i++) await place(`a${i}`, 'Prato', 'city');   // seven posts mike reads + two he cannot: nine in all, still no collection for him
  await place('e1', 'Alba', 'city');
  await place('p1', 'Lombardia', 'region');
  await place('p2', 'Lombardia', 'region');

  await pool.query(
    `INSERT INTO entry_venues (entry_id, venue_key, name, kind, place) VALUES ($1, 'bar luce|milano', 'Bar Luce', 'bar', 'Milano'), ($2, 'bar luce|milano', 'Bar Luce', 'bar', 'Milano'), ($2, 'da gennaro|milano', 'Da Gennaro', 'pizzeria', 'Milano')`,
    [id('p1'), id('p2')],
  );

  // themes of mike: Vino (new, active), a hidden one, one under observation, a merged one, and Cantine (a child of Vino); one of sara's
  await collection({ id: 't1', name: 'Vino', group: 'Cibo e bevande', days: 3 });
  await collection({ id: 't2', name: 'Nascosta', state: 'hidden' });
  await collection({ id: 't3', name: 'Osservata', state: 'watching' });
  await collection({ id: 't4', name: 'Fusa', state: 'merged', parent: 't1' });
  await collection({ id: 't5', name: 'Cantine', parent: 't1', days: 30 });
  await collection({ id: 's1', owner: SARA, name: 'Di Sara' });
  await member('t1', 'e1', 0.9);
  await member('t1', 'e2', 0.5);
  await member('t1', 'e3', 1, 'user_add');
  await member('t1', 'e4', 0.4);              // shared with mike: his to see
  await member('t1', 'e5', 0.8);              // archi's, not shared: never his
  await member('t1', 'e6', 0, 'user_remove'); // taken out by hand
  await member('t2', 'e1', 0.9);
  await member('t3', 'e2', 0.9);
  await member('t4', 'e3', 1, 'user_add');
  await member('t5', 'e1', 0.7);
  for (let i = 1; i <= 4; i++) await member('t5', `p${i}`, 0.6);
  await member('s1', 'e4', 0.9);
});

afterAll(async () => {
  if (on) await clean();
  await pool.end();
});

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);
const un = (list: string[]): string[] => list.map((s) => s.replace('vtest_vd_', ''));

d('the posts of every type, on a real database', () => {
  it('are sorted into the types by what the results hold: what mike owns and what is shared with him, nothing else', async () => {
    const types = await src.typeEntries(MIKE);
    expect(un(ids(types['type:music'] ?? [])).sort()).toEqual(['e1', 'e4']);   // not e5 (archi's), not e8 (anonymous's), not e6 (a string is no list)
    expect(un(ids(types['type:films'] ?? []))).toEqual(['e2']);
    expect(un(ids(types['type:software'] ?? []))).toEqual(['e3']);
    expect(un(ids(types['type:places'] ?? [])).sort()).toEqual(['e1', 'e7']);   // a note of the place; a string «place» in a list of notes is not one
    expect(un(ids(types['type:books'] ?? []))).toEqual(['e2']);
  });

  it('come newest first, with their picture and their date', async () => {
    const music = (await src.typeEntries(MIKE))['type:music'] ?? [];
    expect(un(ids(music))).toEqual(['e1', 'e4']);
    expect(music[0].thumbnailUrl).toBe('https://img.example/e1.jpg');
    expect(Date.parse(music[0].createdAt)).toBeGreaterThan(Date.parse(music[1].createdAt));
  });

  it('are another user\'s own: sara sees hers, not mike\'s', async () => {
    const types = await src.typeEntries(SARA);
    expect(un(ids(types['type:music'] ?? []))).toEqual(['e4']);
    expect(types['type:films']).toBeUndefined();
  });

  it('are nothing for a user with no post, and for an administrator no more than for anyone', async () => {
    expect(await src.typeEntries('vtest_nobody')).toEqual({});
    // the anonymous post (e8) is visible to no family user: there is no administrator clause in the collections
    expect(un(ids((await src.typeEntries(MIKE))['type:music'] ?? []))).not.toContain('e8');
  });
});

d('the places, on a real database', () => {
  it('are grouped by name and kind with the posts mike can read: the three of archi\'s are not counted', async () => {
    const places = await src.placeEntries(MIKE);
    const by = (name: string, kind: string) => places.find((p) => p.name === name && p.kind === kind);
    expect(by('Milano', 'city')?.entries).toHaveLength(8);
    expect(by('Prato', 'city')?.entries).toHaveLength(7);
    expect(by('Lombardia', 'region')?.entries).toHaveLength(2);
    expect(un(ids(by('Alba', 'city')?.entries ?? []))).toEqual(['e1']);
  });

  it('are what the user\'s list shows as collections from eight posts: Milano is one, Prato (seven) is not', async () => {
    const list = await collectionList(MIKE, 'active', src, NOW);
    expect(ids(list)).toContain('place:milano');
    expect(ids(list)).not.toContain('place:prato');
    expect(list.find((c) => c.id === 'place:milano')).toMatchObject({ name: 'Milano', kind: 'place', group: 'Luoghi', count: 8 });
  });
});

d('the themes, on a real database', () => {
  it('are the rows of the user, in every state, and nobody else\'s', async () => {
    const mike = await src.themeRows(MIKE);
    expect(un(ids(mike)).sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(mike.find((t) => t.id === id('t1'))).toMatchObject({ name: 'Vino', nameBy: 'auto', groupLabel: 'Cibo e bevande', parentId: null, state: 'active' });
    expect(mike.find((t) => t.id === id('t5'))?.parentId).toBe(id('t1'));
    expect(un(ids(await src.themeRows(SARA)))).toEqual(['s1']);
  });

  it('have their live posts: not the one taken out by hand, not the one mike cannot read, yes the one put in by hand and the one shared with him', async () => {
    const members = await src.themeMembers(MIKE);
    expect(un(ids(members[id('t1')])).sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(un(ids(members[id('t5')])).sort()).toEqual(['e1', 'p1', 'p2', 'p3', 'p4']);
    expect(members[id('t2')]).toHaveLength(1);
  });

  it('never carry the posts of a merged theme or the ones of another user\'s theme', async () => {
    const members = await src.themeMembers(MIKE);
    expect(members[id('t4')]).toBeUndefined();
    expect(members[id('s1')]).toBeUndefined();
  });

  it('are listed: the active ones in the list, the hidden ones apart, the ones under observation apart, the merged one nowhere', async () => {
    const active = await collectionList(MIKE, 'active', src, NOW);
    expect(un(ids(active.filter((c) => c.kind === 'theme')))).toEqual(['t1', 't5']);
    expect(un(ids(await collectionList(MIKE, 'hidden', src, NOW)))).toEqual(['t2']);
    expect(un(ids(await collectionList(MIKE, 'watching', src, NOW)))).toEqual(['t3']);
    expect(await findCollection(MIKE, id('t4'), src, NOW)).toBeNull();
  });

  it('are listed with their own count, the new one first, the child with its parent, the types before them all', async () => {
    const list = await collectionList(MIKE, 'active', src, NOW);
    expect(ids(list.filter((c) => c.kind === 'type'))).toEqual(['type:music', 'type:films', 'type:software', 'type:places', 'type:books']);
    expect(list.find((c) => c.id === id('t1'))).toMatchObject({ name: 'Vino', count: 4, isNew: true, parentId: null, group: 'Cibo e bevande' });
    expect(list.find((c) => c.id === id('t5'))).toMatchObject({ name: 'Cantine', count: 5, isNew: false, parentId: id('t1') });
    expect(ids(list.filter((c) => c.kind !== 'type'))).toEqual([id('t1'), 'place:milano', id('t5')]);
  });

  it('are another user\'s own: sara\'s list has her theme and none of mike\'s', async () => {
    const sara = await collectionList(SARA, 'active', src, NOW);
    expect(ids(sara.filter((c) => c.kind === 'theme'))).toEqual([id('s1')]);
    expect(await findCollection(SARA, id('t1'), src, NOW)).toBeNull();
    expect(await collectionDetail(SARA, id('t1'), { offset: 0, limit: 40 }, src, NOW)).toBeNull();
  });
});

d('one collection, on a real database', () => {
  const page = { offset: 0, limit: 40 };

  it('a theme answers its live posts newest first, the summary rows of the list of entries, with who put them there', async () => {
    const detail = await collectionDetail(MIKE, id('t1'), page, src, NOW);
    expect(un((detail?.entries ?? []).map((e) => e.id))).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(detail?.total).toBe(4);
    const first = detail?.entries[0];
    expect(first).toMatchObject({ summary: 'Un barolo della Langa', sourcePlatform: 'instagram', songCount: 2, filmCount: 0, noteCount: 1, thumbnailUrl: 'https://img.example/e1.jpg', status: 'completed' });
    expect(first?.tags).toEqual(['#vino', '#tag']);
    expect(first?.sourceUrl).toBe('https://example.test/e1');
    expect(first?.createdAt).toBe(daysAgo(1).toISOString().slice(0, 17) + first?.createdAt.slice(17));
  });

  it('a malformed result does not break the question: a `software` that is a string, notes that are not objects, no list at all', async () => {
    const software = await src.members(MIKE, { kind: 'type', type: 'type:software' });
    expect(un(software.map((r) => r.id))).toEqual(['e3']);   // «no» is no list of software
    const places = await src.members(MIKE, { kind: 'type', type: 'type:places' });
    expect(un(places.map((r) => r.id))).toEqual(['e1', 'e7']);
    // a post with no list at all is a row with zero counts and no tags, and belongs to no type
    const all = await src.typeEntries(MIKE);
    expect(Object.values(all).flat().map((f) => f.id)).not.toContain(id('e9'));
    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entries e WHERE e.id = ANY($1::text[]) AND jsonb_typeof(e.results->'songs') IS NULL`, [[id('e9')]],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('a theme of another user has no posts for the user who asks (the question itself is for the owner)', async () => {
    expect(await src.members(SARA, { kind: 'theme', id: id('t1') })).toEqual([]);
    expect((await src.members(MIKE, { kind: 'theme', id: id('s1') }))).toEqual([]);
  });

  it('says who put a post in a theme: the grouping or the user', async () => {
    const rows = await src.members(MIKE, { kind: 'theme', id: id('t1') });
    expect(rows.find((r) => r.id === id('e1'))?.source).toBe('auto');
    expect(rows.find((r) => r.id === id('e3'))?.source).toBe('user_add');
    expect(rows.find((r) => r.id === id('e1'))?.score).toBeCloseTo(0.9, 5);
  });

  it('a type answers its posts, the music with the songs to play (the keys the Songs page uses), newest first', async () => {
    const detail = await collectionDetail(MIKE, 'type:music', page, src, NOW);
    expect(un((detail?.entries ?? []).map((e) => e.id))).toEqual(['e1', 'e4']);
    expect(detail?.collection).toMatchObject({ id: 'type:music', name: 'Musica', count: 2, views: ['play', 'list'], defaultView: 'play' });
    expect(detail?.songKeys).toEqual(['a::one', 'a::two', 'b::shared']);
  });

  it('a place answers the posts that name it, and leaves itself out of its own facets', async () => {
    const detail = await collectionDetail(MIKE, 'place:milano', page, src, NOW);
    expect(detail?.total).toBe(8);
    expect(detail?.facets.places).toEqual([{ name: 'Lombardia', count: 2 }]);
    expect(detail?.why).toEqual({ words: [], entryIds: [] });
  });

  it('a place under eight posts is not there', async () => {
    expect(await collectionDetail(MIKE, 'place:prato', page, src, NOW)).toBeNull();
  });

  it('the facets, the filters and the paging work on the real rows', async () => {
    const all = await collectionDetail(MIKE, id('t5'), page, src, NOW);
    expect(all?.facets.sources).toEqual([{ platform: 'instagram', count: 5 }]);
    expect(all?.facets.places).toEqual([{ name: 'Milano', count: 4 }, { name: 'Lombardia', count: 2 }]);   // Alba is named by one post: not offered
    expect(un((await collectionDetail(MIKE, id('t5'), { ...page, dove: 'lombardia' }, src, NOW))?.entries.map((e) => e.id) ?? [])).toEqual(['p1', 'p2']);
    expect((await collectionDetail(MIKE, id('t5'), { ...page, q: 'numero 3' }, src, NOW))?.total).toBe(1);
    expect((await collectionDetail(MIKE, id('t5'), { offset: 1, limit: 2 }, src, NOW))?.entries).toHaveLength(2);
  });

  it('the venues of the posts are one row for each, with the posts that name them and the address of Maps', async () => {
    const detail = await collectionDetail(MIKE, id('t5'), page, src, NOW);
    expect(detail?.venues.map((v) => [v.key, v.posts.map((p) => p.entryId.replace('vtest_vd_', ''))])).toEqual([
      ['bar luce|milano', ['p1', 'p2']],
      ['da gennaro|milano', ['p2']],
    ]);
    expect(detail?.venues[0]).toMatchObject({ name: 'Bar Luce', kind: 'bar', place: 'Milano', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Bar%20Luce%2C%20Milano' });
  });

  it('«why» comes from the tags and the summaries of the real posts, the typical posts from the scores of the grouping', async () => {
    const detail = await collectionDetail(MIKE, id('t5'), page, src, NOW);
    expect(detail?.why.words.slice(0, 2)).toEqual(['cantina', 'milano']);
    expect(un(detail?.why.entryIds ?? [])).toEqual(['e1', 'p1']);
  });
});

d('the chips, on a real database', () => {
  it('are the active themes a post is in, the child instead of its parent, the place from eight posts, for a whole page at once', async () => {
    const chips = await chipsForEntries(MIKE, [id('e1'), id('p1'), id('p5'), id('e6')], src);
    // e1 is in Vino (0.9) and in its child Cantine (0.7): the child says more; Alba is named by one post only
    expect(chips.get(id('e1'))).toEqual([{ id: id('t5'), name: 'Cantine' }]);
    // p1 is in Cantine and names Milano (eight posts of mike's: the three of archi's are not his) and Lombardia (two)
    expect(chips.get(id('p1'))).toEqual([{ id: id('t5'), name: 'Cantine' }, { id: 'place:milano', name: 'Milano' }]);
    expect(chips.get(id('p5'))).toEqual([{ id: 'place:milano', name: 'Milano' }]);
    expect(chips.has(id('e6'))).toBe(false);   // taken out of Vino by hand: no chip
  });

  it('never carry a hidden theme, a theme under observation or a merged one, nor another user\'s theme that holds the same post', async () => {
    // e1 is in the hidden t2; e2 in the one under observation t3; e3 in the merged t4; e4 in sara's s1 too
    const chips = await chipsForEntries(MIKE, [id('e1'), id('e2'), id('e3'), id('e4')], src);
    expect((chips.get(id('e1')) ?? []).map((c) => c.id)).not.toContain(id('t2'));
    expect((chips.get(id('e2')) ?? []).map((c) => c.id)).toEqual([id('t1')]);
    expect((chips.get(id('e3')) ?? []).map((c) => c.id)).toEqual([id('t1')]);
    expect((chips.get(id('e4')) ?? []).map((c) => c.id)).toEqual([id('t1')]);
    const sara = await chipsForEntries(SARA, [id('e4')], src);
    expect(sara.get(id('e4'))).toEqual([{ id: id('s1'), name: 'Di Sara' }]);
  });

  it('a place named by seven posts the user reads and two he does not is no chip: the count is of the posts he can read', async () => {
    const chips = await chipsForEntries(MIKE, [id('q1')], src);
    expect(chips.has(id('q1'))).toBe(false);
  });

  it('the place counts only the posts the user can read: sara\'s one post is no collection', async () => {
    const chips = await chipsForEntries(SARA, [id('e4')], src);
    expect((chips.get(id('e4')) ?? []).some((c) => c.id.startsWith('place:'))).toBe(false);
  });

  it('are on every row of a list: withCollectionChips gives an empty list to the posts that have none', async () => {
    const rows = await withCollectionChips([{ id: id('p1') }, { id: id('e6') }], MIKE);
    expect(rows).toEqual([
      { id: id('p1'), collections: [{ id: id('t5'), name: 'Cantine' }, { id: 'place:milano', name: 'Milano' }] },
      { id: id('e6'), collections: [] },
    ]);
  });
});

d('a post in full, on a real database', () => {
  it('has its places and its venues as the store holds them, with the address of Maps', async () => {
    const answer = await placesAndVenuesOfEntry({ id: id('p2'), sourceUrl: 'https://example.test/p2', sourcePlatform: 'instagram', createdAt: daysAgo(11).toISOString() });
    expect(answer?.places).toEqual([{ name: 'Lombardia', kind: 'region' }, { name: 'Milano', kind: 'city' }]);
    expect(answer?.venues.map((v) => [v.name, v.kind, v.mapsUrl])).toEqual([
      ['Bar Luce', 'bar', 'https://www.google.com/maps/search/?api=1&query=Bar%20Luce%2C%20Milano'],
      ['Da Gennaro', 'pizzeria', 'https://www.google.com/maps/search/?api=1&query=Da%20Gennaro%2C%20Milano'],
    ]);
  });

  it('has empty lists when the text names nothing', async () => {
    expect(await placesAndVenuesOfEntry({ id: id('e2'), sourceUrl: 'https://example.test/e2', sourcePlatform: 'tiktok', createdAt: daysAgo(2).toISOString() })).toEqual({ places: [], venues: [] });
  });
});

d('whether a post is the user\'s to read, on a real database', () => {
  it('is yes for his own and for one shared with him, no for another\'s, for the anonymous one and for one that is not there', async () => {
    expect(await entryVisibleTo(MIKE, id('e1'))).toBe(true);
    expect(await entryVisibleTo(MIKE, id('e4'))).toBe(true);
    expect(await entryVisibleTo(MIKE, id('e5'))).toBe(false);
    expect(await entryVisibleTo(MIKE, id('e8'))).toBe(false);
    expect(await entryVisibleTo(MIKE, 'vtest_vd_missing')).toBe(false);
    expect(await entryVisibleTo(SARA, id('e1'))).toBe(false);
  });
});

d('the Home of the site, on a real database', () => {
  it('has the collections between the playlists and the films: the themes and the places, never the types, new first; and its posts carry their chips', async () => {
    const home = await buildWebHome({ userId: MIKE, isAdmin: false }, realWebHomeDeps());
    const section = home.sections.find((s) => s.id === 'collections');
    expect(section?.id).toBe('collections');
    const tiles = (section?.items ?? []) as Array<{ id: string; name: string; count: number; isNew: boolean; thumbs: string[] }>;
    expect(tiles.map((t) => t.id)).toEqual([id('t1'), 'place:milano', id('t5')]);
    expect(tiles[0]).toMatchObject({ name: 'Vino', count: 4, isNew: true });
    expect(tiles[0].thumbs).toEqual(['https://img.example/e1.jpg', 'https://img.example/e3.jpg', 'https://img.example/e4.jpg']);   // the newest first, the shared post\'s picture too, none for the post without one
    const ids = home.sections.map((s) => s.id);
    expect(ids.indexOf('collections')).toBeGreaterThan(ids.indexOf('resume'));
    const resume = home.sections.find((s) => s.id === 'resume');
    const rows = (resume?.items ?? []) as Array<{ id: string; collections?: unknown[] }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => Array.isArray(r.collections))).toBe(true);
    expect(rows.find((r) => r.id === id('e1'))?.collections).toEqual([{ id: id('t5'), name: 'Cantine' }]);
  });

  it('an administrator\'s Home has no more collections than anyone\'s: they are strictly the user\'s own', async () => {
    const home = await buildWebHome({ userId: MIKE, isAdmin: true }, realWebHomeDeps());
    const tiles = ((home.sections.find((s) => s.id === 'collections')?.items ?? []) as Array<{ id: string }>).map((t) => t.id);
    expect(tiles).toEqual([id('t1'), 'place:milano', id('t5')]);
  });
});

// last: it changes the data the other groups read (a rename, a hide, a post put in and taken out)
d('the corrections of the store show at once in the answers', () => {
  it('a rename, a hide, an entry put in and an entry taken out change what the user reads the next moment', async () => {
    await store.rename(MIKE, id('t5'), 'Le mie cantine');
    expect((await findCollection(MIKE, id('t5'), src, NOW))?.item.name).toBe('Le mie cantine');
    await store.hide(MIKE, id('t5'));
    expect(ids(await collectionList(MIKE, 'active', src, NOW))).not.toContain(id('t5'));
    expect(ids(await collectionList(MIKE, 'hidden', src, NOW))).toContain(id('t5'));
    await store.unhide(MIKE, id('t5'));
    await store.removeEntry(MIKE, id('t5'), id('p1'));
    expect((await collectionDetail(MIKE, id('t5'), { offset: 0, limit: 40 }, src, NOW))?.entries.map((e) => e.id)).not.toContain(id('p1'));
    expect((await chipsForEntries(MIKE, [id('p1')], src)).get(id('p1'))?.map((c) => c.id)).toEqual(['place:milano']);
    await store.addEntry(MIKE, id('t5'), id('q1'));
    expect((await collectionDetail(MIKE, id('t5'), { offset: 0, limit: 40 }, src, NOW))?.entries.map((e) => e.id)).toContain(id('q1'));
  });
});
