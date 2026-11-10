/**
 * The collections of the site (docs/collections.md, ADR-0022, spec 2026-11-09-library-collections-auto-topics-design.md):
 *
 *   GET    /api/collections[?state=hidden|watching]      the list: types, themes, places, already in order (rule P: the site draws it)
 *   GET    /api/collections/:id?dove&fonte&quando&q&offset&limit   one collection with everything its page draws
 *   POST   /api/collections/:id/rename | merge | hide | unhide     the corrections of the user (themes only)
 *   POST   /api/collections/:id/entries/:entryId   «add to…»: the post enters and never leaves
 *   DELETE /api/collections/:id/entries/:entryId   «not this one»: the post leaves and never comes back
 *   POST   /api/admin/collections/rebuild?dry=1    the preview of the nightly pass (administrator only; the pass that writes is a script)
 *
 * SECURITY: the user is the Authelia `Remote-User` header and NOTHING else (never the query, the body or another header): the collections are
 * strictly the user's own (their posts and the ones shared with them: an administrator sees no more than anyone). The id of another user's
 * collection is a 404, never a 403. So these paths MUST stay behind the `auth-family` Traefik middleware, with the other web routes: never move them
 * under `/api/mondrop` or `/api/share` (those routers bypass Authelia, `Remote-User` would become client-controlled and anyone could read, rename
 * or hide the collections of anybody).
 *
 * Only the SITE has these routes (Michele, Q2: nothing for Mondrop). Every answer is `Cache-Control: no-store`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveUser, type RequestUser } from '../utils/requestUser';
import { logError } from '../utils/logger';
import { PgCollectionsStore, type CollectionsStore } from '../services/collectionsStore';
import { entryVisibleTo, realViewSources } from '../services/collectionsViewData';
import { rebuildPreview } from '../services/collectionsEngine';
import { realEngineDeps } from '../services/collectionsEngineData';
import {
  COLLECTION_VIEW,
  collectionDetail,
  collectionList,
  findCollection,
  isComputedId,
  type DetailQuery,
  type ThemeRow,
  type ViewSources,
} from '../services/collectionsView';

/** What the preview of the nightly pass says about each collection it would make (docs/collections.md). */
export interface RebuildPreviewItem {
  id: string | null;
  name: string;
  size: number;
  state: string;
  memberIds: string[];
}

export interface CollectionsRouteDeps {
  sources: ViewSources;
  store: Pick<CollectionsStore, 'rename' | 'merge' | 'hide' | 'unhide' | 'addEntry' | 'removeEntry'>;
  /** Whether the post is one the user can read (his own or shared with him). */
  entryVisible(userId: string, entryId: string): Promise<boolean>;
  /** The preview of the nightly pass for ONE user, writing nothing. Not wired yet: the route says 503 until the engine plugs it in. */
  rebuildPreview?: (userId: string) => Promise<RebuildPreviewItem[]>;
  /** The clock (a test fixes it). */
  now?: () => Date;
}

/** The real sources and the real store: what the server uses. */
export function realCollectionsRouteDeps(): CollectionsRouteDeps {
  return {
    sources: realViewSources(),
    store: new PgCollectionsStore(),
    entryVisible: entryVisibleTo,
    // the preview of the rebuild (an administrator, nothing written): the engine's own decisions, with the real local model for the names
    rebuildPreview: (userId) => rebuildPreview(userId, realEngineDeps()),
  };
}

type Query = Record<string, string | string[] | undefined>;

const STATES = ['active', 'hidden', 'watching'] as const;

/** The longest free words and names the filters take: a page is not a place to send a book. */
const MAX_FILTER = 100;
const MAX_QUERY = 200;

/** The text of a query parameter: undefined when it is missing or empty, null when it is not one text (given twice). */
function textParam(value: string | string[] | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  return value === '' ? undefined : value;
}

