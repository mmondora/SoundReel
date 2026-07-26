/**
 * Backfill/refresh Deezer/iTunes enrichment (cover, genres, album, direct
 * links) for every song mentioned across entries, idempotently skipping
 * songs recently enriched (within TTL).
 *
 * Reads up to 10,000 entries, dedupes mentions by songKey, compares against
 * existing song_meta, fetches enrichment via enrichSong() (Deezer first,
 * iTunes fallback), and upserts results. Respects a configurable TTL
 * (default 30 days) to avoid unnecessary calls for recently enriched songs.
 *
 * Purely additive: it only upserts enrichment columns and never touches
 * user state (listened/favorite/downloaded/rating/score) or entries.
 *
 * Deezer (50 req/5s) and iTunes (~20 req/min, fallback only) have no hard
 * quota that returns a clean abort signal, unlike Watchmode. Instead this
 * script counts consecutive errors and aborts after 10 in a row, on the
 * assumption that's a systemic failure (network down, DNS, etc.) rather
 * than per-song misses.
 *
 * Usage (inside the container):
 *   node dist/scripts/backfillSongMeta.js --dry-run
 *   node dist/scripts/backfillSongMeta.js
 */
import { pool, listEntries } from '../utils/db';
import { songKey, listSongMeta, upsertSongEnrichment } from '../services/songMeta';
import { enrichSong } from '../services/songEnrichment';
import { isStale } from '../services/streamingRefresher';

const DRY_RUN = process.argv.includes('--dry-run');
const SONG_ENRICHMENT_TTL_DAYS = Number(process.env.SONG_ENRICHMENT_TTL_DAYS || 30);
const DELAY_MS = 300;
const MAX_CONSECUTIVE_ERRORS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const entries = await listEntries(10000);
  const existing = await listSongMeta();

  // Aggregate songs from entries: dedupe by songKey, capture first title/artist seen.
  const songsFromEntries = new Map<string, { title: string; artist: string }>();
  for (const entry of entries) {
    const songs = entry.results?.songs;
    if (!Array.isArray(songs)) continue;
    for (const song of songs) {
      if (!song || typeof song.title !== 'string' || !song.title.trim()) continue;
      const artist = typeof song.artist === 'string' ? song.artist : '';
      const key = songKey(artist, song.title);
      if (!songsFromEntries.has(key)) {
        songsFromEntries.set(key, { title: song.title.trim(), artist });
      }
    }
  }

  // Target songs: those with null/stale enriched_at.
  const targets = new Map<string, { title: string; artist: string }>();
  for (const [key, songData] of songsFromEntries) {
    const meta = existing.get(key);
    if (meta && !isStale(meta.enrichedAt, SONG_ENRICHMENT_TTL_DAYS)) continue; // already fresh
    targets.set(key, songData);
  }

  console.log(`[song-meta] ${targets.size} songs to check${DRY_RUN ? ' (dry-run)' : ''}`);
  let enriched = 0;
  let miss = 0;
  let errors = 0;
  let consecutiveErrors = 0;

  for (const [key, song] of targets) {
    if (DRY_RUN) {
      console.log(`  ${key}`);
      continue;
    }

    try {
      const result = await enrichSong(song.artist, song.title);
      if (result) {
        await upsertSongEnrichment({ songKey: key, ...result });
        console.log(`[song-meta] OK    ${key} [${result.deezerId ? 'deezer' : 'itunes'}]`);
        enriched++;
      } else {
        console.log(`[song-meta] MISS  ${key}`);
        miss++;
      }
      consecutiveErrors = 0;
    } catch (err) {
      errors++;
      consecutiveErrors++;
      console.log(`[song-meta] ERROR ${key} — ${String(err)}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`[song-meta] ${MAX_CONSECUTIVE_ERRORS} consecutive errors, aborting`);
        console.log(
          `\n[song-meta] done — enriched: ${enriched} | miss: ${miss} | errors: ${errors}`
        );
        await pool.end();
        return;
      }
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `\n[song-meta] done — enriched: ${enriched} | miss: ${miss} | errors: ${errors}`
  );
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[song-meta] fatal error', err);
    process.exit(1);
  });
}
