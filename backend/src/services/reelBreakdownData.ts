/**
 * The reads behind the reels of Mondrop (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md §4, contract docs/mondrop-reels.md): a page of the posts
 * SoundReel has analysed for the person, how many have each category, one post, and the file of its picture.
 *
 * SECURITY: the viewer's visibility (the posts they own and the ones shared with them: the predicate of every other list, `visibilitySql`, WITHOUT the administrator's
 * view of anonymous posts — a Mondrop key is a person's) is ALWAYS in the WHERE, as a parameter, whatever the filter says: a filter narrows what the person can already
 * read, it can never widen it. No value is ever written into the SQL text: the viewer, the id, the category of a filter, the limit and the offset are all parameters (what is
 * written into the text are names of columns and of JSON fields, which are ours). A post that the list does not show (not completed, nothing to say) cannot be opened by
 * its id either, so a card of the list always opens and nothing else does.
 *
 * Read-only, and lean: only the parts of `results` the builder reads are selected — never the address of the post, its caption, its transcript, nor the text read from
 * its pictures.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { QueryResultRow } from 'pg';
import { query, visibilitySql } from '../utils/db';
import { REEL_KINDS, SHOWN_NOTE_CATEGORIES, type ReelKind, type ReelRow } from './reelBreakdown';

/** What is injected, so that the unit tests never need a database or a disk. */
export interface ReelDataDeps {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<T[]>;
  /** The folder of the media of the entries (`MEDIA_ROOT`). */
  mediaRoot: () => string;
  /** The size of a file, or null when it is not a file we can read. */
  fileSize: (absPath: string) => Promise<number | null>;
}

// the real ones, looked up when needed (a test that mocks the database module without them must not break just by importing this one)
const realDeps: ReelDataDeps = {
  query: (text, params) => query(text, params),
  mediaRoot: () => process.env.MEDIA_ROOT || '/data/media',
  fileSize: async (absPath) => {
    try {
      const info = await stat(absPath);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  },
};

/**
 * The ids an entry has: a UUID (every post since the database was made) and the 20 letters and digits of the posts that came from Firestore (87 of 1 743 on 12 November;
 * `entries.id` is text). Nothing else can be an id, and anything else is refused before the database or the disk is asked: no path can leave the folder of the media.
 */
const ENTRY_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9]{20})$/i;

/** Whether `id` can be the id of a reel. */
export const isReelId = (id: string): boolean => ENTRY_ID.test(id);

// ---------- the SQL ----------

/** A JSON array of `results` as an array: what is not one (an old or broken row) is empty, never an error. */
const arrayOf = (field: string): string => `CASE WHEN jsonb_typeof(e.results->'${field}') = 'array' THEN e.results->'${field}' ELSE '[]'::jsonb END`;
const SONGS = arrayOf('songs');
const FILMS = arrayOf('films');
const SOFTWARE = arrayOf('software');
const NOTES = arrayOf('notes');
const SLIDES = arrayOf('slides');
const ENRICHMENT_ITEMS = `CASE WHEN jsonb_typeof(e.results->'enrichments'->'items') = 'array' THEN e.results->'enrichments'->'items' ELSE '[]'::jsonb END`;

/** The category of a note, as it is compared: without capitals or spaces. */
const NOTE_CATEGORY = `lower(btrim(coalesce(n.note->>'category', '')))`;

/** The reels: completed posts with an explanation or something in a category that is shown (`categories` is the parameter that holds them). */
const shownSql = (categories: string): string => `e.status = 'completed'
       AND (
         btrim(coalesce(e.results->>'summary', '')) <> ''
         OR jsonb_array_length(${SONGS}) > 0
         OR jsonb_array_length(${FILMS}) > 0
         OR jsonb_array_length(${SOFTWARE}) > 0
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(${NOTES}) AS n(note) WHERE ${NOTE_CATEGORY} = ANY(${categories}::text[]))
       )`;

/** One more condition for a category: fixed for the three that have their own list, a parameter (pushed here) for a category of the notes. */
function kindSql(kind: ReelKind, params: unknown[]): string {
  switch (kind) {
    case 'music': return `jsonb_array_length(${SONGS}) > 0`;
    case 'film': return `jsonb_array_length(${FILMS}) > 0`;
    case 'software': return `jsonb_array_length(${SOFTWARE}) > 0`;
    default:
      params.push(kind);
      return `EXISTS (SELECT 1 FROM jsonb_array_elements(${NOTES}) AS n(note) WHERE ${NOTE_CATEGORY} = $${params.length})`;
  }
}

/** `$1` is the viewer and `$2` the shown categories, always; a category filter takes the next parameter. */
function whereOf(userId: string, kind?: ReelKind): { where: string; params: unknown[] } {
  const params: unknown[] = [userId, [...SHOWN_NOTE_CATEGORIES]];
  const conditions = [visibilitySql('$1', false), shownSql('$2')];
  if (kind !== undefined) conditions.push(kindSql(kind, params));
  return { where: conditions.join('\n       AND '), params };
}

/** What a card needs of `results`: the explanation and the things by category. */
const LIST_RESULTS = `jsonb_build_object(
         'summary', e.results->'summary',
         'songs', ${SONGS},
         'films', ${FILMS},
         'software', ${SOFTWARE},
         'notes', ${NOTES}
       )`;

