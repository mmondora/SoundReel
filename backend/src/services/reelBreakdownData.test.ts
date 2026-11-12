import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REEL_KINDS, SHOWN_NOTE_CATEGORIES } from './reelBreakdown';
import {
  getReelRow,
  isReelId,
  listReelRows,
  reelKindCounts,
  resolveReelImage,
  type ReelDataDeps,
} from './reelBreakdownData';

// The reads behind the reels of Mondrop (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md §4.4): the viewer is ALWAYS in the WHERE and a parameter, no
// value is ever written into the SQL text, the address of the post is never selected, and the list and its total read the same posts.

const USER = 'mike-who-must-never-be-in-the-text';
const ID = '8167b826-f8e2-4298-b477-174c41bcc13b';
/** One of the 87 posts that came from Firestore: 20 letters and digits, in either case (`entries.id` is text). */
const FIRESTORE_ID = 'pCylUBq1xyuM1oUBfXxA';
const flat = (sql: unknown): string => String(sql).replace(/\s+/g, ' ');

function fakeDeps(over: Partial<ReelDataDeps> & { answers?: unknown[][] } = {}): ReelDataDeps & { query: ReturnType<typeof vi.fn> } {
  const answers = [...(over.answers ?? [])];
  const query = vi.fn(async () => (answers.shift() ?? []) as never);
  return {
    query: query as never,
    mediaRoot: over.mediaRoot ?? (() => '/data/media'),
    fileSize: over.fileSize ?? (async () => 1234),
  } as ReelDataDeps & { query: ReturnType<typeof vi.fn> };
}

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: ID, created_at: new Date('2026-11-12T08:01:00.000Z'), platform: 'instagram', thumbnail_url: `/media/${ID}/thumbnail.jpg`, results: { summary: 'x' }, ...over,
});

