/**
 * The list of posts a page at a time with the filters, and the facets, against a REAL Postgres (docs/entries-index.md). Skipped unless
 * `ENTRIES_INT=1`: it needs a throw-away database that already has `init.sql` and the migrations applied, and the usual `DB_*` variables pointing at it
 * (never production):
 *
 *   ENTRIES_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=collections_check DB_USER=postgres DB_PASSWORD=… \
 *     npx vitest run --no-file-parallelism src/services/entriesIndex.int.test.ts
 *
 * Everything the tests make has an id that begins with `eidx-` and an owner that begins with `eidx_` (apart from the one post of the anonymous user
 * that the administrator test needs, which has `eidx-` too and a platform of its own), and is removed by that prefix: the rest of the database is not
 * touched, and its other posts are never visible to the users of these tests (visibility is by owner and by share).
 *
 * What the unit tests cannot see: that the filters really select what they say, that `total` follows them (also past the end), that a tag is found
 * whatever its sign and case, that the placeholders of the model never become a facet, that the tags are counted once per post, that the forty most used
 * are the ones kept, and above all that nobody ever sees a post of somebody else, with a filter or without.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listEntrySummaries, pool } from '../utils/db';
import { entryFacets, listEntrySummariesFiltered, type EntryFilter } from './entriesIndex';

const on = process.env.ENTRIES_INT === '1';
if (on && (!process.env.DB_NAME || process.env.DB_NAME === 'soundreel')) {
  throw new Error('ENTRIES_INT=1 needs a scratch DB_NAME (never the real one)');
}
const d = on ? describe : describe.skip;

const MIKE = 'eidx_mike';
const SARA = 'eidx_sara';
const TOP = 'eidx_top';
const NOBODY = 'eidx_nobody';
const BLANK = 'eidx_blank';
const TIE = 'eidx_tie';

interface Seed {
  id: string;
  owner: string;
  platform: string;
  channel: string;
  inputUser: string | null;
  at: string;
  tags: unknown;
  enrichments?: unknown;
  summary?: string | null;
  songs?: number;
  films?: number;
  notes?: number;
  caption?: string | null;
  thumbnail?: string | null;
  status?: string;
}

async function put(seed: Seed): Promise<void> {
  const results = {
    summary: seed.summary ?? null,
    tags: seed.tags,
    songs: Array.from({ length: seed.songs ?? 0 }, (_, i) => ({ title: `S${i}`, artist: 'A' })),
    films: Array.from({ length: seed.films ?? 0 }, (_, i) => ({ title: `F${i}` })),
    notes: Array.from({ length: seed.notes ?? 0 }, (_, i) => ({ text: `N${i}` })),
    links: [],
    ...(seed.enrichments === undefined ? {} : { enrichments: seed.enrichments }),
  };
  const insert = `INSERT INTO entries (id, source_url, source_platform, input_channel, input_user, caption, thumbnail_url, status, results, created_at, owner_user)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`;
  const params = [
    seed.id, `https://example.test/${seed.id}`, seed.platform, seed.channel, seed.inputUser, seed.caption ?? null, seed.thumbnail ?? null,
    seed.status ?? 'completed', JSON.stringify(results), seed.at, seed.owner,
  ];
  if (Array.isArray(seed.tags)) {
    await pool.query(insert, params);
    return;
  }
  // The search trigger of the table refuses a row whose tags are not a list, so such a row cannot be made the usual way: it is made with the triggers
  // off for this one transaction (the test database is ours), to see that the list and the facets do not break on data that is wrong.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(insert, params);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const clean = async (): Promise<void> => {
  await pool.query("DELETE FROM entry_shares WHERE entry_id LIKE 'eidx-%'");
  await pool.query("DELETE FROM entries WHERE id LIKE 'eidx-%'");
};

const MIKES: Seed[] = [
  { id: 'eidx-m1', owner: MIKE, platform: 'instagram', channel: 'telegram', inputUser: MIKE, at: '2026-03-09T10:00:00Z', tags: ['#Vino', '#tag', '@utente'], summary: 'Post M1', songs: 1, films: 2, notes: 3, caption: 'cap one', thumbnail: 'https://img.example/m1.jpg', enrichments: { category: 'claim', verdict: { label: 'falso', confidence: 82, explanation: 'x' }, items: [] } },
  { id: 'eidx-m2', owner: MIKE, platform: 'tiktok', channel: 'web', inputUser: null, at: '2026-03-08T10:00:00Z', tags: ['#vino', '#hashtag', '#cantina'], summary: 'Post M2' },
  { id: 'eidx-m3', owner: MIKE, platform: 'instagram', channel: 'telegram', inputUser: SARA, at: '2026-03-07T10:00:00Z', tags: ['@Vino', '#barolo', '#vino'], summary: 'Post M3', enrichments: { category: 'tech', verdict: { label: 'vero', confidence: 90, explanation: 'y' }, items: [] } },
  { id: 'eidx-m4', owner: MIKE, platform: 'youtube', channel: 'web', inputUser: MIKE, at: '2026-03-06T10:00:00Z', tags: ['#cantina', '#cantina'], summary: 'Post M4', enrichments: { category: 'tech', items: [] } },
  // the tags of this one are not a list (an old or broken row): it must not break anything
  { id: 'eidx-m5', owner: MIKE, platform: 'instagram', channel: 'ios', inputUser: MIKE, at: '2026-03-05T10:00:00Z', tags: 'not a list', summary: 'Post M5' },
  // the same moment as m5: the id breaks the tie, so two pages never show the same post twice
  { id: 'eidx-m6', owner: MIKE, platform: 'instagram', channel: 'telegram', inputUser: null, at: '2026-03-05T10:00:00Z', tags: ['#solo', '#', ' '], summary: 'Post M6' },
  { id: 'eidx-m7', owner: MIKE, platform: 'tiktok', channel: 'telegram', inputUser: MIKE, at: '2026-03-02T10:00:00Z', tags: ['#ai'], summary: 'Post M7' },
  { id: 'eidx-m8', owner: MIKE, platform: 'tiktok', channel: 'web', inputUser: MIKE, at: '2026-03-01T10:00:00Z', tags: ['#ai'], summary: 'Post M8' },
  { id: 'eidx-m9', owner: MIKE, platform: 'reddit', channel: 'telegram', inputUser: MIKE, at: '2026-02-28T10:00:00Z', tags: ['#ai'], summary: 'Post M9', status: 'processing' },
];
const SARAS: Seed[] = [
  { id: 'eidx-s1', owner: SARA, platform: 'youtube', channel: 'web', inputUser: SARA, at: '2026-03-10T10:00:00Z', tags: ['#sara'], summary: 'Hers alone' },
  { id: 'eidx-s2', owner: SARA, platform: 'instagram', channel: 'web', inputUser: SARA, at: '2026-03-04T10:00:00Z', tags: ['#shared'], summary: 'Shared with Mike' },
];
// a post whose platform, channel, sender, category and verdict are all empty strings: it is a post, and it offers no facet
const BLANKS: Seed = { id: 'eidx-b1', owner: BLANK, platform: '', channel: '', inputUser: '', at: '2026-03-01T10:00:00Z', tags: [], enrichments: { category: '', verdict: { label: '', confidence: 0 }, items: [] } };
const ANON: Seed = { id: 'eidx-a1', owner: 'anonymous', platform: 'eidxplat', channel: 'web', inputUser: null, at: '2026-03-03T10:00:00Z', tags: ['#anon'], summary: 'Anonymous post' };

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);
const page = (visibility: { userId: string; isAdmin?: boolean }, filter: EntryFilter = {}, limit = 100, offset = 0) =>
  listEntrySummariesFiltered(limit, offset, { userId: visibility.userId, isAdmin: !!visibility.isAdmin }, filter);
const mine = (filter: EntryFilter = {}, limit = 100, offset = 0) => page({ userId: MIKE }, filter, limit, offset);

d('the list of posts with filters, and the facets, on a real database', () => {
  beforeAll(async () => {
    await clean();
    for (const seed of [...MIKES, ...SARAS, ANON, BLANKS]) await put(seed);
    // Sara shares one of her posts with Mike
    await pool.query(`INSERT INTO entry_shares (entry_id, shared_with, shared_by) VALUES ('eidx-s2', $1, $2)`, [MIKE, SARA]);
    // a user with a lot of tags: the forty most used are the ones kept
    for (let i = 1; i <= 45; i += 1) {
      const n = String(i).padStart(2, '0');
      await put({ id: `eidx-top-${n}`, owner: TOP, platform: 'instagram', channel: 'telegram', inputUser: TOP, at: new Date(Date.UTC(2026, 0, i, 10)).toISOString(), tags: ['#all', ...(i <= 20 ? ['#half'] : []), `#t${n}`] });
    }
    // a user whose tags tie: four tags used once each, written with a different sign in front so that the order of the names as shown is NOT the order
    // of the names without the sign, and one tag written two ways by one post each
    await put({ id: 'eidx-tie-1', owner: TIE, platform: 'instagram', channel: 'telegram', inputUser: TIE, at: '2026-02-01T10:00:00Z', tags: ['@aa', '#ab', '#ba', '@bb'] });
    await put({ id: 'eidx-tie-2', owner: TIE, platform: 'instagram', channel: 'telegram', inputUser: TIE, at: '2026-02-02T10:00:00Z', tags: ['#Wine'] });
    await put({ id: 'eidx-tie-3', owner: TIE, platform: 'instagram', channel: 'telegram', inputUser: TIE, at: '2026-02-03T10:00:00Z', tags: ['#wine'] });
  });

  afterAll(async () => {
    if (on) await clean();
    await pool.end();
  });

  describe('without a filter', () => {
    it('is the library of the reader: own posts and the ones shared with them, newest first, and nothing of anybody else', async () => {
      const { items, total } = await mine();
      expect(total).toBe(10);
      expect(ids(items)).toEqual(['eidx-m1', 'eidx-m2', 'eidx-m3', 'eidx-m4', 'eidx-m6', 'eidx-m5', 'eidx-s2', 'eidx-m7', 'eidx-m8', 'eidx-m9']);
      expect(ids(items)).not.toContain('eidx-s1');
      expect(ids(items)).not.toContain('eidx-a1');
    });

    it('two posts of the very same moment come in a fixed order (the larger id first), so that pages never overlap', async () => {
      const { items } = await mine({ platform: 'instagram' });
      const at = (id: string) => ids(items).indexOf(id);
      expect(at('eidx-m6')).toBeLessThan(at('eidx-m5'));
      // the two pages that cut the list right between the two posts of the same moment still give every post once
      const firstPage = await mine({}, 5, 0);
      const secondPage = await mine({}, 5, 5);
      expect(ids(firstPage.items)).toEqual(['eidx-m1', 'eidx-m2', 'eidx-m3', 'eidx-m4', 'eidx-m6']);
      expect(ids(secondPage.items)).toEqual(['eidx-m5', 'eidx-s2', 'eidx-m7', 'eidx-m8', 'eidx-m9']);
    });

    it('is the row of the list of today, field by field, and four more: nothing else changes', async () => {
      const legacy = await listEntrySummaries(100, 0, { userId: MIKE });
      const mineAll = await mine();
      expect(mineAll.total).toBe(legacy.total);
      const strip = ({ inputChannel: _c, inputUser: _u, category: _k, verdict: _v, ...rest }: Record<string, unknown>) => {
        void _c; void _u; void _k; void _v;
        return rest;
      };
      const byId = (rows: Array<{ id: string }>) => Object.fromEntries(rows.map((r) => [r.id, strip(r as unknown as Record<string, unknown>)]));
      expect(byId(mineAll.items)).toEqual(byId(legacy.items));
    });

    it('a post says who sent it, its category and its verdict, and has them as null when it has none', async () => {
      const { items } = await mine();
      const row = (id: string) => items.find((r) => r.id === id);
      expect(row('eidx-m1')).toMatchObject({
        id: 'eidx-m1', sourceUrl: 'https://example.test/eidx-m1', sourcePlatform: 'instagram', caption: 'cap one', thumbnailUrl: 'https://img.example/m1.jpg',
        status: 'completed', createdAt: '2026-03-09T10:00:00.000Z', summary: 'Post M1', songCount: 1, filmCount: 2, noteCount: 3, tags: ['#Vino', '#tag', '@utente'],
        inputChannel: 'telegram', inputUser: MIKE, category: 'claim', verdict: { label: 'falso', confidence: 82 },
      });
      expect(row('eidx-m2')).toMatchObject({ inputChannel: 'web', inputUser: null, category: null, verdict: null });
      expect(row('eidx-m3')).toMatchObject({ inputUser: SARA, category: 'tech', verdict: { label: 'vero', confidence: 90 } });
      expect(row('eidx-m4')).toMatchObject({ category: 'tech', verdict: null });
      expect(row('eidx-m9')).toMatchObject({ status: 'processing' });
    });

    it('a post whose tags are not a list is a post with no tags, not an error', async () => {
      const { items } = await mine();
      expect(items.find((r) => r.id === 'eidx-m5')?.tags).toEqual([]);
    });

    it('a reader with no post has an empty page and a total of 0', async () => {
      await expect(page({ userId: NOBODY })).resolves.toEqual({ items: [], total: 0 });
    });
  });

  describe('each filter on its own (the total is that of the filtered set)', () => {
    const cases: Array<[string, EntryFilter, string[]]> = [
      ['platform', { platform: 'instagram' }, ['eidx-m1', 'eidx-m3', 'eidx-m6', 'eidx-m5', 'eidx-s2']],
      ['platform that nobody has', { platform: 'nonesuch' }, []],
      ['channel', { channel: 'telegram' }, ['eidx-m1', 'eidx-m3', 'eidx-m6', 'eidx-m7', 'eidx-m9']],
      ['channel ios', { channel: 'ios' }, ['eidx-m5']],
      ['user (who SENT the post)', { user: SARA }, ['eidx-m3', 'eidx-s2']],
      ['user, the reader himself', { user: MIKE }, ['eidx-m1', 'eidx-m4', 'eidx-m5', 'eidx-m7', 'eidx-m8', 'eidx-m9']],
      ['category', { category: 'tech' }, ['eidx-m3', 'eidx-m4']],
      ['category claim', { category: 'claim' }, ['eidx-m1']],
      ['verdict', { verdict: 'vero' }, ['eidx-m3']],
      ['verdict falso', { verdict: 'falso' }, ['eidx-m1']],
    ];
    it.each(cases)('%s', async (_name, filter, expected) => {
      const { items, total } = await mine(filter);
      expect(ids(items)).toEqual(expected);
      expect(total).toBe(expected.length);
    });

    it.each([
      ['with its sign', '#vino'],
      ['without it', 'vino'],
      ['in capitals', 'VINO'],
      ['written as one of the posts wrote it (#Vino)', '#Vino'],
      ['with the other sign', '@vino'],
      ['with two signs', '##vino'],
      ['with spaces round it', '  #vino  '.trim()],
    ])('the tag %s finds the same three posts, whatever the sign or the case the posts used', async (_name, tag) => {
      const { items, total } = await mine({ tag });
      expect(ids(items)).toEqual(['eidx-m1', 'eidx-m2', 'eidx-m3']);
      expect(total).toBe(3);
    });

    it('a tag is found even when it is one of the placeholders, and a post that has the tag twice is one post', async () => {
      expect(ids((await mine({ tag: '#hashtag' })).items)).toEqual(['eidx-m2']);
      const cantina = await mine({ tag: 'cantina' });
      expect(ids(cantina.items)).toEqual(['eidx-m2', 'eidx-m4']);
      expect(cantina.total).toBe(2);
    });

    it('a tag that is only signs matches nothing, and neither does a tag that is part of another (vin is not vino)', async () => {
      expect((await mine({ tag: '#' })).total).toBe(0);
      expect((await mine({ tag: '@@' })).total).toBe(0);
      expect((await mine({ tag: 'vin' })).total).toBe(0);
      expect((await mine({ tag: 'ino' })).total).toBe(0);
    });

    it('the tag of a post whose tags are not a list does not break the filter', async () => {
      await expect(mine({ tag: 'anything' })).resolves.toMatchObject({ total: 0 });
    });
  });

  describe('the filters together (they add up)', () => {
    it.each<[string, EntryFilter, string[]]>([
      ['platform and tag', { platform: 'instagram', tag: 'vino' }, ['eidx-m1', 'eidx-m3']],
      ['channel and verdict', { channel: 'telegram', verdict: 'vero' }, ['eidx-m3']],
      ['platform and user', { platform: 'tiktok', user: MIKE }, ['eidx-m7', 'eidx-m8']],
      ['category and platform', { category: 'tech', platform: 'youtube' }, ['eidx-m4']],
      ['three of them', { platform: 'instagram', channel: 'telegram', tag: '#vino' }, ['eidx-m1', 'eidx-m3']],
      ['two that nothing has in common', { platform: 'reddit', verdict: 'falso' }, []],
      ['all six', { platform: 'instagram', channel: 'telegram', user: MIKE, category: 'claim', verdict: 'falso', tag: 'Vino' }, ['eidx-m1']],
    ])('%s', async (_name, filter, expected) => {
      const { items, total } = await mine(filter);
      expect(ids(items)).toEqual(expected);
      expect(total).toBe(expected.length);
    });
  });

  describe('the pages of a filtered list', () => {
    it('the total is that of the filtered set, whatever the size of the page', async () => {
      const first = await mine({ platform: 'instagram' }, 2, 0);
      expect(ids(first.items)).toEqual(['eidx-m1', 'eidx-m3']);
      expect(first.total).toBe(5);
      const second = await mine({ platform: 'instagram' }, 2, 2);
      expect(ids(second.items)).toEqual(['eidx-m6', 'eidx-m5']);
      expect(second.total).toBe(5);
      const last = await mine({ platform: 'instagram' }, 2, 4);
      expect(ids(last.items)).toEqual(['eidx-s2']);
      expect(last.total).toBe(5);
    });

    it('a page past the end has no posts and still the right total', async () => {
      await expect(mine({ platform: 'instagram' }, 40, 5)).resolves.toMatchObject({ items: [], total: 5 });
      await expect(mine({ platform: 'instagram' }, 40, 4000)).resolves.toMatchObject({ items: [], total: 5 });
      await expect(mine({}, 40, 4000)).resolves.toMatchObject({ items: [], total: 10 });
    });

    it('a filter that nothing passes is an empty list with a total of 0, on the first page and past it', async () => {
      await expect(mine({ platform: 'nonesuch' }, 40, 0)).resolves.toEqual({ items: [], total: 0 });
      await expect(mine({ platform: 'nonesuch' }, 40, 80)).resolves.toEqual({ items: [], total: 0 });
    });
  });

  describe('nobody ever sees the post of somebody else — with a filter or without', () => {
    it('Sara sees her own two posts and nothing of Michele (who shared nothing with her)', async () => {
      const { items, total } = await page({ userId: SARA });
      expect(ids(items)).toEqual(['eidx-s1', 'eidx-s2']);
      expect(total).toBe(2);
    });

    it('a filter that only the posts of somebody else would pass gives nothing, whoever asks', async () => {
      expect((await mine({ tag: 'sara' })).total).toBe(0);            // the tag of s1, which Michele cannot read
      expect((await mine({ platform: 'eidxplat' })).total).toBe(0);   // the post of the anonymous user
      expect((await page({ userId: SARA }, { tag: 'vino' })).total).toBe(0);
      expect((await page({ userId: SARA }, { platform: 'tiktok' })).total).toBe(0);
      expect((await page({ userId: SARA }, { user: MIKE })).total).toBe(0);
    });

    it('the post that Sara shared is in the list of Michele, and stops being there when the share is taken away', async () => {
      expect(ids((await mine({ tag: 'shared' })).items)).toEqual(['eidx-s2']);
      await pool.query("DELETE FROM entry_shares WHERE entry_id = 'eidx-s2' AND shared_with = $1", [MIKE]);
      try {
        expect((await mine({ tag: 'shared' })).total).toBe(0);
        expect((await mine()).total).toBe(9);
      } finally {
        await pool.query(`INSERT INTO entry_shares (entry_id, shared_with, shared_by) VALUES ('eidx-s2', $1, $2)`, [MIKE, SARA]);
      }
    });

    it('an administrator also reads the posts of the anonymous user, as in the other lists of the site; nobody else does', async () => {
      expect(ids((await page({ userId: MIKE, isAdmin: true }, { platform: 'eidxplat' })).items)).toEqual(['eidx-a1']);
      expect((await page({ userId: MIKE, isAdmin: false }, { platform: 'eidxplat' })).total).toBe(0);
      expect((await page({ userId: SARA, isAdmin: false }, { platform: 'eidxplat' })).total).toBe(0);
      // and an administrator does not read the private posts of the others
      expect((await page({ userId: MIKE, isAdmin: true }, { tag: 'sara' })).total).toBe(0);
    });

    it('a value made to look like SQL is only a value: it finds nothing and hurts nothing', async () => {
      const nasty = "x') OR ('1'='1";
      for (const filter of [{ platform: nasty }, { channel: nasty }, { user: nasty }, { category: nasty }, { verdict: nasty }, { tag: nasty }] as EntryFilter[]) {
        await expect(mine(filter)).resolves.toEqual({ items: [], total: 0 });
      }
      await expect(page({ userId: nasty })).resolves.toEqual({ items: [], total: 0 });
      expect((await mine()).total).toBe(10);
    });
  });

  describe('the facets', () => {
    it('are what the reader can read: counted over all the posts, ordered by count and then by name', async () => {
      const facets = await entryFacets({ userId: MIKE, isAdmin: false });
      expect(facets.platforms).toEqual([
        { platform: 'instagram', count: 5 }, { platform: 'tiktok', count: 3 }, { platform: 'reddit', count: 1 }, { platform: 'youtube', count: 1 },
      ]);
      expect(facets.channels).toEqual([{ channel: 'telegram', count: 5 }, { channel: 'web', count: 4 }, { channel: 'ios', count: 1 }]);
      expect(facets.users).toEqual([{ user: MIKE, count: 6 }, { user: SARA, count: 2 }]);
      expect(facets.categories).toEqual([{ category: 'tech', count: 2 }, { category: 'claim', count: 1 }]);
      expect(facets.verdicts).toEqual([{ verdict: 'falso', count: 1 }, { verdict: 'vero', count: 1 }]);
    });

    it('count the posts of the facets of the filters exactly as the filters then find them', async () => {
      const facets = await entryFacets({ userId: MIKE, isAdmin: false });
      for (const { platform, count } of facets.platforms) expect((await mine({ platform })).total).toBe(count);
      for (const { channel, count } of facets.channels) expect((await mine({ channel })).total).toBe(count);
      for (const { user, count } of facets.users) expect((await mine({ user })).total).toBe(count);
      for (const { category, count } of facets.categories) expect((await mine({ category })).total).toBe(count);
      for (const { verdict, count } of facets.verdicts) expect((await mine({ verdict })).total).toBe(count);
      for (const { tag, count } of facets.tags) expect((await mine({ tag })).total).toBe(count);
    });

    it('the tags: once per post, whatever the sign or the case, shown as the spelling most posts used, and never the placeholders of the model', async () => {
      const { tags } = await entryFacets({ userId: MIKE, isAdmin: false });
      expect(tags).toEqual([
        { tag: '#ai', count: 3 },
        { tag: '#vino', count: 3 },     // #Vino, #vino and @Vino are one tag: three posts, shown as the spelling used twice
        { tag: '#cantina', count: 2 },  // m4 has it twice and counts once
        { tag: '#barolo', count: 1 },
        { tag: '#shared', count: 1 },   // the tag of a post shared with the reader is theirs too
        { tag: '#solo', count: 1 },
      ]);
      const written = tags.map((t) => t.tag.replace(/^[#@]+/, '').toLowerCase());
      for (const placeholder of ['tag', 'utente', 'hashtag']) expect(written).not.toContain(placeholder);
      expect(written).not.toContain('');
    });

    it('the users are only those who sent something: a post with no sender is not a user', async () => {
      const { users } = await entryFacets({ userId: MIKE, isAdmin: false });
      expect(users.map((u) => u.user)).not.toContain(null);
      expect(users.map((u) => u.user)).not.toContain('');
      expect(users.reduce((n, u) => n + u.count, 0)).toBe(8);   // ten posts, two of them with no sender
    });

    it('keeps the forty most used tags, the most used first, and by name when equally used', async () => {
      const { tags } = await entryFacets({ userId: TOP, isAdmin: false });
      expect(tags).toHaveLength(40);
      expect(tags[0]).toEqual({ tag: '#all', count: 45 });
      expect(tags[1]).toEqual({ tag: '#half', count: 20 });
      expect(tags.slice(2).every((t) => t.count === 1)).toBe(true);
      expect(tags.slice(2).map((t) => t.tag)).toEqual(Array.from({ length: 38 }, (_, i) => `#t${String(i + 1).padStart(2, '0')}`));
    });

    // what the database itself says is the order of these names (its own collation: the test must not guess it)
    const sorted = async (names: string[]): Promise<string[]> =>
      (await pool.query<{ t: string }>('SELECT t FROM unnest($1::text[]) AS t ORDER BY t ASC', [names])).rows.map((r) => r.t);

    it('equally used tags come in the order of their names AS SHOWN, which is not the order of the names without the sign in front', async () => {
      const { tags } = await entryFacets({ userId: TIE, isAdmin: false });
      const once = tags.filter((t) => t.count === 1).map((t) => t.tag);
      expect(once).toEqual(await sorted(['@aa', '#ab', '#ba', '@bb']));
    });

    it('a tag written two ways by the same number of posts is shown as the first of the two spellings, whatever the order the posts came in', async () => {
      const { tags } = await entryFacets({ userId: TIE, isAdmin: false });
      expect(tags[0]).toEqual({ tag: (await sorted(['#Wine', '#wine']))[0], count: 2 });
      expect(tags).toHaveLength(5);
    });

    it('a tag is counted for the reader only: Sara has her own tags, not those of Michele', async () => {
      const { tags, platforms } = await entryFacets({ userId: SARA, isAdmin: false });
      expect(tags).toEqual([{ tag: '#sara', count: 1 }, { tag: '#shared', count: 1 }]);
      expect(platforms).toEqual([{ platform: 'instagram', count: 1 }, { platform: 'youtube', count: 1 }]);
    });

    it('an empty value is no facet: a post whose platform, channel, sender, category and verdict are empty offers none of them', async () => {
      await expect(page({ userId: BLANK })).resolves.toMatchObject({ total: 1 });
      await expect(entryFacets({ userId: BLANK, isAdmin: false })).resolves.toEqual({ platforms: [], channels: [], users: [], categories: [], verdicts: [], tags: [] });
    });

    it('a reader with no post has six empty lists', async () => {
      await expect(entryFacets({ userId: NOBODY, isAdmin: false })).resolves.toEqual({ platforms: [], channels: [], users: [], categories: [], verdicts: [], tags: [] });
    });

    it('an administrator also counts the posts of the anonymous user, nobody else does', async () => {
      const admin = await entryFacets({ userId: NOBODY, isAdmin: true });
      expect(admin.platforms.map((p) => p.platform)).toContain('eidxplat');
      const plain = await entryFacets({ userId: NOBODY, isAdmin: false });
      expect(plain.platforms).toEqual([]);
    });

    it('a value made to look like SQL as the reader is only a name: nothing is found, nothing is hurt', async () => {
      await expect(entryFacets({ userId: "x' OR '1'='1", isAdmin: false })).resolves.toEqual({ platforms: [], channels: [], users: [], categories: [], verdicts: [], tags: [] });
    });
  });
});