/** What a page needs more: the key words, the explanations of the model and of each slide — without the pictures and without the text read from them. */
const DETAIL_RESULTS = `jsonb_build_object(
         'summary', e.results->'summary',
         'songs', ${SONGS},
         'films', ${FILMS},
         'software', ${SOFTWARE},
         'notes', ${NOTES},
         'tags', e.results->'tags',
         'enrichments', jsonb_build_object(
           'verdict', e.results->'enrichments'->'verdict',
           'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('label', i.item->'label', 'explanation', i.item->'explanation') ORDER BY i.ord), '[]'::jsonb)
                       FROM jsonb_array_elements(${ENRICHMENT_ITEMS}) WITH ORDINALITY AS i(item, ord))
         ),
         'slides', (SELECT coalesce(jsonb_agg(jsonb_build_object('index', s.slide->'index', 'summary', s.slide->'summary') ORDER BY s.ord), '[]'::jsonb)
                      FROM jsonb_array_elements(${SLIDES}) WITH ORDINALITY AS s(slide, ord))
       )`;

interface ReelDbRow {
  id: string;
  created_at: Date | string;
  platform: string | null;
  thumbnail_url: string | null;
  results: unknown;
}

const rowOf = (r: ReelDbRow): ReelRow => ({ id: r.id, createdAt: r.created_at, platform: r.platform, thumbnailUrl: r.thumbnail_url, results: r.results });

const columns = (results: string): string => `e.id,
       e.created_at,
       e.source_platform AS platform,
       e.thumbnail_url,
       ${results} AS results`;

// ---------- the reads ----------

/**
 * A page of the reels the viewer can read, newest first (a tie of the date broken by the id, so two pages never show the same post), narrowed to a category if asked;
 * `total` is how many pass the same conditions (not how many are in the page).
 */
export async function listReelRows(
  userId: string,
  page: { kind?: ReelKind; limit: number; offset: number },
  deps: ReelDataDeps = realDeps,
): Promise<{ rows: ReelRow[]; total: number }> {
  const { where, params } = whereOf(userId, page.kind);
  const [rows, counted] = await Promise.all([
    deps.query<ReelDbRow & QueryResultRow>(
      `SELECT ${columns(LIST_RESULTS)}
     FROM entries e
     WHERE ${where}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, page.limit, page.offset],
    ),
    deps.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM entries e WHERE ${where}`, params),
  ]);
  return { rows: rows.map(rowOf), total: Number(counted[0]?.total ?? 0) };
}

/**
 * How many reels have each category, over ALL the posts the viewer can read (not the page, not the filter), in the order of the categories and only the categories that
 * have a post. A post counts once for every category it has.
 */
export async function reelKindCounts(userId: string, deps: ReelDataDeps = realDeps): Promise<Array<{ kind: ReelKind; count: number }>> {
  const rows = await deps.query<{ kind: string; count: number | string }>(
    `SELECT k.kind AS kind, COUNT(*)::int AS count
     FROM (
       SELECT e.id,
              unnest(
                array_remove(ARRAY[
                  CASE WHEN jsonb_array_length(${SONGS}) > 0 THEN 'music' END,
                  CASE WHEN jsonb_array_length(${FILMS}) > 0 THEN 'film' END,
                  CASE WHEN jsonb_array_length(${SOFTWARE}) > 0 THEN 'software' END
                ], NULL)
                || ARRAY(
                  SELECT DISTINCT ${NOTE_CATEGORY}
                  FROM jsonb_array_elements(${NOTES}) AS n(note)
                  WHERE ${NOTE_CATEGORY} = ANY($2::text[])
                )
              ) AS kind
       FROM entries e
       WHERE ${visibilitySql('$1', false)} AND e.status = 'completed'
     ) k
     GROUP BY k.kind`,
    [userId, [...SHOWN_NOTE_CATEGORIES]],
  );
  const byKind = new Map(rows.map((r) => [r.kind, Number(r.count)]));
  return REEL_KINDS.flatMap((kind) => {
    const count = byKind.get(kind) ?? 0;
    return count > 0 ? [{ kind, count }] : [];
  });
}

/** One reel for its page, if the viewer can read it and the list would show it. */
export async function getReelRow(userId: string, id: string, deps: ReelDataDeps = realDeps): Promise<ReelRow | null> {
  if (!isReelId(id)) return null;
  const { where, params } = whereOf(userId);
  params.push(id);
  const rows = await deps.query<ReelDbRow & QueryResultRow>(
    `SELECT ${columns(DETAIL_RESULTS)}
     FROM entries e
     WHERE ${where} AND e.id = $${params.length}
     LIMIT 1`,
    params,
  );
  return rows[0] ? rowOf(rows[0]) : null;
}

export interface ReelImage {
  absPath: string;
  size: number;
}

/**
 * The thumbnail of a reel (`<media>/<id>/thumbnail.jpg`, 320 px) when the viewer can read the post and the file is there. The permission is asked BEFORE the disk, and
 * the id is the id of an entry, exactly as the entry has it (the folders are named after it), before anything.
 */
export async function resolveReelImage(userId: string, id: string, deps: ReelDataDeps = realDeps): Promise<ReelImage | null> {
  if (!isReelId(id)) return null;
  const rows = await deps.query(`SELECT 1 AS ok FROM entries e WHERE e.id = $2 AND ${visibilitySql('$1', false)} LIMIT 1`, [userId, id]);
  if (rows.length === 0) return null;
  const root = path.resolve(deps.mediaRoot());
  const absPath = path.resolve(root, id, 'thumbnail.jpg');
  if (!absPath.startsWith(root + path.sep)) return null;
  const size = await deps.fileSize(absPath);
  return size !== null && size > 0 ? { absPath, size } : null;
}
