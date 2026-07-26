/**
 * Backfill/refresh streaming availability for all films across entries,
 * idempotently skipping those recently checked (within TTL).
 *
 * Reads up to 10,000 entries, compares against existing film_meta, fetches
 * streaming availability from the active provider (Watchmode or Movie of the Night),
 * and upserts results. Respects a configurable TTL (default 30 days) to avoid
 * unnecessary API calls for recently checked films.
 *
 * Purely additive: it only upserts streaming data and never modifies entries.
 * Quota-aware: on HTTP 429 (API quota exhausted), aborts cleanly with a status
 * message rather than hammering the API.
 *
 * Usage (inside the container):
 *   node dist/scripts/backfillStreaming.js --dry-run
 *   node dist/scripts/backfillStreaming.js
 */
import { pool, listEntries } from '../utils/db';
import { refreshStreamingForFilm, extractImdbId, isStale } from '../services/streamingRefresher';
import { streamingConfigured, activeProvider } from '../services/streamingAvailability';
import { filmKey, listFilmMeta } from '../services/filmMeta';

const DRY_RUN = process.argv.includes('--dry-run');
const STREAMING_TTL_DAYS = Number(process.env.STREAMING_TTL_DAYS || 30);
const DELAY_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!streamingConfigured()) {
    console.log(`[streaming] provider not configured, skipping backfill`);
    await pool.end();
    return;
  }

  const entries = await listEntries(10000);
  const existing = await listFilmMeta();

  // Aggregate films from entries: dedupe by filmKey, capture first non-null imdbUrl
  const filmsFromEntries = new Map<string, { title: string; year: string | null; imdbUrl: string | null }>();
  for (const entry of entries) {
    const films = entry.results?.films;
    if (!Array.isArray(films)) continue;
    for (const film of films) {
      if (!film || typeof film.title !== 'string' || !film.title.trim()) continue;
      const key = filmKey(film.title, film.year);
      if (!filmsFromEntries.has(key)) {
        const year =
          typeof film.year === 'string' ? film.year : typeof film.year === 'number' ? String(film.year) : null;
        filmsFromEntries.set(key, {
          title: film.title.trim(),
          year,
          imdbUrl: film.imdbUrl ?? null,
        });
      }
    }
  }

  // Target films: those with an extractable IMDb id and stale/null streaming_checked_at
  const targets = new Map<
    string,
    { title: string; year: string | null; imdbId: string; watchmodeTitleId: number | null }
  >();

  for (const [key, filmData] of filmsFromEntries) {
    const imdbId = extractImdbId(filmData.imdbUrl);
    if (!imdbId) continue;

    const meta = existing.get(key);
    if (meta && !isStale(meta.streamingCheckedAt, STREAMING_TTL_DAYS)) continue; // already fresh

    targets.set(key, {
      title: filmData.title,
      year: filmData.year,
      imdbId,
      watchmodeTitleId: meta?.watchmodeTitleId ?? null,
    });
  }

  console.log(`[streaming] ${targets.size} films to check${DRY_RUN ? ' (dry-run)' : ''}`);
  let updated = 0;
  let empty = 0;
  let failed = 0;

  for (const [key, film] of targets) {
    if (DRY_RUN) {
      console.log(`  ${key} (${film.imdbId})`);
      continue;
    }

    try {
      const options = await refreshStreamingForFilm({
        filmKey: key,
        imdbId: film.imdbId,
        cachedTitleId: film.watchmodeTitleId,
      });

      if (options.length === 0) {
        console.log(`[streaming] EMPTY ${key} (${film.imdbId})`);
        empty++;
      } else {
        console.log(`[streaming] OK    ${key} (${film.imdbId}) [${options.map((o) => o.platform).join(', ')}]`);
        updated++;
      }
    } catch (err) {
      const errorStr = String(err);
      if (errorStr.includes('429')) {
        console.log(`[streaming] QUOTA exhausted, aborting`);
        console.log(
          `\n[streaming] done — updated: ${updated} | empty: ${empty} | errors: ${failed} | provider: ${activeProvider()}`
        );
        await pool.end();
        return;
      }
      failed++;
      console.log(`[streaming] ERROR ${key} (${film.imdbId}) — ${errorStr}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `\n[streaming] done — updated: ${updated} | empty: ${empty} | errors: ${failed} | provider: ${activeProvider()}`
  );
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[streaming] fatal error', err);
    process.exit(1);
  });
}
