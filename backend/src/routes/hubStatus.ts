import type { FastifyInstance } from 'fastify';
import { countEntries, latestEntryTimestamp } from '../utils/db';
import { getPlaylistTrackCount } from '../services/spotify';

const VERSION = process.env.npm_package_version || '2.0.0';
const GIT_REVISION = process.env.GIT_REVISION || 'unknown';

let cache: { ts: number; payload: Record<string, unknown> } | null = null;
const CACHE_TTL = 45_000;

export function registerHubStatusRoute(app: FastifyInstance): void {
  app.get('/hub/status', async () => {
    if (cache && Date.now() - cache.ts < CACHE_TTL) {
      return cache.payload;
    }
    const [entries_count, last_entry_at, spotify_tracks_count] = await Promise.all([
      countEntries().catch(() => 0),
      latestEntryTimestamp().catch(() => null),
      getPlaylistTrackCount().catch(() => 0),
    ]);
    const payload = {
      version: VERSION,
      revision: GIT_REVISION,
      entries_count,
      last_entry_at: last_entry_at ? last_entry_at.replace(/\.\d+Z$/, 'Z').replace(/([+-]\d{2}):?(\d{2})$/, 'Z') : null,
      spotify_tracks_count,
    };
    cache = { ts: Date.now(), payload };
    return payload;
  });
}

export function registerHubAboutRoute(app: FastifyInstance): void {
  app.get('/hub/about', async () => ({
    name: 'soundreel',
    version: VERSION,
    revision: GIT_REVISION,
    built_at: process.env.BUILD_DATE || null,
    source: 'https://github.com/mmondora/soundreel',
    changelog_url: 'https://github.com/mmondora/soundreel/blob/main/CHANGELOG.md',
    developer: 'mike (mmondora@mondora.com)',
    stack: 'fastify + postgres',
  }));
}
