import { listEntries } from '../utils/db';
import { searchFilm } from '../services/filmSearch';
import { filmKey, listFilmMeta, upsertFilmEnrichment } from '../services/filmMeta';
import type { Film } from '../types';

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
    for (const film of films as Film[]) {
      if (!film || typeof film.title !== 'string' || !film.title.trim()) continue;
      const key = filmKey(film.title, film.year);
      const meta = existing.get(key);
      if (meta && meta.genres.length > 0) continue; // already enriched
      if (!targets.has(key)) targets.set(key, { title: film.title.trim(), year: film.year ?? null });
    }
  }

  console.log(`${targets.size} films to enrich${DRY_RUN ? ' (dry-run)' : ''}`);
  let ok = 0;
  let miss = 0;

  for (const [key, film] of targets) {
    if (DRY_RUN) {
      console.log(`[dry-run] ${key}`);
      continue;
    }
    const tmdb = await searchFilm(film.title, film.year);
    if (!tmdb || (tmdb.genres.length === 0 && !tmdb.overview)) {
      console.log(`MISS  ${key}`);
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
      console.log(`OK    ${key} [${tmdb.genres.join(', ')}]`);
      ok++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`Done: ${ok} enriched, ${miss} misses, ${targets.size} total`);
  process.exit(0);
}

main().catch((err) => {
  console.error('backfill failed', err);
  process.exit(1);
});
