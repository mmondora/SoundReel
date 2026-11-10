/**
 * The list of posts a page at a time, filtered by the SERVER on the whole library, and the facets that offer the filters
 * (docs/entries-index.md; spec 2026-11-10-web-look-and-feel-rethink-design.md §3.6). Michele: «in inbox sulla lista non voglio avere "apri tutta la
 * libreria" ma la paginazione con 30 o 40 per pagina»: the Inbox shows 40 posts a page, and the filters of «Filtra» (platform, channel, user, category,
 * verdict, tag) no longer act on the few posts already downloaded: they act on everything, and the pages follow them (rule P: the site draws, the
 * server decides the page, the total and the filters).
 *
 * SECURITY: the viewer's visibility (own posts, posts shared with them, and for an administrator the anonymous ones: the same predicate as every other
 * list of the site, `visibilitySql`) is ALWAYS in the WHERE, as a parameter, whatever the filters say: a filter narrows what the person can already
 * read, it can never widen it. No value is ever written into the SQL text: the filters, the viewer, the limit and the offset are all parameters.
 */
import type { QueryResultRow } from 'pg';
import { query, visibilitySql, type VisibilityOpts } from '../utils/db';
import type { EntrySummaryRow } from '../types';

/** The most characters a filter may have (after the trim). */
export const MAX_FILTER_CHARS = 100;
/** The tags the facets offer: the most used ones. */
export const FACET_TAGS_LIMIT = 40;

/** What is injected, so that the unit tests never need a database. */
export interface EntriesIndexDeps {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<T[]>;
}

// the real query, looked up when it is needed (a test that mocks the database module without it must not break just by importing this one)
const realDeps: EntriesIndexDeps = { query: (text, params) => query(text, params) };

// ---------- the filters ----------

export interface EntryFilter {
  /** `sourcePlatform` equal (`instagram`, `tiktok`…). */
  platform?: string;
  /** `inputChannel` equal (`telegram`, `web`, `ios`). */
  channel?: string;
  /** `inputUser` equal: who sent the link. NOT who is reading: that is `Remote-User`, never a parameter. */
  user?: string;
  /** `results.enrichments.category` equal. */
  category?: string;
  /** `results.enrichments.verdict.label` equal. */
  verdict?: string;
  /** The post has this tag, whatever the case and without a `#` or `@` in front. */
  tag?: string;
}

export type ParsedEntryFilter = { ok: true; filter: EntryFilter } | { ok: false; field: string };

/** The six filters, in the order their conditions (and their parameters) are written. */
const FILTER_KEYS = ['platform', 'channel', 'user', 'category', 'verdict', 'tag'] as const;

/**
 * Reads the filters from a query string. A blank one is no filter; one that is not a string (the same name twice, an object) or is longer than
 * `MAX_FILTER_CHARS` characters makes the whole request wrong, and the answer names the first bad one (in the order platform, channel, user, category,
 * verdict, tag).
 */
