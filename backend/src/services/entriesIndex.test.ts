import { describe, expect, it, vi } from 'vitest';
import {
  FACET_TAGS_LIMIT,
  MAX_FILTER_CHARS,
  entryFacets,
  listEntrySummariesFiltered,
  parseEntryFilter,
  type EntriesIndexDeps,
} from './entriesIndex';

// The list of posts, a page at a time and filtered by the server on the WHOLE library, and the facets that offer the filters (docs/entries-index.md,
// spec 2026-11-10-web-look-and-feel-rethink-design.md §3.6: Michele wants the Inbox in pages, with the filters of «Filtra» working on everything).
// The unit tests hold what the code decides (which filters exist, what is a parameter, what is a row); what the SQL really does is held by the
// integration test (entriesIndex.int.test.ts, on a real Postgres).

type Call = { text: string; params: unknown[] };

/** A `query` that writes down what it was asked and answers what the test says. */
function fake(answer: (text: string, params: unknown[]) => unknown[] = () => []): { deps: EntriesIndexDeps; calls: Call[] } {
  const calls: Call[] = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return answer(text, params);
  });
  return { deps: { query } as unknown as EntriesIndexDeps, calls };
}

const isCount = (text: string): boolean => /COUNT\(\*\)/.test(text);
const pageOf = (calls: Call[]): Call => calls.find((c) => !isCount(c.text)) as Call;
const countOf = (calls: Call[]): Call => calls.find((c) => isCount(c.text)) as Call;
// everything after the FIRST `WHERE` (the visibility has another one inside) up to the `ORDER BY`
const whereOf = (text: string): string => text.slice(text.search(/\bWHERE\b/) + 'WHERE'.length).split(/\bORDER BY\b/)[0].trim();

const VIS = { userId: 'mike', isAdmin: false };
const ADMIN = { userId: 'mike', isAdmin: true };

describe('parseEntryFilter — what the six filters accept', () => {
  it('no filter at all is an empty filter', () => {
    expect(parseEntryFilter({})).toEqual({ ok: true, filter: {} });
    expect(parseEntryFilter({ view: 'summary', limit: '40', offset: '0' })).toEqual({ ok: true, filter: {} });
  });

  it('takes each of the six, trimmed, and nothing else', () => {
    expect(parseEntryFilter({
      platform: ' instagram ', channel: 'telegram', user: 'sara', category: 'claim', verdict: 'falso', tag: '#Vino', other: 'x', q: 'y',
    })).toEqual({
      ok: true,
      filter: { platform: 'instagram', channel: 'telegram', user: 'sara', category: 'claim', verdict: 'falso', tag: '#Vino' },
    });
  });

  it('an empty or blank filter is no filter', () => {
    expect(parseEntryFilter({ platform: '', channel: '   ', tag: '\t' })).toEqual({ ok: true, filter: {} });
  });

  it('a filter of exactly 100 characters is fine; one of 101 is not, and the answer names it', () => {
    expect(parseEntryFilter({ tag: 'a'.repeat(MAX_FILTER_CHARS) })).toEqual({ ok: true, filter: { tag: 'a'.repeat(100) } });
    expect(parseEntryFilter({ tag: 'a'.repeat(MAX_FILTER_CHARS + 1) })).toEqual({ ok: false, field: 'tag' });
    expect(MAX_FILTER_CHARS).toBe(100);
  });

  it('the length is counted after the trim, in characters (an emoji is one)', () => {
    expect(parseEntryFilter({ tag: `  ${'a'.repeat(100)}  ` }).ok).toBe(true);
    expect(parseEntryFilter({ tag: '😀'.repeat(100) }).ok).toBe(true);
    expect(parseEntryFilter({ tag: '😀'.repeat(101) })).toEqual({ ok: false, field: 'tag' });
  });

  it.each([
    ['an array (the same name twice)', ['a', 'b']],
    ['a number', 5],
    ['an object', { a: 1 }],
    ['null', null],
    ['a boolean', true],
  ])('%s is refused, naming the field', (_name, value) => {
    expect(parseEntryFilter({ platform: value })).toEqual({ ok: false, field: 'platform' });
  });

  it('names the first bad one, in the order platform, channel, user, category, verdict, tag', () => {
    expect(parseEntryFilter({ tag: ['x'], user: ['y'] })).toEqual({ ok: false, field: 'user' });
    expect(parseEntryFilter({ verdict: 'x'.repeat(101), channel: ['z'] })).toEqual({ ok: false, field: 'channel' });
  });

  it('a bad filter is refused even when the others are fine', () => {
    expect(parseEntryFilter({ platform: 'instagram', tag: ['x', 'y'] })).toEqual({ ok: false, field: 'tag' });
  });
});

