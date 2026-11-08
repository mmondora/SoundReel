/**
 * `GET /api/library/search` — find a song wherever it is: the journal, the media server, the local music folders
 * (spec 2026-11-07-library-search-music-folders-design.md, ADR-0011). Any signed-in user can search; what is
 * returned is the index (where files are), never the files.
 */
import type { FastifyInstance } from 'fastify';
import { searchLibrary, SEARCH_SCOPES, type SearchScope } from '../services/librarySearch';
import { logError } from '../utils/logger';
import { requireUser } from '../utils/requestUser';

interface SearchQuery {
  q?: string;
  scope?: string;
  limit?: string;
}

export function registerLibraryRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: SearchQuery }>('/api/library/search', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = (req.query.q ?? '').trim();
    if (q.length < 2) return reply.code(400).send({ error: 'query_too_short' });
    const scope = (req.query.scope ?? 'all') as SearchScope;
    if (!SEARCH_SCOPES.includes(scope)) return reply.code(400).send({ error: 'invalid_scope' });
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limit !== undefined && !Number.isFinite(limit)) return reply.code(400).send({ error: 'invalid_limit' });
    try {
      reply.header('Cache-Control', 'no-store');
      return await searchLibrary({ q, scope, limit, userId: user.id, isAdmin: user.isAdmin });
    } catch (err) {
      logError('GET /api/library/search failed', { err: String(err) });
      return reply.code(500).send({ error: 'library search failed' });
    }
  });
}
