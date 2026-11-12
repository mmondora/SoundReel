import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { pool, query } from './utils/db';
import { registerAnalyzeRoute } from './routes/analyze';
import { registerTelegramRoute } from './routes/telegram';
import { registerEntriesRoutes } from './routes/entries';
import { registerEntriesIndexRoutes } from './routes/entriesIndex';
import { registerConfigRoutes } from './routes/config';
import { registerSpotifyRoutes } from './routes/spotify';
import { registerHubStatusRoute, registerHubAboutRoute } from './routes/hubStatus';
import { registerLogsRoutes } from './routes/logs';
import { registerPromptsRoutes } from './routes/prompts';
import { registerMediaRoute } from './routes/media';
import { registerAdminRoutes, runCleanup } from './routes/admin';
import { registerSearchRoute } from './routes/search';
import { registerMusicListRoute } from './routes/musicList';
import { registerFilmsRoutes } from './routes/films';
import { registerSongsRoutes } from './routes/songs';
import { registerPlaylistsRoutes } from './routes/playlists';
import { registerStatsRoutes } from './routes/stats';
import { registerNetRoutes } from './routes/net';
import { registerLibraryRoutes } from './routes/library';
import { startMusicFoldersSync } from './services/musicFolders';
import { startReleaseYearBackfill } from './services/releaseYearBackfill';
import { startInboxSweeper } from './services/inboxSweeper';
import { startUsageCounters } from './services/usageCounters';
import { registerNotesRoutes } from './routes/notes';
import { registerSoftwareRoutes } from './routes/software';
import { registerTtsRoutes } from './routes/tts';
import { registerShareRoute } from './routes/share';
import { registerMondropRoutes } from './routes/mondrop';
import { registerMondropInboxRoutes } from './routes/mondropInbox';
import { registerMondropLikesRoutes } from './routes/mondropLikes';
import { registerMondropReelsRoutes } from './routes/mondropReels';
import { MAX_ENCODED_SONG_KEY } from './services/songLikes';
import { registerMeRoute } from './routes/me';
import { registerUiPrefsRoutes } from './routes/uiPrefs';
import { registerWebHomeRoute } from './routes/webHome';
import { registerCollectionsRoutes } from './routes/collections';
import { registerMondropConnectRoutes } from './routes/mondropConnect';
import { requeueStuckJobs } from './utils/jobQueue';
import { startGenrePlaylistSweep } from './services/genrePlaylistSweepWiring';
import { startNightlyConsolidation } from './services/collectionsNightly';
import { startJobQueueWorker } from './services/jobQueueWorker';
import { startSpootyWatcher } from './services/spootyWatcher';
import { startSongDownloader } from './services/songDownloader';
import { startMediaServerSync } from './services/mediaServer';
import { sendTelegramMessage } from './routes/telegram';
import { runMigrations } from './db/runMigrations';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

