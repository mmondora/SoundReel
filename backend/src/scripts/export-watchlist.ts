/**
 * Writes the film catalogue to the path given as argv[2]. Run by the nightly
 * fritz-sync job; safe to run by hand for a quick look.
 *
 *   npm run export:watchlist -- /tmp/watchlist.html
 */
import { writeFileSync } from 'fs';
import { listEntries } from '../utils/db';
import { listFilmMeta } from '../services/filmMeta';
import { aggregateFilms, LIST_ENTRIES_LIMIT } from '../routes/films';
import { renderWatchlistHtml } from '../services/watchlistExport';

async function main(): Promise<void> {
  const dest = process.argv[2];
  if (!dest) {
    console.error('usage: export-watchlist <dest.html>');
    process.exit(2);
  }

  const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listFilmMeta()]);
  const films = [...aggregateFilms(entries, metaMap).values()];
  writeFileSync(dest, renderWatchlistHtml(films), 'utf8');
  console.log(`watchlist: ${films.length} film -> ${dest}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('watchlist export failed:', err);
  process.exit(1);
});