export function parseEntryFilter(queryString: Record<string, unknown>): ParsedEntryFilter {
  const filter: EntryFilter = {};
  for (const key of FILTER_KEYS) {
    const raw = queryString[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') return { ok: false, field: key };
    const value = raw.trim();
    if (value === '') continue;
    if ([...value].length > MAX_FILTER_CHARS) return { ok: false, field: key };
    filter[key] = value;
  }
  return { ok: true, filter };
}

// ---------- the SQL ----------

/** The tags of a post as a JSON list: what is not a list (an old or broken row) is no tags, never an error. */
const SAFE_TAGS = "CASE WHEN jsonb_typeof(e.results->'tags') = 'array' THEN e.results->'tags' ELSE '[]'::jsonb END";
/** A tag as it is compared: without the `#` or `@` in front, in lower case. `$` placeholders are for the value given. */
const tagKey = (expression: string): string => `lower(regexp_replace(${expression}, '^[#@]+', ''))`;

/**
 * `WHERE` of the page and of the count: the viewer first (always `$1`), then one condition for each filter that was given, each with its value as the
 * next parameter, in the fixed order of `FILTER_KEYS`. Conditions are added (AND).
 */
function whereOf(visibility: VisibilityOpts, filter: EntryFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [visibility.userId];
  const conditions: string[] = [visibilitySql('$1', !!visibility.isAdmin)];
  const next = (value: string): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.platform !== undefined) conditions.push(`e.source_platform = ${next(filter.platform)}`);
  if (filter.channel !== undefined) conditions.push(`e.input_channel = ${next(filter.channel)}`);
  if (filter.user !== undefined) conditions.push(`e.input_user = ${next(filter.user)}`);
  if (filter.category !== undefined) conditions.push(`e.results->'enrichments'->>'category' = ${next(filter.category)}`);
  if (filter.verdict !== undefined) conditions.push(`e.results->'enrichments'->'verdict'->>'label' = ${next(filter.verdict)}`);
  if (filter.tag !== undefined) {
    const given = tagKey(next(filter.tag));
    // a value that is only signs («#») matches nothing: the tags that are only signs are no tags
    conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${SAFE_TAGS}) AS t(tag) WHERE ${tagKey('t.tag')} = ${given} AND ${given} <> '')`);
  }
  return { where: conditions.join('\n       AND '), params };
}

/** What the rows of the list read. The first twelve columns are exactly those of `listEntrySummaries` (utils/db.ts): the row is that row. */
const ROW_COLUMNS = `
       e.id,
       e.source_url,
       e.source_platform,
       e.caption,
       e.thumbnail_url,
       e.status,
       e.created_at,
       e.results->>'summary' AS summary,
       COALESCE(jsonb_array_length(e.results->'songs'), 0) AS song_count,
       COALESCE(jsonb_array_length(e.results->'films'), 0) AS film_count,
       COALESCE(jsonb_array_length(e.results->'notes'), 0) AS note_count,
       COALESCE(e.results->'tags', '[]'::jsonb) AS tags,
       e.input_channel,
       e.input_user,
       e.results->'enrichments'->>'category' AS category,
       e.results->'enrichments'->'verdict'->>'label' AS verdict_label,
       e.results->'enrichments'->'verdict'->>'confidence' AS verdict_confidence`;

interface EntryIndexDbRow {
  id: string;
  source_url: string;
  source_platform: string;
  caption: string | null;
  thumbnail_url: string | null;
  status: string;
  created_at: Date;
  summary: string | null;
  song_count: number | string;
  film_count: number | string;
  note_count: number | string;
  tags: unknown;
  input_channel: string;
  input_user: string | null;
  category: string | null;
  verdict_label: string | null;
  verdict_confidence: string | number | null;
}

/** The summary row of the list plus what the Inbox draws and filters on (docs/entries-index.md). */
export interface EntrySummaryRowWithExtras extends EntrySummaryRow {
  inputChannel: string;
  inputUser: string | null;
  category: string | null;
  verdict: { label: string; confidence: number } | null;
}

function rowOf(r: EntryIndexDbRow): EntrySummaryRowWithExtras {
  const confidence = Number(r.verdict_confidence);
  return {
    id: r.id,
    sourceUrl: r.source_url,
    sourcePlatform: r.source_platform,
    caption: r.caption,
    thumbnailUrl: r.thumbnail_url,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    summary: r.summary,
    songCount: Number(r.song_count),
    filmCount: Number(r.film_count),
    noteCount: Number(r.note_count),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    inputChannel: r.input_channel,
    inputUser: r.input_user ?? null,
    category: r.category ?? null,
    // a verdict with a label but no readable confidence keeps its label: the Inbox draws the icon, and the number is only for the tooltip
    verdict: r.verdict_label ? { label: r.verdict_label, confidence: Number.isFinite(confidence) ? confidence : 0 } : null,
  };
}

/**
 * A page of the posts the viewer can read, newest first, narrowed by the filters; `total` is how many posts pass the filters (not how many are in the
 * page), and stays right when the page is beyond the end. Ties of the date are broken by the id, so that two pages never show the same post twice.
 */
export async function listEntrySummariesFiltered(
  limit: number,
  offset: number,
  visibility: VisibilityOpts,
  filter: EntryFilter,
  deps: EntriesIndexDeps = realDeps,
): Promise<{ items: EntrySummaryRowWithExtras[]; total: number }> {
  const { where, params } = whereOf(visibility, filter);
  const [rows, counted] = await Promise.all([
    deps.query<EntryIndexDbRow & QueryResultRow>(
      `SELECT ${ROW_COLUMNS}
     FROM entries e
     WHERE ${where}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    deps.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM entries e WHERE ${where}`, params),
  ]);
  return { items: rows.map(rowOf), total: Number(counted[0]?.total ?? 0) };
}

// ---------- the facets ----------

export interface EntryFacets {
  platforms: Array<{ platform: string; count: number }>;
  channels: Array<{ channel: string; count: number }>;
  users: Array<{ user: string; count: number }>;
  categories: Array<{ category: string; count: number }>;
  verdicts: Array<{ verdict: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
}

interface FacetDbRow {
  value: string;
  count: number | string;
}

/** The words the model copies from its prompt instead of tags (spec 2026-11-09-library-collections-auto-topics-design.md §6.5): never a facet. */
const PLACEHOLDER_TAGS = "('tag', 'utente', 'hashtag')";

/**
 * What the viewer's posts hold, to choose a filter from: the values and how many posts have each, over ALL the posts they can read (the facets do not
 * follow the page or the filters). Platforms, channels, users, categories and verdicts come ordered by count (then by name); the users are those who sent
 * something; the tags are the forty most used, counted once per post whatever the sign or the case (`#Vino`, `#vino` and `@vino` are one tag, shown as
 * the spelling most posts used), and never the placeholders of the model.
 */