/** A whole number of a query parameter, in range; null when it is not one. */
function intParam(value: string | string[] | undefined, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (Array.isArray(value) || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** The query of a collection page, or the name of the parameter that is wrong. */
function parseDetailQuery(query: Query): { query: DetailQuery } | { error: string } {
  const limit = intParam(query.limit, 1, COLLECTION_VIEW.pageMax, COLLECTION_VIEW.pageDefault);
  if (limit === null) return { error: 'limit' };
  const offset = intParam(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  if (offset === null) return { error: 'offset' };
  const quando = textParam(query.quando);
  if (quando === null || (quando !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(quando))) return { error: 'quando' };
  const out: DetailQuery = { offset, limit };
  if (quando !== undefined) out.quando = quando;
  for (const [key, max] of [['dove', MAX_FILTER], ['fonte', MAX_FILTER], ['q', MAX_QUERY]] as const) {
    const value = textParam(query[key]);
    if (value === null || (value !== undefined && value.length > max)) return { error: key };
    if (value !== undefined) out[key] = value;
  }
  return { query: out };
}

/** A name for a collection: 1–60 characters, none of `#@"*`, no control character (spec §5.5: the signs the local model scatters in names). */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // a control character (a newline, a tab…) is refused as it comes: tidying the spaces first would let it through as a space
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 60 || /[#@"*]/.test(name)) return null;
  return name;
}

export function registerCollectionsRoutes(app: FastifyInstance, deps: CollectionsRouteDeps = realCollectionsRouteDeps()): void {
  const now = (): Date => (deps.now ? deps.now() : new Date());

  /** Never cached; the user from the Authelia header; a failure that is not the user's is a fixed 500 and goes to the log. */
  function guarded<Req extends FastifyRequest>(label: string, fn: (req: Req, reply: FastifyReply, user: RequestUser) => Promise<unknown>) {
    return async (req: Req, reply: FastifyReply): Promise<unknown> => {
      reply.header('Cache-Control', 'no-store');
      try {
        return await fn(req, reply, resolveUser(req));
      } catch (err) {
        logError(`${label} failed`, err);
        return reply.code(500).send({ error: 'collections_failed' });
      }
    };
  }

  /** A correction needs a user the family knows: a visitor with no `Remote-User` changes nothing. */
  const authenticated = (reply: FastifyReply, user: RequestUser): boolean => {
    if (user.authenticated) return true;
    reply.code(401).send({ error: 'authentication required' });
    return false;
  };

  /** The theme the user means: his own, not merged. A computed id is not editable; anything else that is not his is not there. */
  async function themeOf(userId: string, id: string): Promise<ThemeRow | null> {
    const rows = await deps.sources.themeRows(userId);
    return rows.find((t) => t.id === id && t.state !== 'merged') ?? null;
  }

  /** The collection as it is NOW (the answer of a correction): rebuilt from the sources, so it shows what the store just did. */
  async function nowOf(userId: string, id: string, reply: FastifyReply): Promise<unknown> {
    const found = await findCollection(userId, id, deps.sources, now());
    if (!found) return reply.code(404).send({ error: 'collection_not_found' });
    return { collection: found.item };
  }

  // ---------------------------------------------------------------------------------------------------- reads

  app.get<{ Querystring: Query }>('/api/collections', guarded('GET /api/collections', async (req, reply, user) => {
    const wanted = req.query.state;
    if (wanted !== undefined && (Array.isArray(wanted) || !(STATES as readonly string[]).includes(wanted))) {
      return reply.code(400).send({ error: 'invalid_query:state' });
    }
    const which = (wanted ?? 'active') as (typeof STATES)[number];
    if (which === 'watching' && !user.isAdmin) return reply.code(403).send({ error: 'admin_only' });
    return { collections: await collectionList(user.id, which, deps.sources, now()) };
  }));

  app.get<{ Params: { id: string }; Querystring: Query }>('/api/collections/:id', guarded('GET /api/collections/:id', async (req, reply, user) => {
    const parsed = parseDetailQuery(req.query);
    if ('error' in parsed) return reply.code(400).send({ error: `invalid_query:${parsed.error}` });
    const detail = await collectionDetail(user.id, req.params.id, parsed.query, deps.sources, now(), { includeWatching: user.isAdmin });
    if (!detail) return reply.code(404).send({ error: 'collection_not_found' });
    return detail;
  }));

  // ---------------------------------------------------------------------------------------------------- corrections (themes only)

  app.post<{ Params: { id: string }; Body: { name?: unknown } | undefined }>('/api/collections/:id/rename', guarded('POST /api/collections/:id/rename', async (req, reply, user) => {
    if (!authenticated(reply, user)) return reply;
    const { id } = req.params;
    if (isComputedId(id)) return reply.code(400).send({ error: 'not_editable' });
    const body = req.body as { name?: unknown } | undefined;
    const name = cleanName(body && typeof body === 'object' && !Array.isArray(body) ? body.name : undefined);
    if (name === null) return reply.code(400).send({ error: 'invalid_name' });
    if (!(await themeOf(user.id, id))) return reply.code(404).send({ error: 'collection_not_found' });
    let done: boolean;
    try {
      done = await deps.store.rename(user.id, id, name);
    } catch (err) {
      // the store cleans the name once more and refuses what is left empty: that is the name's fault, not the server's
      if (err instanceof Error && err.message === 'collection_name_required') return reply.code(400).send({ error: 'invalid_name' });
      throw err;
    }
    if (!done) return reply.code(404).send({ error: 'collection_not_found' });
    return nowOf(user.id, id, reply);
  }));

  app.post<{ Params: { id: string }; Body: { targetId?: unknown } | undefined }>('/api/collections/:id/merge', guarded('POST /api/collections/:id/merge', async (req, reply, user) => {
    if (!authenticated(reply, user)) return reply;
    const { id } = req.params;
    if (isComputedId(id)) return reply.code(400).send({ error: 'not_editable' });
    const body = req.body as { targetId?: unknown } | undefined;
    const targetId = body && typeof body === 'object' && !Array.isArray(body) ? body.targetId : undefined;
    // the target must be another THEME: not nothing, not itself, not a type or a place
    if (typeof targetId !== 'string' || targetId === '' || targetId === id || isComputedId(targetId)) {
      return reply.code(400).send({ error: 'invalid_target' });
    }
    const [source, target] = await Promise.all([themeOf(user.id, id), themeOf(user.id, targetId)]);
    if (!source || !target) return reply.code(404).send({ error: 'collection_not_found' });
    // posts do not go into a theme the user cannot see (hidden, under observation)
    if (target.state !== 'active') return reply.code(400).send({ error: 'invalid_target' });
    if (!(await deps.store.merge(user.id, id, targetId))) return reply.code(404).send({ error: 'collection_not_found' });
    return nowOf(user.id, targetId, reply);
  }));

  for (const action of ['hide', 'unhide'] as const) {
    app.post<{ Params: { id: string } }>(`/api/collections/:id/${action}`, guarded(`POST /api/collections/:id/${action}`, async (req, reply, user) => {
      if (!authenticated(reply, user)) return reply;
      const { id } = req.params;
      if (isComputedId(id)) return reply.code(400).send({ error: 'not_editable' });
      if (!(await themeOf(user.id, id))) return reply.code(404).send({ error: 'collection_not_found' });
      if (!(await deps.store[action](user.id, id))) return reply.code(404).send({ error: 'collection_not_found' });
      return { ok: true };
    }));
  }

  for (const [method, action] of [['POST', 'addEntry'], ['DELETE', 'removeEntry']] as const) {
    app.route<{ Params: { id: string; entryId: string } }>({
      method,
      url: '/api/collections/:id/entries/:entryId',
      handler: guarded(`${method} /api/collections/:id/entries/:entryId`, async (req, reply, user) => {
        if (!authenticated(reply, user)) return reply;
        const { id, entryId } = (req as FastifyRequest<{ Params: { id: string; entryId: string } }>).params;
        if (isComputedId(id)) return reply.code(400).send({ error: 'not_editable' });
        if (!(await themeOf(user.id, id))) return reply.code(404).send({ error: 'collection_not_found' });
        if (!(await deps.entryVisible(user.id, entryId))) return reply.code(404).send({ error: 'entry_not_found' });
        if (!(await deps.store[action](user.id, id, entryId))) return reply.code(404).send({ error: 'collection_not_found' });
        return { ok: true };
      }),
    });
  }

  // ---------------------------------------------------------------------------------------------------- the preview of the nightly pass

  app.post<{ Querystring: Query }>('/api/admin/collections/rebuild', guarded('POST /api/admin/collections/rebuild', async (req, reply, user) => {
    if (!user.isAdmin) return reply.code(403).send({ error: 'admin_only' });
    // the pass that writes is a script, run by hand with the OK of Michele: from here only a preview
    if (req.query.dry !== '1') return reply.code(400).send({ error: 'invalid_query:dry' });
    if (!deps.rebuildPreview) return reply.code(503).send({ error: 'rebuild_unavailable' });
    return { collections: await deps.rebuildPreview(user.id) };
  }));
}