async function bootstrap(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 10 * 1024 * 1024,
    disableRequestLogging: false,
    // a song key is in the path of the Mondrop routes (up to 500 characters, nine each once percent-encoded): the default of 100 answers 404 to a long title
    maxParamLength: MAX_ENCODED_SONG_KEY,
  });

  await app.register(fastifyCors, { origin: true });

  // How the site is used (spec web-mobile-ux M8): aggregated counters, no IP / user-agent / path stored. The hook
  // has to be added before the server starts listening.
  const stopUsageCounters = startUsageCounters(app);

  registerAnalyzeRoute(app);
  registerTelegramRoute(app);
  registerEntriesRoutes(app);
  registerEntriesIndexRoutes(app); // the facets of the Inbox filters (docs/entries-index.md): behind Authelia like /api/entries, never under /api/mondrop or /api/share
  registerConfigRoutes(app);
  registerSpotifyRoutes(app);
  registerHubStatusRoute(app);
  registerHubAboutRoute(app);
  registerLogsRoutes(app);
  registerPromptsRoutes(app);
  registerMediaRoute(app);
  registerAdminRoutes(app);
  registerSearchRoute(app);
  registerMusicListRoute(app);
  registerFilmsRoutes(app);
  registerSongsRoutes(app);
  registerPlaylistsRoutes(app);
  registerStatsRoutes(app);
  registerNetRoutes(app);
  registerLibraryRoutes(app);
  registerNotesRoutes(app);
  registerSoftwareRoutes(app);
  registerTtsRoutes(app);
  registerShareRoute(app);
  registerMondropRoutes(app);
  registerMondropInboxRoutes(app);
  registerMondropLikesRoutes(app); // the likes of the songs: the Mondrop key like the other /api/mondrop routes (Traefik bypasses Authelia there), ADR-0028
  registerMondropReelsRoutes(app); // what a reel contains, decomposed and explained, without the address of any post: the Mondrop key like the other /api/mondrop routes, ADR-0033
  registerMeRoute(app);
  registerUiPrefsRoutes(app); // the configuration of the site, per user: behind Authelia like /api/me (ADR-0026)
  registerWebHomeRoute(app); // the front page of the site in sections: behind Authelia like /api/me, never under /api/mondrop or /api/share
  registerCollectionsRoutes(app); // the collections of the site (themes, places, types) and their corrections: behind Authelia like /api/me, never under /api/mondrop or /api/share
  registerMondropConnectRoutes(app); // behind Authelia: keep OFF /api/share and /api/mondrop (bypass routers)

  // Serve static frontend (after routes so /api/* wins)
  const publicDir = path.resolve(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    // Hashed /assets/* can be cached forever; index.html must always revalidate
    // so Safari/iOS does not keep an old entry pointing at a previous bundle.
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === 'index.html') {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/telegram/')) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      reply
        .header('Cache-Control', 'no-store, no-cache, must-revalidate')
        .header('Pragma', 'no-cache')
        .type('text/html')
        .sendFile('index.html');
    });
  }

  app.get('/health', async () => ({ ok: true }));

  await query('SELECT 1');
  app.log.info('Postgres connection verified');

  const applied = await runMigrations();
  if (applied.length) {
    app.log.info(`Migration applicate: ${applied.join(', ')}`);
  }

  await app.listen({ host: HOST, port: PORT });
  app.log.info(`SoundReel backend listening on ${HOST}:${PORT}`);

  const requeuedCount = await requeueStuckJobs();
  if (requeuedCount > 0) {
    app.log.warn(`Requeued ${requeuedCount} job(s) stuck in 'processing' from a previous crash/restart`);
  }
  startJobQueueWorker();
  app.log.info('Job queue worker started');

  // Follows Spotify links handed to Spooty (metadata + download outcome) and tells the
  // Telegram chat that sent them. State lives in `spooty_requests`, so restarts lose nothing.
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const stopSpootyWatcher = startSpootyWatcher({
    notify: telegramToken ? (chatId, html) => sendTelegramMessage(chatId, html, telegramToken) : undefined,
  });
  app.log.info('Spooty watcher started');

  // Songs that are not on disk yet: reuse a file we have, else fetch it from YouTube into <library>/SoundReel.
  // The queue lives in `song_files`, so a restart loses nothing (interrupted jobs are requeued).
  const stopSongDownloader = startSongDownloader();
  app.log.info('Song downloader started');

  // The home media server (FRITZ!Box): its catalogue feeds "reuse first", and a replica of the library on it
  // is verified before clients are pointed at it. Plain HTTP; a sleeping box only costs a timeout.
  const stopMediaServerSync = startMediaServerSync();

  // The music folders the library search looks into (Spooty's folder + the ones set in the web configuration).
  const stopMusicFoldersSync = startMusicFoldersSync();

  // One-off, gentle pass: the release year of the songs enriched before 2.9.0 ("anni 80", ADR-0013).
  const stopReleaseYearBackfill = startReleaseYearBackfill();

  // The Mondrop inbox housekeeping: information expires after 3 days, errors never do (ADR-0015).
  const stopInboxSweeper = startInboxSweeper();

  // The playlists of a genre that has the songs and no playlist yet (Latina, Techno…): once a day, the same dynamic playlist a post of the theme would
  // have made; one the user deleted is never made again (ADR-0024). AUTO_PLAYLISTS=0 switches it off with the rest of the automatic playlists.
  const stopGenrePlaylistSweep = startGenrePlaylistSweep();
  app.log.info('Genre playlist sweep started (first run in about 2 minutes, then every 24 hours)');

  // The collections of the library (ADR-0022): once a day the groups are made again on every vector, with the ids and the names that last and the
  // corrections of the user applied last. The first pass is ten minutes after the boot, never at it. COLLECTIONS_AUTO=0 starts nothing.
  const nightlyCollections = startNightlyConsolidation();
  app.log.info('Collections nightly pass scheduled (first run in about 10 minutes, then every 24 hours)');

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
      stopSpootyWatcher();
      stopSongDownloader();
      stopMediaServerSync();
      stopMusicFoldersSync();
      stopReleaseYearBackfill();
      stopInboxSweeper();
      stopGenrePlaylistSweep();
      nightlyCollections.stop();
      stopUsageCounters();
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
