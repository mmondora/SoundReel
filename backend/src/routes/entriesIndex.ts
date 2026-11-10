/**
 * The list of posts a page at a time with the filters of the Inbox, and the facets that offer them (docs/entries-index.md, spec
 * 2026-11-10-web-look-and-feel-rethink-design.md §3.6):
 *
 *   GET /api/entries?view=summary&limit&offset&platform&channel&user&category&verdict&tag   the page (answered by routes/entries.ts, which asks
 *                                                                                           `entriesIndexFor` below and adds the collection chips)
 *   GET /api/entries/facets                                                                  { platforms, channels, users, categories, verdicts, tags }
 *
 * SECURITY: the viewer is the Authelia `Remote-User` header and NOTHING else (never the query, never another header): what the list and the facets
 * show is what that person can read, own and shared (an administrator also the anonymous ones), exactly like the other lists of the site. The `user`
 * parameter of the list is a filter on who SENT the post (`inputUser`), never on who reads. So these paths MUST stay behind the `auth-family` Traefik
 * middleware, with the other web routes under /api/entries: never move them under `/api/mondrop` or `/api/share` (those routers bypass Authelia,
 * `Remote-User` would become client-controlled and anyone could read the posts and the tags of anybody).
 */
import type { FastifyInstance } from 'fastify';
import type { VisibilityOpts } from '../utils/db';
import { resolveUser } from '../utils/requestUser';
import { logError } from '../utils/logger';
import {
  entryFacets,
  listEntrySummariesFiltered,
  parseEntryFilter,
  type EntryFacets,
  type EntrySummaryRowWithExtras,
} from '../services/entriesIndex';

/** How many posts a page has when nobody says (what the list has always done). */
const DEFAULT_LIMIT = 200;
/** The most a page may have. */
const MAX_LIMIT = 1000;

export type EntriesIndexAnswer =
  | { status: 400; body: { error: string } }
  | { status: 200; body: { entries: EntrySummaryRowWithExtras[]; total: number; limit: number; offset: number } };

/**
 * The page of the list, from the query string of the request: `limit` and `offset` are brought into range as the list has always done (1–1000, and 0 or
 * more), and the six filters are read and checked. What is not a number, or a filter that is not one string of at most 100 characters, is a 400 that names
 * the field (the limit first, then the offset, then the filters) and asks nothing of the database. A failure of the database is thrown: the caller decides
 * what to answer.
 */
export async function entriesIndexFor(
  queryString: Record<string, unknown>,
  visibility: VisibilityOpts,
): Promise<EntriesIndexAnswer> {
  const wantedLimit = Number(queryString.limit ?? DEFAULT_LIMIT);
  if (Number.isNaN(wantedLimit)) return { status: 400, body: { error: 'invalid_query:limit' } };
  const wantedOffset = Number(queryString.offset ?? 0);
  if (Number.isNaN(wantedOffset)) return { status: 400, body: { error: 'invalid_query:offset' } };
  const parsed = parseEntryFilter(queryString);
  if (!parsed.ok) return { status: 400, body: { error: `invalid_query:${parsed.field}` } };

  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(wantedLimit)));
  const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(wantedOffset)));
  const { items, total } = await listEntrySummariesFiltered(limit, offset, visibility, parsed.filter);
  return { status: 200, body: { entries: items, total, limit, offset } };
}

export interface EntriesIndexRouteDeps {
  /** What the library holds for this viewer; the real one by default. */
  facets?: (visibility: VisibilityOpts) => Promise<EntryFacets>;
}

export function registerEntriesIndexRoutes(app: FastifyInstance, deps: EntriesIndexRouteDeps = {}): void {
  const facets = deps.facets ?? ((visibility: VisibilityOpts) => entryFacets(visibility));
  app.get('/api/entries/facets', async (req, reply) => {
    // never cached: the facets change when a post arrives
    reply.header('Cache-Control', 'no-store');
    const user = resolveUser(req);
    try {
      return await facets({ userId: user.id, isAdmin: user.isAdmin });
    } catch (err) {
      logError('GET /api/entries/facets failed', err);
      return reply.code(500).send({ error: 'entries_failed' });
    }
  });
}
