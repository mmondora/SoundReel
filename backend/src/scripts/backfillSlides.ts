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

/** Full-resolution still for a single-image post. */
const THUMBNAIL_FILE = 'thumbnail-source.jpg';

/** Sampled video frames; their presence means the post is a video, not a still. */
const FRAME_FILE = /^frame[-_]?\d+\.(jpe?g|png|webp)$/i;

/**
 * Mirrors the live pipeline: a single image is worth treating as a one-page
 * carousel only when it actually carried text, so ordinary photos with an
 * incidental watermark are left alone.
 */
const SINGLE_IMAGE_OCR_MIN_CHARS = 120;

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

/**
 * Pages to analyse for an entry: the carousel slides in order, or — for a
 * single-image post, which has no slides at all — the still image on its own.
 */
async function findPages(entryId: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(join(MEDIA_ROOT, entryId));
  } catch {
    return [];
  }

  const slides = files
    .map((name) => ({ name, match: SLIDE_FILE.exec(name) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => !!f.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((f) => join(MEDIA_ROOT, entryId, f.name));

  if (slides.length) return slides;

  // A video post keeps its sampled frames here and already has them plus a
  // transcript analysed; its thumbnail is a still from the video, not a page.
  // Mirrors the live pipeline, which only falls back to the thumbnail when
  // there are neither frames nor slides.
  if (files.some((name) => FRAME_FILE.test(name))) return [];

  return files.includes(THUMBNAIL_FILE) ? [join(MEDIA_ROOT, entryId, THUMBNAIL_FILE)] : [];
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
    const slidePaths = await findPages(row.id);
    if (slidePaths.length > 0) candidates.push({ ...row, slidePaths });
  }

  console.log(
    `[slides] entry senza slides: ${rows.length} | con pagine su disco: ${candidates.length}` +
    `${dryRun ? ' | DRY RUN (nessuna modifica)' : ''}`
  );

  if (dryRun) {
    for (const c of candidates) console.log(`  ${c.id}  ${c.slidePaths.length} slide`);
    await pool.end();
    return;
  }

  let done = 0;
  let failed = 0;
  let skipped = 0;

  for (const [i, row] of candidates.entries()) {
    const n = `${i + 1}/${candidates.length}`;
    try {
      const ocr = await ocrImages(row.slidePaths);

      // A lone image with no readable text is just a photo — skip it rather
      // than store an empty page block.
      if (row.slidePaths.length === 1 && ocr.merged.trim().length < SINGLE_IMAGE_OCR_MIN_CHARS) {
        skipped++;
        console.log(`[${n}] ${row.id} — immagine singola senza testo, saltata`);
        continue;
      }

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

  console.log(`\n[slides] fatto — elaborate: ${done} | saltate: ${skipped} | fallite: ${failed}`);
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[slides] errore fatale', err);
    process.exit(1);
  });
}
