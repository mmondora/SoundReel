import type { FastifyInstance } from 'fastify';
import { query } from '../utils/db';

interface LogRow {
  id: number;
  ts: Date;
  level: string;
  category: string | null;
  entry_id: string | null;
  message: string;
  data: unknown;
}

export function registerLogsRoutes(app: FastifyInstance): void {
  // `category=a,b` and `since` filter on the SERVER (ADR-0009): filtering after fetching the latest 200 rows of everything
  // lets pipeline noise push the activity lines (playlist, sync, download, device) out of the window.
  app.get<{ Querystring: { limit?: string; level?: string; entryId?: string; category?: string; since?: string } }>('/api/logs', async (req, reply) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
    const conditions: string[] = [];
    const params: unknown[] = [];
    const categories = (req.query.category ?? '').split(',').map((c) => c.trim()).filter(Boolean).slice(0, 20);
    if (categories.length > 0) {
      params.push(categories);
      conditions.push(`category = ANY($${params.length}::text[])`);
    }
    if (req.query.since) {
      const since = Date.parse(req.query.since);
      if (!Number.isFinite(since)) return reply.code(400).send({ error: 'invalid_since' });
      params.push(new Date(since));
      conditions.push(`ts >= $${params.length}`);
    }
    if (req.query.level) {
      params.push(req.query.level);
      conditions.push(`level = $${params.length}`);
    }
    if (req.query.entryId) {
      params.push(req.query.entryId);
      conditions.push(`entry_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const rows = await query<LogRow>(
      `SELECT id, ts, level, category, entry_id, message, data
       FROM logs ${where} ORDER BY ts DESC LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      level: r.level,
      category: r.category,
      entryId: r.entry_id,
      message: r.message,
      data: r.data,
    }));
  });

  app.delete('/api/logs', async () => {
    await query('DELETE FROM logs');
    return { success: true };
  });
}
