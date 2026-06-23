import type { FastifyInstance } from 'fastify';
import { query } from '../utils/db';
import { expandQuery } from '../services/queryExpander';
import { logInfo, logError } from '../utils/logger';

interface SearchRow {
  id: string;
  source_url: string;
  source_platform: string;
  caption: string | null;
  thumbnail_url: string | null;
  results: unknown;
  created_at: Date;
  rank: number;
}

interface SearchResultItem {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  caption: string | null;
  thumbnailUrl: string | null;
  results: unknown;
  createdAt: string;
  rank: number;
}

interface SearchResponse {
  results: SearchResultItem[];
  expandedTerms: string[];
  total: number;
}

export function registerSearchRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search',
    async (req, reply) => {
      const q = (req.query.q ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));

      if (q.length < 2) {
        return { results: [], expandedTerms: [], total: 0 } satisfies SearchResponse;
      }

      const expandedTerms = await expandQuery(q);

      // Build parameterized query: original terms OR each synonym term
      // $1 = original query, $2 = limit, $3..N = synonym terms
      const params: unknown[] = [q, limit];
      let combinedQuery = `websearch_to_tsquery('simple', $1)`;

      if (expandedTerms.length > 0) {
        const synonymClauses = expandedTerms.map((term, i) => {
          params.push(term);
          return `websearch_to_tsquery('simple', $${i + 3})`;
        });
        combinedQuery = `(${combinedQuery} || ${synonymClauses.join(' || ')})`;
      }

      const sql = `
        SELECT
          id,
          source_url,
          source_platform,
          caption,
          thumbnail_url,
          results,
          created_at,
          ts_rank(search_vector, ${combinedQuery}) AS rank
        FROM entries
        WHERE search_vector @@ ${combinedQuery}
        ORDER BY rank DESC
        LIMIT $2
      `;

      try {
        const rows = await query<SearchRow>(sql, params);

        const results: SearchResultItem[] = rows.map((r) => ({
          id: r.id,
          sourceUrl: r.source_url,
          sourcePlatform: r.source_platform,
          caption: r.caption,
          thumbnailUrl: r.thumbnail_url,
          results: r.results,
          createdAt: r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
          rank: r.rank,
        }));

        logInfo('Search', { q, synonyms: expandedTerms.length, found: results.length });
        return { results, expandedTerms, total: results.length } satisfies SearchResponse;
      } catch (err) {
        logError('Search query failed', { err: String(err), q });
        return reply.code(500).send({ error: 'Search failed' });
      }
    }
  );
}