describe('listEntrySummariesFiltered — the page', () => {
  it('asks the page and the count together, both for the reader, the page newest first with a tie-break so that pages do not overlap', async () => {
    const { deps, calls } = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(40, 80, VIS, {}, deps);
    expect(calls).toHaveLength(2);
    const page = pageOf(calls);
    expect(page.text).toContain('FROM entries e');
    expect(page.text).toMatch(/ORDER BY e\.created_at DESC, e\.id DESC/);
    expect(page.text).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(page.params).toEqual(['mike', 40, 80]);
    expect(countOf(calls).params).toEqual(['mike']);
  });

  it('the visibility is in the WHERE of both queries, as a parameter: own posts and the ones shared with the reader', async () => {
    const { deps, calls } = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(40, 0, VIS, { platform: 'instagram' }, deps);
    for (const call of calls) {
      const where = whereOf(call.text);
      expect(where).toContain('e.owner_user = $1');
      expect(where).toContain('entry_shares');
      expect(where).toContain('s.shared_with = $1');
      expect(call.params[0]).toBe('mike');
    }
  });

  it('an administrator reads the posts of anonymous too, as in the other lists of the site; nobody else does', async () => {
    const plain = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(40, 0, VIS, {}, plain.deps);
    expect(whereOf(pageOf(plain.calls).text)).not.toContain('anonymous');
    const admin = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(40, 0, ADMIN, {}, admin.deps);
    expect(whereOf(pageOf(admin.calls).text)).toContain("e.owner_user = 'anonymous'");
    expect(whereOf(countOf(admin.calls).text)).toContain("e.owner_user = 'anonymous'");
  });

  it('the page and the count have the very same WHERE (the total is that of the filtered set)', async () => {
    const { deps, calls } = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(40, 0, VIS, { platform: 'instagram', tag: '#vino', verdict: 'falso' }, deps);
    expect(whereOf(countOf(calls).text)).toBe(whereOf(pageOf(calls).text));
    expect(countOf(calls).params).toEqual(pageOf(calls).params.slice(0, -2));
  });

  it.each([
    ['platform', { platform: 'tiktok' }, 'e.source_platform = $2'],
    ['channel', { channel: 'telegram' }, 'e.input_channel = $2'],
    ['user', { user: 'sara' }, 'e.input_user = $2'],
    ['category', { category: 'claim' }, "e.results->'enrichments'->>'category' = $2"],
    ['verdict', { verdict: 'falso' }, "e.results->'enrichments'->'verdict'->>'label' = $2"],
  ])('the %s filter is one condition on its own column, with its value as a parameter', async (_name, filter, condition) => {
    const { deps, calls } = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(40, 0, VIS, filter, deps);
    const page = pageOf(calls);
    expect(whereOf(page.text)).toContain(condition);
    expect(page.params).toEqual(['mike', Object.values(filter)[0], 40, 0]);
    expect(page.text).toMatch(/LIMIT \$3 OFFSET \$4/);
  });

  it('the tag filter looks inside the tags of the post, ignoring a leading # or @ and the case on both sides, and the value stays a parameter', async () => {
    const { deps, calls } = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(40, 0, VIS, { tag: '#Vino' }, deps);
    const page = pageOf(calls);
    const where = whereOf(page.text);
    expect(where).toContain('jsonb_array_elements_text');
    expect(where).toContain("jsonb_typeof(e.results->'tags') = 'array'");
    expect(where).toContain("lower(regexp_replace(t.tag, '^[#@]+', ''))");
    expect(where).toContain("= lower(regexp_replace($2, '^[#@]+', ''))");
    expect(page.params).toEqual(['mike', '#Vino', 40, 0]);
  });

  it('the filters add up (AND), their parameters in a fixed order whatever order they were written in', async () => {
    const { deps, calls } = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(10, 20, VIS, { tag: '#vino', verdict: 'falso', platform: 'instagram', user: 'sara' }, deps);
    const page = pageOf(calls);
    expect(page.params).toEqual(['mike', 'instagram', 'sara', 'falso', '#vino', 10, 20]);
    const where = whereOf(page.text);
    expect(where.indexOf('e.source_platform = $2')).toBeLessThan(where.indexOf('e.input_user = $3'));
    expect(where.indexOf('e.input_user = $3')).toBeLessThan(where.indexOf("->>'label' = $4"));
    expect(where).toContain("= lower(regexp_replace($5, '^[#@]+', ''))");
    expect(page.text).toMatch(/LIMIT \$6 OFFSET \$7/);
    expect(where.match(/\bAND\b/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('a value is never part of the SQL text, however nasty: it is only a parameter', async () => {
    const nasty = "x'); DROP TABLE entries; --";
    const { deps, calls } = fake((text) => (isCount(text) ? [{ total: '0' }] : []));
    await listEntrySummariesFiltered(40, 0, { userId: nasty, isAdmin: false }, { platform: nasty, channel: nasty, user: nasty, category: nasty, verdict: nasty, tag: nasty }, deps);
    for (const call of calls) {
      expect(call.text).not.toContain('DROP TABLE');
      expect(call.text).not.toContain(nasty);
      expect(call.params).toContain(nasty);
    }
  });
});

describe('listEntrySummariesFiltered — the rows', () => {
  const DB_ROW = {
    id: 'e1', source_url: 'https://instagram.com/reel/e1', source_platform: 'instagram', caption: 'a caption', thumbnail_url: 'https://cdn/t.jpg',
    status: 'completed', created_at: new Date('2026-07-01T10:20:30.000Z'), summary: 'Short summary', song_count: '2', film_count: '1', note_count: '3',
    tags: ['#vino', 'cantina'], input_channel: 'telegram', input_user: 'sara', category: 'claim', verdict_label: 'falso', verdict_confidence: '82',
  };

  const rowsOf = async (rows: unknown[], total = rows.length) => {
    const { deps } = fake((text) => (isCount(text) ? [{ total: String(total) }] : rows));
    return listEntrySummariesFiltered(40, 0, VIS, {}, deps);
  };

  it('a row is the summary row of today (the same fields, the same values) and four more', async () => {
    const { items, total } = await rowsOf([DB_ROW], 17);
    expect(total).toBe(17);
    expect(items).toEqual([{
      id: 'e1',
      sourceUrl: 'https://instagram.com/reel/e1',
      sourcePlatform: 'instagram',
      caption: 'a caption',
      thumbnailUrl: 'https://cdn/t.jpg',
      status: 'completed',
      createdAt: '2026-07-01T10:20:30.000Z',
      summary: 'Short summary',
      songCount: 2,
      filmCount: 1,
      noteCount: 3,
      tags: ['#vino', 'cantina'],
      inputChannel: 'telegram',
      inputUser: 'sara',
      category: 'claim',
      verdict: { label: 'falso', confidence: 82 },
    }]);
    // the keys of today in the order of today, then the four new ones: the JSON of an old row is the same text up to its end
    expect(Object.keys(items[0])).toEqual([
      'id', 'sourceUrl', 'sourcePlatform', 'caption', 'thumbnailUrl', 'status', 'createdAt', 'summary', 'songCount', 'filmCount', 'noteCount', 'tags',
      'inputChannel', 'inputUser', 'category', 'verdict',
    ]);
  });

  it('the counts become numbers, even when the database sends them as text', async () => {
    const { items } = await rowsOf([DB_ROW]);
    for (const count of [items[0].songCount, items[0].filmCount, items[0].noteCount]) expect(typeof count).toBe('number');
    expect(items[0].songCount).toBe(2);
    expect(items[0].filmCount).toBe(1);
    expect(items[0].noteCount).toBe(3);
  });

  it('a post with no user, no category and no verdict has them as null, not as undefined', async () => {
    const { items } = await rowsOf([{ ...DB_ROW, input_user: null, category: null, verdict_label: null, verdict_confidence: null }]);
    expect(items[0].inputUser).toBeNull();
    expect(items[0].category).toBeNull();
    expect(items[0].verdict).toBeNull();
    expect(Object.keys(items[0])).toContain('verdict');
  });

  it('a row that comes without the columns of the extras at all (nothing was selected there) has them as null, never as undefined', async () => {
    const { input_user: _u, category: _c, verdict_label: _l, verdict_confidence: _f, ...bare } = DB_ROW;
    void _u; void _c; void _l; void _f;
    const { items } = await rowsOf([bare]);
    expect(items[0].inputUser).toBeNull();
    expect(items[0].category).toBeNull();
    expect(items[0].verdict).toBeNull();
  });

  it('a verdict with a label but no readable confidence keeps the label and says 0', async () => {
    const { items } = await rowsOf([{ ...DB_ROW, verdict_confidence: null }, { ...DB_ROW, id: 'e2', verdict_confidence: 'abc' }]);
    expect(items.map((i) => i.verdict)).toEqual([{ label: 'falso', confidence: 0 }, { label: 'falso', confidence: 0 }]);
  });

  it('the tags are the strings among the tags (anything else the database holds there is left out)', async () => {
    const { items } = await rowsOf([{ ...DB_ROW, tags: ['#a', 5, null, { x: 1 }, 'b'] }, { ...DB_ROW, id: 'e2', tags: 'not a list' }, { ...DB_ROW, id: 'e3', tags: null }]);
    expect(items.map((i) => i.tags)).toEqual([['#a', 'b'], [], []]);
  });

  it('keeps the order the database gave', async () => {
    const { items } = await rowsOf([{ ...DB_ROW, id: 'b' }, { ...DB_ROW, id: 'a' }, { ...DB_ROW, id: 'c' }]);
    expect(items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('a page past the end has no rows and still the right total (the count is asked on its own)', async () => {
    const { deps } = fake((text) => (isCount(text) ? [{ total: '1721' }] : []));
    await expect(listEntrySummariesFiltered(40, 4000, VIS, {}, deps)).resolves.toEqual({ items: [], total: 1721 });
  });

  it('no post at all is a total of 0', async () => {
    const { deps } = fake(() => []);
    await expect(listEntrySummariesFiltered(40, 0, VIS, {}, deps)).resolves.toEqual({ items: [], total: 0 });
  });

  it('a failure of the database is the caller\'s to handle: it is not swallowed', async () => {
    const deps = { query: vi.fn(async () => { throw new Error('db down'); }) } as unknown as EntriesIndexDeps;
    await expect(listEntrySummariesFiltered(40, 0, VIS, {}, deps)).rejects.toThrow('db down');
  });
});

describe('entryFacets — what the filters offer', () => {
  /** Answers each of the facet queries by what it groups on. */
  function facetDb(over: Partial<Record<'platform' | 'channel' | 'user' | 'category' | 'verdict' | 'tag', Array<{ value: string; count: number | string }>>> = {}) {
    return fake((text) => {
      if (text.includes('jsonb_array_elements_text')) return over.tag ?? [];
      if (text.includes('e.source_platform')) return over.platform ?? [];
      if (text.includes('e.input_channel')) return over.channel ?? [];
      if (text.includes('e.input_user')) return over.user ?? [];
      if (text.includes("->>'category'")) return over.category ?? [];
      if (text.includes("->'verdict'->>'label'")) return over.verdict ?? [];
      return [];
    });
  }

  it('shapes the six lists, with the counts as numbers, in the order the database gave', async () => {
    const { deps } = facetDb({
      platform: [{ value: 'instagram', count: '900' }, { value: 'tiktok', count: 300 }],
      channel: [{ value: 'telegram', count: '1500' }],
      user: [{ value: 'mike', count: 1600 }, { value: 'sara', count: '100' }],
      category: [{ value: 'tech', count: '12' }],
      verdict: [{ value: 'vero', count: 5 }],
      tag: [{ value: '#vino', count: '17' }, { value: '#ai', count: 15 }],
    });
    await expect(entryFacets(VIS, deps)).resolves.toEqual({
      platforms: [{ platform: 'instagram', count: 900 }, { platform: 'tiktok', count: 300 }],
      channels: [{ channel: 'telegram', count: 1500 }],
      users: [{ user: 'mike', count: 1600 }, { user: 'sara', count: 100 }],
      categories: [{ category: 'tech', count: 12 }],
      verdicts: [{ verdict: 'vero', count: 5 }],
      tags: [{ tag: '#vino', count: 17 }, { tag: '#ai', count: 15 }],
    });
  });

  it('a user with no post has six empty lists', async () => {
    const { deps } = facetDb();
    await expect(entryFacets(VIS, deps)).resolves.toEqual({ platforms: [], channels: [], users: [], categories: [], verdicts: [], tags: [] });
  });

  it('every query is for the reader, as a parameter, over the posts the reader can see (and the administrator the anonymous ones too)', async () => {
    const plain = facetDb();
    await entryFacets(VIS, plain.deps);
    expect(plain.calls).toHaveLength(6);
    for (const call of plain.calls) {
      expect(call.params).toEqual(['mike']);
      expect(call.text).toContain('e.owner_user = $1');
      expect(call.text).toContain('s.shared_with = $1');
      expect(call.text).not.toContain('anonymous');
    }
    const admin = facetDb();
    await entryFacets(ADMIN, admin.deps);
    for (const call of admin.calls) expect(call.text).toContain("e.owner_user = 'anonymous'");
  });

  it('the users are those who sent something: a post with no user is not a user named «null»', async () => {
    const { deps, calls } = facetDb();
    await entryFacets(VIS, deps);
    const users = calls.find((c) => c.text.includes('e.input_user')) as Call;
    expect(users.text).toContain('e.input_user IS NOT NULL');
    expect(users.text).toMatch(/e\.input_user <> ''/);
  });

  it('the categories and the verdicts are the ones that exist: no empty value', async () => {
    const { deps, calls } = facetDb();
    await entryFacets(VIS, deps);
    const category = calls.find((c) => c.text.includes("->>'category'")) as Call;
    const verdict = calls.find((c) => c.text.includes("->'verdict'->>'label'")) as Call;
    for (const q of [category, verdict]) {
      expect(q.text).toMatch(/IS NOT NULL/);
      expect(q.text).toMatch(/<> ''/);
    }
  });

  it('the groups of the platforms, channels, users, categories and verdicts are ordered by count, then by name', async () => {
    const { deps, calls } = facetDb();
    await entryFacets(VIS, deps);
    for (const call of calls.filter((c) => !c.text.includes('jsonb_array_elements_text'))) {
      expect(call.text).toMatch(/ORDER BY count DESC, value ASC/);
    }
  });

  it('the tags: counted once per post, whatever the sign or the case, never the placeholders of the model, the forty most used', async () => {
    const { deps, calls } = facetDb();
    await entryFacets(VIS, deps);
    const tags = calls.find((c) => c.text.includes('jsonb_array_elements_text')) as Call;
    expect(tags.text).toContain("jsonb_typeof(e.results->'tags') = 'array'");
    expect(tags.text).toContain("lower(regexp_replace(tag, '^[#@]+', ''))");
    expect(tags.text).toContain('COUNT(DISTINCT id)');
    expect(tags.text).toContain("NOT IN ('tag', 'utente', 'hashtag')");
    expect(tags.text).toContain("key <> ''");
    expect(tags.text).toMatch(/ORDER BY p\.count DESC, s\.tag ASC\s+LIMIT 40/);
    expect(FACET_TAGS_LIMIT).toBe(40);
  });

  it('the tag shown is the spelling most used for it', async () => {
    const { deps, calls } = facetDb();
    await entryFacets(VIS, deps);
    const tags = calls.find((c) => c.text.includes('jsonb_array_elements_text')) as Call;
    expect(tags.text).toContain('DISTINCT ON (key)');
    expect(tags.text).toMatch(/ORDER BY key, n DESC, tag ASC/);
  });

  it('a failure of one of the queries is the caller\'s to handle', async () => {
    const deps = { query: vi.fn(async () => { throw new Error('db down'); }) } as unknown as EntriesIndexDeps;
    await expect(entryFacets(VIS, deps)).rejects.toThrow('db down');
  });
});
