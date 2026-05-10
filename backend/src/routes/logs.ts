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
  app.get<{ Querystring: { limit?: string; level?: string; entryId?: string } }>('/api/logs', async (req) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
    const conditions: string[] = [];
    const params: unknown[] = [];
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