describe('listReelRows: a page of the reels the viewer can read', () => {
  it('reads the page and the total in two queries that look at the same posts', async () => {
    const deps = fakeDeps({ answers: [[dbRow()], [{ total: '41' }]] });
    const out = await listReelRows(USER, { limit: 20, offset: 40 }, deps);
    expect(deps.query).toHaveBeenCalledTimes(2);
    const [page, count] = deps.query.mock.calls as [[string, unknown[]], [string, unknown[]]];
    const where = (sql: string) => flat(sql).slice(flat(sql).indexOf('WHERE'));
    expect(where(page[0]).replace(/ORDER BY.*$/, '').trim()).toBe(where(count[0]).trim());
    expect(count[1]).toEqual(page[1].slice(0, count[1].length));       // the count has the parameters of the page without its limit and offset
    expect(out.total).toBe(41);
    expect(out.rows).toEqual([{ id: ID, createdAt: new Date('2026-11-12T08:01:00.000Z'), platform: 'instagram', thumbnailUrl: `/media/${ID}/thumbnail.jpg`, results: { summary: 'x' } }]);
  });

  it('has the viewer in the WHERE, first and as a parameter: the posts they own and the ones shared with them', async () => {
    const deps = fakeDeps({ answers: [[], [{ total: '0' }]] });
    await listReelRows(USER, { limit: 20, offset: 0 }, deps);
    for (const [sql, params] of deps.query.mock.calls as [string, unknown[]][]) {
      expect(flat(sql)).toContain('e.owner_user = $1');
      expect(flat(sql)).toContain('s.shared_with = $1');
      expect(flat(sql)).toContain('FROM entry_shares s');
      expect(params[0]).toBe(USER);
      expect(flat(sql)).not.toContain(USER);                                    // never written into the text
      expect(flat(sql)).not.toContain("'anonymous'");                           // the administrator's view of anonymous posts is not for a key
    }
  });

  it('shows only completed posts that have an explanation or something in a shown category, the categories being a parameter', async () => {
    const deps = fakeDeps({ answers: [[], [{ total: '0' }]] });
    await listReelRows(USER, { limit: 20, offset: 0 }, deps);
    const [sql, params] = deps.query.mock.calls[0] as [string, unknown[]];
    const text = flat(sql);
    expect(text).toContain("e.status = 'completed'");
    expect(text).toContain("btrim(coalesce(e.results->>'summary', '')) <> ''");
    expect(text).toContain('= ANY($2::text[])');
    expect(params[1]).toEqual([...SHOWN_NOTE_CATEGORIES]);
    for (const field of ['songs', 'films', 'software', 'notes']) expect(text).toContain(`jsonb_typeof(e.results->'${field}') = 'array'`);   // a damaged array is no array
  });

  it('newest first, a tie broken by the id so that two pages never show the same post; limit and offset are parameters', async () => {
    const deps = fakeDeps({ answers: [[], [{ total: '0' }]] });
    await listReelRows(USER, { limit: 17, offset: 5 }, deps);
    const [sql, params] = deps.query.mock.calls[0] as [string, unknown[]];
    expect(flat(sql)).toContain('ORDER BY e.created_at DESC, e.id DESC');
    expect(flat(sql)).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(params.slice(-2)).toEqual([17, 5]);
    expect(flat(sql)).not.toMatch(/LIMIT 17|OFFSET 5/);
  });

  it('never selects the address of the post, nor the text read from the pictures, nor the transcript: only the parts the builder reads', async () => {
    const deps = fakeDeps({ answers: [[], [{ total: '0' }]] });
    await listReelRows(USER, { limit: 20, offset: 0 }, deps);
    const text = flat((deps.query.mock.calls[0] as [string])[0]);
    for (const banned of ['source_url', 'media_url', 'caption', 'transcript', 'ocr', 'action_log', 'e.*', 'SELECT *']) expect(text).not.toContain(banned);
    for (const wanted of ['e.id', 'e.created_at', 'e.source_platform', 'e.thumbnail_url']) expect(text).toContain(wanted);
  });

  it('narrows to music, films or software with one more fixed condition (no new parameter), on the page and on the total alike', async () => {
    const occurrences = (sql: unknown, needle: string): number => flat(sql).split(needle).length - 1;
    const plain = fakeDeps({ answers: [[], [{ total: '0' }]] });
    await listReelRows(USER, { limit: 20, offset: 0 }, plain);
    const plainPageSql = (plain.query.mock.calls[0] as [string])[0];
    const plainCountSql = (plain.query.mock.calls[1] as [string])[0];
    for (const [kind, field] of [['music', 'songs'], ['film', 'films'], ['software', 'software']] as const) {
      const deps = fakeDeps({ answers: [[], [{ total: '0' }]] });
      await listReelRows(USER, { kind, limit: 20, offset: 0 }, deps);
      const [pageSql, pageParams] = deps.query.mock.calls[0] as [string, unknown[]];
      const [countSql, countParams] = deps.query.mock.calls[1] as [string, unknown[]];
      const needle = `jsonb_typeof(e.results->'${field}')`;
      expect(occurrences(countSql, needle)).toBe(occurrences(plainCountSql, needle) + 1);
      expect(occurrences(pageSql, needle)).toBe(occurrences(plainPageSql, needle) + 1);
      expect(countParams).toEqual([USER, [...SHOWN_NOTE_CATEGORIES]]);
      expect(pageParams).toEqual([USER, [...SHOWN_NOTE_CATEGORIES], 20, 0]);
    }
  });

  it('narrows to a category of the notes with the category as a PARAMETER, never written into the text', async () => {
    for (const kind of SHOWN_NOTE_CATEGORIES) {
      const deps = fakeDeps({ answers: [[], [{ total: '0' }]] });
      await listReelRows(USER, { kind, limit: 20, offset: 40 }, deps);
      const [pageSql, pageParams] = deps.query.mock.calls[0] as [string, unknown[]];
      const [countSql, countParams] = deps.query.mock.calls[1] as [string, unknown[]];
      expect(countParams).toEqual([USER, [...SHOWN_NOTE_CATEGORIES], kind]);
      expect(pageParams).toEqual([USER, [...SHOWN_NOTE_CATEGORIES], kind, 20, 40]);
      for (const sql of [pageSql, countSql]) {
        expect(flat(sql)).toContain("lower(btrim(coalesce(n.note->>'category', ''))) = $3");
        expect(flat(sql)).not.toContain(`'${kind}'`);
      }
      expect(flat(pageSql)).toMatch(/LIMIT \$4 OFFSET \$5/);
    }
  });

  it('the total follows the filter, and an empty answer is zero', async () => {
    const deps = fakeDeps({ answers: [[], []] });
    await expect(listReelRows(USER, { kind: 'film', limit: 20, offset: 0 }, deps)).resolves.toEqual({ rows: [], total: 0 });
  });
});

