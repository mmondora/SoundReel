/**
 * Backfill per-slide analysis for carousels processed before that feature
 * existed.
 *
 * Reads the slide images still on disk under MEDIA_ROOT/<entryId>/ and re-runs
 * OCR plus slide analysis from them. It never re-scrapes Instagram, so it
 * carries no ban risk — and it recovers OCR text that the original run
 * extracted and then discarded.
 *
 * Purely additive, like every repair pass here: it only ever sets `slides`,
 * which did not exist before, and touches nothing else in the entry.
 *
 * Usage (inside the container):
 *   node dist/scripts/backfillSlides.js --dry-run
 *   node dist/scripts/backfillSlides.js --limit 3
 *   node dist/scripts/backfillSlides.js
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, updateEntry, appendActionLog, createActionLog } from '../utils/db';
import { ocrImages } from '../services/ocrClient';
import { analyzeSlides } from '../services/slideAnalysis';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';
const DELAY_MS = 1_000;

/** Slide files as written by the instaloader service. */
const SLIDE_FILE = /^slide[-_]?(\d+)\.(jpe?g|png|webp)$/i;

interface Row {
  id: string;
  caption: string | null;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const limitIdx = argv.indexOf('--limit');
  return {
    dryRun: argv.includes('--dry-run'),
    limit: limitIdx >= 0 ? Number(argv[limitIdx + 1]) : null,
  };
}

/** Slide images for an entry, ordered by their index in the carousel. */
async function findSlides(entryId: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(join(MEDIA_ROOT, entryId));
  } catch {
    return [];
  }

  return files
    .map((name) => ({ name, match: SLIDE_FILE.exec(name) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => !!f.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((f) => join(MEDIA_ROOT, entryId, f.name));
}

async function fetchCandidates(limit: number | null): Promise<Row[]> {
  const { rows } = await pool.query<Row>(
    `SELECT id, caption
       FROM entries
      WHERE status = 'completed'
        AND results->'slides' IS NULL
      ORDER BY created_at DESC
      ${limit ? 'LIMIT ' + Number(limit) : ''}`
  );
  return rows;
}

async function main(): Promise<void> {
  const { dryRun, limit } = parseArgs();

  const rows = await fetchCandidates(limit);

  // Only entries whose slide images survived the retention purge can be redone.
  const candidates: Array<Row & { slidePaths: string[] }> = [];
  for (const row of rows) {
    const slidePaths = await findSlides(row.id);
    if (slidePaths.length > 0) candidates.push({ ...row, slidePaths });
  }

  console.log(
    `[slides] entry senza slides: ${rows.length} | con immagini su disco: ${candidates.length}` +
    `${dryRun ? ' | DRY RUN (nessuna modifica)' : ''}`
  );

  if (dryRun) {
    for (const c of candidates) console.log(`  ${c.id}  ${c.slidePaths.length} slide`);
    await pool.end();
    return;
  }

  let done = 0;
  let failed = 0;

  for (const [i, row] of candidates.entries()) {
    const n = `${i + 1}/${candidates.length}`;
    try {
      const ocr = await ocrImages(row.slidePaths);
      const slides = await analyzeSlides({
        entryId: row.id,
        slidePaths: row.slidePaths,
        ocrPerSlide: ocr.perImage.map((r) => r.text ?? null),
        caption: row.caption,
      });

      await updateEntry(row.id, { 'results.slides': slides });
      await appendActionLog(row.id, createActionLog('slides_backfilled', {
        slides: slides.length,
        withOcr: slides.filter((s) => s.ocrText).length,
        withSummary: slides.filter((s) => s.summary).length,
        totalLinks: slides.reduce((acc, s) => acc + s.links.length, 0),
      }));

      done++;
      const withSummary = slides.filter((s) => s.summary).length;
      const links = slides.reduce((acc, s) => acc + s.links.length, 0);
      console.log(`[${n}] ${row.id} — ${slides.length} slide, ${withSummary} con paragrafo, ${links} link`);
    } catch (err) {
      failed++;
      console.log(`[${n}] ${row.id} — ERRORE: ${String(err)}`);
    }

    if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n[slides] fatto — elaborate: ${done} | fallite: ${failed}`);
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[slides] errore fatale', err);
    process.exit(1);
  });
}
