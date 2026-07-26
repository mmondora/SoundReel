/**
 * Backfill TMDb film enrichment (genres, overview, cast, score) for all films
 * mentioned across entries, idempotently skipping those already enriched.
 *
 * Reads up to 10,000 entries, compares against existing film_meta, searches
 * TMDb for missing enrichments, and upserts results. Rate-limited to 250ms
 * per film to avoid TMDb throttling.
 *
 * Purely additive: it only upserts enrichment data and never modifies entries.
 *
 * Usage (inside the container):
 *   node dist/scripts/backfillFilmMeta.js --dry-run
 *   node dist/scripts/backfillFilmMeta.js
 */
import { pool, listEntries } from '../utils/db';
import { searchFilm } from '../services/filmSearch';
import { filmKey, listFilmMeta, upsertFilmEnrichment } from '../services/filmMeta';

const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const entries = await listEntries(10000);
  const existing = await listFilmMeta();

  const targets = new Map<string, { title: string; year: string | null }>();
  for (const entry of entries) {
    const films = entry.results?.films;
    if (!Array.isArray(films)) continue;
    for (const film of films) {
      if (!film || typeof film.title !== 'string' || !film.title.trim()) continue;
      const key = filmKey(film.title, film.year);
      const meta = existing.get(key);
      if (meta && meta.genres.length > 0) continue; // already enriched
      if (!targets.has(key)) targets.set(key, { title: film.title.trim(), year: film.year ?? null });
    }
  }

  console.log(`[film-meta] ${targets.size} films to enrich${DRY_RUN ? ' (dry-run)' : ''}`);
  let ok = 0;
  let miss = 0;
  let failed = 0;

  for (const [key, film] of targets) {
    if (DRY_RUN) {
      console.log(`  ${key}`);
      continue;
    }
    try {
      const tmdb = await searchFilm(film.title, film.year);
      if (!tmdb || (tmdb.genres.length === 0 && !tmdb.overview)) {
        console.log(`[film-meta] MISS  ${key}`);
        miss++;
      } else {
        await upsertFilmEnrichment({
          filmKey: key,
          tmdbId: tmdb.id,
          genres: tmdb.genres,
          overview: tmdb.overview,
          cast: tmdb.cast,
          tmdbScore: tmdb.voteAverage,
        });
        console.log(`[film-meta] OK    ${key} [${tmdb.genres.join(', ')}]`);
        ok++;
      }
    } catch (err) {
      failed++;
      console.log(`[film-meta] ERRORE ${key} — ${String(err)}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n[film-meta] done — enriched: ${ok} | misses: ${miss} | errors: ${failed}`);
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[film-meta] errore fatale', err);
    process.exit(1);
  });
}
