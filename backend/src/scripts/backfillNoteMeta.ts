/**
 * Backfill/refresh enrichment for every book- and place-category note
 * mentioned across entries, idempotently skipping notes recently enriched
 * (within TTL). Book notes go through OpenLibrary (enrichBook); place notes
 * go through Nominatim/OSM (enrichPlace).
 *
 * Reads up to 10,000 entries, dedupes mentions by noteKey (which embeds the
 * normalized category), keeps only 'book'/'place' notes, compares against
 * existing note_meta, fetches enrichment via the category-appropriate
 * provider, and upserts results via the matching upsert (upsertNoteEnrichment
 * for book, upsertPlaceEnrichment for place — each only ever touches its own
 * columns). Respects a configurable TTL (default 30 days) to avoid
 * unnecessary calls for recently enriched notes. A clean miss (no accepted
 * candidate) still stamps enriched_at=now() via touchNoteEnrichedAt — NOT
 * the all-null upsert — so the TTL also caps retries for notes that just
 * don't resolve, without wiping any GOOD data a prior successful enrichment
 * left on that row (e.g. a transient provider hiccup on a stale re-check).
 *
 * Purely additive: it only upserts note_meta and never touches entries.
 *
 * Neither OpenLibrary nor Nominatim have an API key or a hard quota that
 * returns a clean abort signal. Nominatim's usage policy caps requests at
 * 1/s, so this script is polite (1.1s between requests, safely under that
 * cap — on top of placeEnrichment's own 1.1s module-level throttle, which
 * also covers the pipeline hook) and, like backfillSongMeta, counts
 * consecutive errors and aborts after 10 in a row, on the assumption that's
 * a systemic failure (network down, DNS, etc.) rather than per-note misses.
 * For places this uses enrichPlaceDetailed so an HTTP/network failure
 * ('error') can be told apart from an ordinary no-match ('miss') — only the
 * former counts toward the abort threshold. Book misses/errors remain
 * indistinguishable (enrichBook has no Detailed variant) and are both
 * treated as a miss, matching this script's pre-existing behavior for books.
 *
 * Usage (inside the container):
 *   node dist/scripts/backfillNoteMeta.js --dry-run
 *   node dist/scripts/backfillNoteMeta.js
 */
import { pool, listEntries } from '../utils/db';
import {
  noteKey,
  normalizeNoteCategory,
  listNoteMeta,
  upsertNoteEnrichment,
  upsertPlaceEnrichment,
  touchNoteEnrichedAt,
} from '../services/noteMeta';
import { enrichBook } from '../services/bookEnrichment';
import { enrichPlaceDetailed } from '../services/placeEnrichment';
import { isStale } from '../services/streamingRefresher';

const DRY_RUN = process.argv.includes('--dry-run');
const NOTE_ENRICHMENT_TTL_DAYS = Number(process.env.NOTE_ENRICHMENT_TTL_DAYS || 30);
const DELAY_MS = 1100;
const MAX_CONSECUTIVE_ERRORS = 10;

type BackfillCategory = 'book' | 'place';
const BACKFILL_CATEGORIES: readonly BackfillCategory[] = ['book', 'place'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const entries = await listEntries(10000);
  const existing = await listNoteMeta();

  // Aggregate book/place notes from entries: dedupe by noteKey, capture
  // first text + category seen.
  const notesFromEntries = new Map<string, { text: string; category: BackfillCategory }>();
  for (const entry of entries) {
    const notes = entry.results?.notes;
    if (!Array.isArray(notes)) continue;
    for (const note of notes) {
      if (!note || typeof note.text !== 'string' || !note.text.trim()) continue;
      const category = normalizeNoteCategory(note.category);
      if (category !== 'book' && category !== 'place') continue;
      const text = note.text.trim();
      const key = noteKey(category, text);
      if (!notesFromEntries.has(key)) {
        notesFromEntries.set(key, { text, category });
      }
    }
  }

  // Target notes: those with null/stale enriched_at.
  const targets = new Map<string, { text: string; category: BackfillCategory }>();
  for (const [key, noteData] of notesFromEntries) {
    const meta = existing.get(key);
    if (meta && !isStale(meta.enrichedAt, NOTE_ENRICHMENT_TTL_DAYS)) continue; // already fresh
    targets.set(key, noteData);
  }

  console.log(`[note-meta] ${targets.size} book/place notes to check${DRY_RUN ? ' (dry-run)' : ''}`);
  const enriched: Record<BackfillCategory, number> = { book: 0, place: 0 };
  const miss: Record<BackfillCategory, number> = { book: 0, place: 0 };
  const errors: Record<BackfillCategory, number> = { book: 0, place: 0 };
  let consecutiveErrors = 0;

  for (const [key, note] of targets) {
    if (DRY_RUN) {
      console.log(`  [${note.category}] ${key}`);
      continue;
    }

    try {
      if (note.category === 'book') {
        const result = await enrichBook(note.text);
        if (result) {
          await upsertNoteEnrichment({ noteKey: key, ...result });
          console.log(`[note-meta] OK    [book] ${key}`);
          enriched.book++;
        } else {
          // Touch enriched_at only — an all-null upsert would wipe a stale
          // row's GOOD prior data on an ordinary re-check miss.
          await touchNoteEnrichedAt(key);
          console.log(`[note-meta] MISS  [book] ${key}`);
          miss.book++;
        }
        consecutiveErrors = 0;
      } else {
        const outcome = await enrichPlaceDetailed(note.text);
        if (outcome.status === 'hit') {
          await upsertPlaceEnrichment({ noteKey: key, ...outcome.result });
          console.log(`[note-meta] OK    [place] ${key}`);
          enriched.place++;
          consecutiveErrors = 0;
        } else if (outcome.status === 'miss') {
          // Same rationale as the book miss above — touch only, never wipe.
          await touchNoteEnrichedAt(key);
          console.log(`[note-meta] MISS  [place] ${key}`);
          miss.place++;
          consecutiveErrors = 0;
        } else {
          errors.place++;
          consecutiveErrors++;
          console.log(`[note-meta] ERROR [place] ${key}`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.log(`[note-meta] ${MAX_CONSECUTIVE_ERRORS} consecutive errors, aborting`);
            logSummary(enriched, miss, errors);
            await pool.end();
            return;
          }
        }
      }
    } catch (err) {
      errors[note.category]++;
      consecutiveErrors++;
      console.log(`[note-meta] ERROR [${note.category}] ${key} — ${String(err)}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`[note-meta] ${MAX_CONSECUTIVE_ERRORS} consecutive errors, aborting`);
        logSummary(enriched, miss, errors);
        await pool.end();
        return;
      }
    }

    await sleep(DELAY_MS);
  }

  logSummary(enriched, miss, errors);
  await pool.end();
}

function logSummary(
  enriched: Record<BackfillCategory, number>,
  miss: Record<BackfillCategory, number>,
  errors: Record<BackfillCategory, number>
): void {
  console.log('\n[note-meta] done');
  for (const category of BACKFILL_CATEGORIES) {
    console.log(
      `  [${category}] enriched: ${enriched[category]} | miss: ${miss[category]} | errors: ${errors[category]}`
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[note-meta] fatal error', err);
    process.exit(1);
  });
}