export async function entryFacets(visibility: VisibilityOpts, deps: EntriesIndexDeps = realDeps): Promise<EntryFacets> {
  const vis = visibilitySql('$1', !!visibility.isAdmin);
  const params = [visibility.userId];
  const grouped = (expression: string): string => `SELECT ${expression} AS value, COUNT(*)::int AS count
     FROM entries e
     WHERE ${vis} AND ${expression} IS NOT NULL AND ${expression} <> ''
     GROUP BY value
     ORDER BY count DESC, value ASC`;
  const tagsQuery = `WITH tagged AS (
       SELECT e.id AS id, btrim(x.tag) AS tag
       FROM entries e
       CROSS JOIN LATERAL jsonb_array_elements_text(${SAFE_TAGS}) AS x(tag)
       WHERE ${vis}
     ),
     normed AS (
       SELECT id, tag, ${tagKey('tag')} AS key FROM tagged
     ),
     kept AS (
       SELECT id, tag, key FROM normed WHERE key <> '' AND key NOT IN ${PLACEHOLDER_TAGS}
     ),
     per_key AS (
       SELECT key, COUNT(DISTINCT id)::int AS count FROM kept GROUP BY key
     ),
     spelling AS (
       SELECT DISTINCT ON (key) key, tag
       FROM (SELECT key, tag, COUNT(DISTINCT id) AS n FROM kept GROUP BY key, tag) spellings
       ORDER BY key, n DESC, tag ASC
     )
     SELECT s.tag AS value, p.count AS count
     FROM per_key p JOIN spelling s ON s.key = p.key
     ORDER BY p.count DESC, s.tag ASC
     LIMIT ${FACET_TAGS_LIMIT}`;

  const [platforms, channels, users, categories, verdicts, tags] = await Promise.all([
    deps.query<FacetDbRow & QueryResultRow>(grouped('e.source_platform'), params),
    deps.query<FacetDbRow & QueryResultRow>(grouped('e.input_channel'), params),
    deps.query<FacetDbRow & QueryResultRow>(grouped('e.input_user'), params),
    deps.query<FacetDbRow & QueryResultRow>(grouped("e.results->'enrichments'->>'category'"), params),
    deps.query<FacetDbRow & QueryResultRow>(grouped("e.results->'enrichments'->'verdict'->>'label'"), params),
    deps.query<FacetDbRow & QueryResultRow>(tagsQuery, params),
  ]);
  return {
    platforms: platforms.map((r) => ({ platform: r.value, count: Number(r.count) })),
    channels: channels.map((r) => ({ channel: r.value, count: Number(r.count) })),
    users: users.map((r) => ({ user: r.value, count: Number(r.count) })),
    categories: categories.map((r) => ({ category: r.value, count: Number(r.count) })),
    verdicts: verdicts.map((r) => ({ verdict: r.value, count: Number(r.count) })),
    tags: tags.map((r) => ({ tag: r.value, count: Number(r.count) })),
  };
}
