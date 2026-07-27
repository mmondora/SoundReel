/**
 * Backfill/refresh OpenLibrary enrichment (title, author, year, cover) for
 * every book-category note mentioned across entries, idempotently skipping
 * notes recently enriched (within TTL).
 *
 * Reads up to 10,000 entries, dedupes mentions by noteKey (which embeds the
 * normalized category), keeps only 'book' notes, compares against existing
 * note_meta, fetches enrichment via enrichBook() (OpenLibrary), and upserts
 * results. Respects a configurable TTL (default 30 days) to avoid
 * unnecessary calls for recently enriched notes.
 *
 * Purely additive: it only upserts note_meta and never touches entries.
 *
 * OpenLibrary has no API key and no hard quota that returns a clean abort
 * signal. This script is polite (1 req/s, per the design constraint) and,
 * like backfillSongMeta, counts consecutive errors and aborts after 10 in a
 * row, on the assumption that's a systemic failure (network down, DNS,
 * etc.) rather than per-note misses.
 *
 * Usage (inside the container):
 *   node dist/scripts/backfillNoteMeta.js --dry-run
 *   node dist/scripts/backfillNoteMeta.js
 */
import { pool, listEntries } from '../utils/db';
import { noteKey, normalizeNoteCategory, listNoteMeta, upsertNoteEnrichment } from '../services/noteMeta';
import { enrichBook } from '../services/bookEnrichment';
import { isStale } from '../services/streamingRefresher';

const DRY_RUN = process.argv.includes('--dry-run');
const NOTE_ENRICHMENT_TTL_DAYS = Number(process.env.NOTE_ENRICHMENT_TTL_DAYS || 30);
const DELAY_MS = 1000;
const MAX_CONSECUTIVE_ERRORS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const entries = await listEntries(10000);
  const existing = await listNoteMeta();

  // Aggregate book notes from entries: dedupe by noteKey, capture first text seen.
  const notesFromEntries = new Map<string, { text: string }>();
  for (const entry of entries) {
    const notes = entry.results?.notes;
    if (!Array.isArray(notes)) continue;
    for (const note of notes) {
      if (!note || typeof note.text !== 'string' || !note.text.trim()) continue;
      if (normalizeNoteCategory(note.category) !== 'book') continue;
      const text = note.text.trim();
      const key = noteKey('book', text);
      if (!notesFromEntries.has(key)) {
        notesFromEntries.set(key, { text });
      }
    }
  }

  // Target notes: those with null/stale enriched_at.
  const targets = new Map<string, { text: string }>();
  for (const [key, noteData] of notesFromEntries) {
    const meta = existing.get(key);
    if (meta && !isStale(meta.enrichedAt, NOTE_ENRICHMENT_TTL_DAYS)) continue; // already fresh
    targets.set(key, noteData);
  }

  console.log(`[note-meta] ${targets.size} book notes to check${DRY_RUN ? ' (dry-run)' : ''}`);
  let enriched = 0;
  let miss = 0;
  let errors = 0;
  let consecutiveErrors = 0;

  for (const [key, note] of targets) {
    if (DRY_RUN) {
      console.log(`  ${key}`);
      continue;
    }

    try {
      const result = await enrichBook(note.text);
      if (result) {
        await upsertNoteEnrichment({ noteKey: key, ...result });
        console.log(`[note-meta] OK    ${key}`);
        enriched++;
      } else {
        console.log(`[note-meta] MISS  ${key}`);
        miss++;
      }
      consecutiveErrors = 0;
    } catch (err) {
      errors++;
      consecutiveErrors++;
      console.log(`[note-meta] ERROR ${key} — ${String(err)}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`[note-meta] ${MAX_CONSECUTIVE_ERRORS} consecutive errors, aborting`);
        console.log(
          `\n[note-meta] done — enriched: ${enriched} | miss: ${miss} | errors: ${errors}`
        );
        await pool.end();
        return;
      }
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `\n[note-meta] done — enriched: ${enriched} | miss: ${miss} | errors: ${errors}`
  );
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[note-meta] fatal error', err);
    process.exit(1);
  });
}