describe('reelKindCounts: how many readable posts have each category', () => {
  it('counts over all the posts of the viewer, in the order of the categories, leaving out those with none', async () => {
    const deps = fakeDeps({
      answers: [[{ kind: 'quote', count: 3 }, { kind: 'music', count: 733 }, { kind: 'film', count: '265' }, { kind: 'person', count: 0 }, { kind: 'other', count: 9 }, { kind: 'software', count: 701 }]],
    });
    const counts = await reelKindCounts(USER, deps);
    expect(counts).toEqual([
      { kind: 'music', count: 733 }, { kind: 'film', count: 265 }, { kind: 'software', count: 701 }, { kind: 'quote', count: 3 },
    ]);
    expect(counts.map((c) => c.kind)).toEqual(REEL_KINDS.filter((k) => counts.some((c) => c.kind === k)));
  });

  it('is one query, with the viewer in the WHERE as a parameter and the shown categories as a parameter, and no filter or page', async () => {
    const deps = fakeDeps({ answers: [[]] });
    await reelKindCounts(USER, deps);
    expect(deps.query).toHaveBeenCalledTimes(1);
    const [sql, params] = deps.query.mock.calls[0] as [string, unknown[]];
    expect(flat(sql)).toContain('e.owner_user = $1');
    expect(flat(sql)).toContain('s.shared_with = $1');
    expect(flat(sql)).toContain("e.status = 'completed'");
    expect(flat(sql)).toContain('GROUP BY');
    expect(flat(sql)).not.toContain('LIMIT');
    expect(flat(sql)).not.toContain(USER);
    expect(params).toEqual([USER, [...SHOWN_NOTE_CATEGORIES]]);
  });
});

describe('getReelRow: one reel, for its page', () => {
  it('reads the reel the viewer can read, by id as a parameter, with the explanations and the slides but not the pictures nor their text', async () => {
    const deps = fakeDeps({ answers: [[dbRow({ results: { summary: 'x', tags: ['a'] } })]] });
    const row = await getReelRow(USER, ID, deps);
    expect(row).toMatchObject({ id: ID, platform: 'instagram', results: { summary: 'x', tags: ['a'] } });
    const [sql, params] = deps.query.mock.calls[0] as [string, unknown[]];
    const text = flat(sql);
    expect(params).toEqual([USER, [...SHOWN_NOTE_CATEGORIES], ID]);
    expect(text).toContain('e.id = $3');
    expect(text).toContain('e.owner_user = $1');
    expect(text).toContain("e.status = 'completed'");                          // what the list does not show cannot be opened
    expect(text).not.toContain(ID);
    expect(text).not.toContain(USER);
    for (const wanted of ["'enrichments'", "'slides'", "'tags'", "'summary'"]) expect(text).toContain(wanted);
    for (const banned of ['source_url', 'media_url', 'caption', 'transcript', 'ocrText', 'visualDescription', 'imageUrl', 'SELECT *']) expect(text).not.toContain(banned);
  });

  it('opens a post that came from Firestore too (its id is 20 letters and digits, not a UUID)', async () => {
    const deps = fakeDeps({ answers: [[dbRow({ id: FIRESTORE_ID, thumbnail_url: null })]] });
    await expect(getReelRow(USER, FIRESTORE_ID, deps)).resolves.toMatchObject({ id: FIRESTORE_ID, thumbnailUrl: null });
    expect((deps.query.mock.calls[0] as [string, unknown[]])[1]).toEqual([USER, [...SHOWN_NOTE_CATEGORIES], FIRESTORE_ID]);
  });

  it('is nothing when the reel does not exist or is not the viewer\'s', async () => {
    await expect(getReelRow(USER, ID, fakeDeps({ answers: [[]] }))).resolves.toBeNull();
  });

  it('does not even ask the database for something that cannot be an id', async () => {
    for (const id of ['', 'abc', '../../etc/passwd', `${ID}x`, `${ID}'; DROP TABLE entries; --`, '12345']) {
      const deps = fakeDeps();
      await expect(getReelRow(USER, id, deps)).resolves.toBeNull();
      expect(deps.query).not.toHaveBeenCalled();
    }
  });
});

