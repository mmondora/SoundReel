import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { pool, query } from './utils/db';
import { registerAnalyzeRoute } from './routes/analyze';
import { registerTelegramRoute } from './routes/telegram';
import { registerEntriesRoutes } from './routes/entries';
import { registerConfigRoutes } from './routes/config';
import { registerSpotifyRoutes } from './routes/spotify';
import { registerHubStatusRoute } from './routes/hubStatus';
import { registerLogsRoutes } from './routes/logs';
import { registerPromptsRoutes } from './routes/prompts';
import { registerMediaRoute } from './routes/media';
import { registerAdminRoutes, runCleanup } from './routes/admin';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

async function bootstrap(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 10 * 1024 * 1024,
    disableRequestLogging: false,
  });

  await app.register(fastifyCors, { origin: true });

  registerAnalyzeRoute(app);
  registerTelegramRoute(app);
  registerEntriesRoutes(app);
  registerConfigRoutes(app);
  registerSpotifyRoutes(app);
  registerHubStatusRoute(app);
  registerLogsRoutes(app);
  registerPromptsRoutes(app);
  registerMediaRoute(app);
  registerAdminRoutes(app);

  // Serve static frontend (after routes so /api/* wins)
  const publicDir = path.resolve(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/telegram/')) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
  }

  app.get('/health', async () => ({ ok: true }));

  await app.listen({ host: HOST, port: PORT });
  app.log.info(`SoundReel backend listening on ${HOST}:${PORT}`);

  await query('SELECT 1');
  app.log.info('Postgres connection verified');

  // Startup cleanup + daily schedule (orphan + retention purge)
  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const kickCleanup = async (): Promise<void> => {
    try {
      const result = await runCleanup();
      app.log.info({ msg: 'cleanup cycle done', ...result });
    } catch (err) {
      app.log.error({ err }, 'cleanup cycle failed');
    }
  };
  // Run after 60s boot grace, then every 24h
  setTimeout(() => void kickCleanup(), 60_000);
  setInterval(() => void kickCleanup(), CLEANUP_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap server', err);
  process.exit(1);
});
