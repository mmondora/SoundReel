import type { FastifyInstance } from 'fastify';
import { pool } from '../utils/db';
import { listEntries, getEntry, deleteEntry, deleteAllEntries } from '../utils/db';

export function registerEntriesRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string } }>('/api/entries', async (req) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
    return await listEntries(limit);
  });

  app.get<{ Params: { id: string } }>('/api/entries/:id', async (req, reply) => {
    const entry = await getEntry(req.params.id);
    if (!entry) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    return entry;
  });

  app.delete<{ Params: { id: string } }>('/api/entries/:id', async (req) => {
    await deleteEntry(req.params.id);
    return { success: true };
  });

  app.delete('/api/entries', async () => {
    const deleted = await deleteAllEntries();
    return { success: true, deleted };
  });

  // SSE stream — broadcasts on Postgres NOTIFY
  app.get('/api/entries/stream', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    const client = await pool.connect();
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch {}
    }, 25_000);

    const onNotification = (msg: { channel: string; payload?: string }): void => {
      if (msg.channel !== 'entry_changed') return;
      reply.raw.write(`event: entry_changed\ndata: ${msg.payload || '{}'}\n\n`);
    };

    try {
      client.on('notification', onNotification);
      await client.query('LISTEN entry_changed');
      reply.raw.write('event: ready\ndata: {}\n\n');

      await new Promise<void>((resolve) => {
        req.raw.on('close', () => resolve());
      });
    } finally {
      clearInterval(heartbeat);
      try { await client.query('UNLISTEN entry_changed'); } catch {}
      client.removeListener('notification', onNotification);
      client.release();
      try { reply.raw.end(); } catch {}
    }
  });
}