describe('isReelId', () => {
  it('is a UUID, in either case, or the 20 letters and digits of a post that came from Firestore, and nothing else', () => {
    expect(isReelId(ID)).toBe(true);
    expect(isReelId(ID.toUpperCase())).toBe(true);
    expect(isReelId(FIRESTORE_ID)).toBe(true);
    for (const bad of [
      '', ID.slice(1), `${ID}0`, 'not-an-id', `../${ID}`, `${ID}/..`, ` ${ID}`, `${FIRESTORE_ID}0`, FIRESTORE_ID.slice(1), `${FIRESTORE_ID.slice(0, 19)}.`, `${FIRESTORE_ID.slice(0, 18)}/x`,
      `${FIRESTORE_ID.slice(0, 18)}%2f`, '....................', '/etc/passwd', 'a'.repeat(21),
    ]) expect(isReelId(bad)).toBe(false);
  });
});

describe('resolveReelImage: the picture of a reel the viewer can read', () => {
  it('is the thumbnail in the folder of the reel, under the folder of the media, for a reel the viewer can read', async () => {
    const deps = fakeDeps({ answers: [[{ ok: 1 }]], mediaRoot: () => '/data/media', fileSize: async () => 4321 });
    await expect(resolveReelImage(USER, ID, deps)).resolves.toEqual({ absPath: path.join('/data/media', ID, 'thumbnail.jpg'), size: 4321 });
    const [sql, params] = deps.query.mock.calls[0] as [string, unknown[]];
    expect(flat(sql)).toContain('e.owner_user = $1');
    expect(flat(sql)).toContain('s.shared_with = $1');
    expect(params).toEqual([USER, ID]);
    expect(flat(sql)).not.toContain(ID);
  });

  it('asks the viewer\'s permission BEFORE it looks at the disk', async () => {
    const fileSize = vi.fn(async () => 10);
    const deps = fakeDeps({ answers: [[]], fileSize });
    await expect(resolveReelImage(USER, ID, deps)).resolves.toBeNull();
    expect(fileSize).not.toHaveBeenCalled();
  });

  it('is nothing when the file is not there or is empty', async () => {
    await expect(resolveReelImage(USER, ID, fakeDeps({ answers: [[{ ok: 1 }]], fileSize: async () => null }))).resolves.toBeNull();
    await expect(resolveReelImage(USER, ID, fakeDeps({ answers: [[{ ok: 1 }]], fileSize: async () => 0 }))).resolves.toBeNull();
  });

  it('never leaves the folder of the media: what is not an id is refused before the database and the disk are asked', async () => {
    for (const id of ['../../etc/passwd', `${ID}/../../x`, '..', '', `${ID}%2f..`]) {
      const deps = fakeDeps({ answers: [[{ ok: 1 }]] });
      await expect(resolveReelImage(USER, id, deps)).resolves.toBeNull();
      expect(deps.query).not.toHaveBeenCalled();
    }
  });

  it('looks for the file under the id exactly as the entry has it, as the folders are named after it', async () => {
    const deps = fakeDeps({ answers: [[{ ok: 1 }]] });
    const image = await resolveReelImage(USER, FIRESTORE_ID, deps);
    expect(image?.absPath).toBe(path.join('/data/media', FIRESTORE_ID, 'thumbnail.jpg'));
  });
});
