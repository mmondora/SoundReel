/**
 * Fills the software of the entries that name tools but have none stored.
 *
 * Why: the big analysis schema never gave software items on the entries re-analysed after the 2.9.1 repair (0 of 135,
 * while 48 clearly name tools), and the Software page is fed by what the analysis stores. The software pass added in
 * 2.10.0 (`services/softwareExtraction.ts`) finds them in about a second a call; this script runs it over the entries
 * already in the journal, WITHOUT redoing their analysis: nothing but `results.software` changes, and only where it is
 * empty.
 *
 * Which entries: completed, not a Shazam/Spotify library entry, no software stored, at least 40 characters of caption,
 * transcript or on-screen text that hint at software (`looksLikeSoftware`), and never looked at by this script before
 * (an `backfill_software` line in the action log, whatever it found: a second run does not ask the same entries again).
 *
 * It calls the local model (through the gpu-router) one entry at a time and nothing else: no Instagram, no Claude, no
 * Telegram.
 *
 * Usage (inside the container):
 *   node dist/scripts/backfillSoftware.js --dry-run                 # lists the candidates, calls nothing
 *   node dist/scripts/backfillSoftware.js --limit 5                 # five (the most recent)
 *   node dist/scripts/backfillSoftware.js --since 2026-10-01        # only entries created from that day
 *   node dist/scripts/backfillSoftware.js                           # all of them
 */
import type { Pool } from 'pg';
import type { SoftwareItem } from '../types';
import { MIN_TEXT } from './requeueEmptyAnalysis';
import { looksLikeSoftware, sourceTextOf, type SoftwareExtraction, type SoftwareSource } from '../services/softwareExtraction';

export interface Candidate extends SoftwareSource {
  id: string;
  source_platform: string;
}

export interface Options {
  dryRun: boolean;
  since: string | null;
  limit: number | null;
}

export function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const since = value('--since');
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`--since vuole YYYY-MM-DD, non "${since}"`);
  const rawLimit = value('--limit');
  const limit = rawLimit === null ? null : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error(`--limit vuole un intero positivo, non "${rawLimit}"`);
  return { dryRun: argv.includes('--dry-run'), since, limit };
}

/** The entries with text and no software, not yet looked at; the "hints at software" test is the extractor's own. */
export async function fetchCandidates(db: Pick<Pool, 'query'>, opts: Pick<Options, 'since' | 'limit'>): Promise<Candidate[]> {
  const { rows } = await db.query<{ id: string; source_platform: string; caption: string | null; transcript: string | null; overlay: string | null }>(
    `SELECT e.id, e.source_platform, e.caption,
            e.results->>'transcript' AS transcript, e.results->>'overlayText' AS overlay
       FROM entries e
      WHERE e.status = 'completed'
        AND e.source_platform NOT IN ('shazam', 'spotify')
        AND COALESCE(jsonb_array_length(e.results->'software'), 0) = 0
        AND (length(COALESCE(e.caption, '')) >= $1
             OR length(COALESCE(e.results->>'transcript', '')) >= $1
             OR length(COALESCE(e.results->>'overlayText', '')) >= $1)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e.action_log) a WHERE a->>'action' = 'backfill_software')
        AND ($2::date IS NULL OR e.created_at >= $2::date)
      ORDER BY e.created_at DESC
      LIMIT COALESCE($3::int, 100000)`,
    [MIN_TEXT, opts.since, opts.limit === null ? null : opts.limit * 4], // several are dropped by the hint gate: ask for more
  );
  const candidates = rows
    .map((r) => ({ id: r.id, source_platform: r.source_platform, caption: r.caption, transcript: r.transcript, ocrText: r.overlay }))
    .filter((c) => looksLikeSoftware(sourceTextOf(c)));
  return opts.limit === null ? candidates : candidates.slice(0, opts.limit);
}

export interface Deps {
  db: Pick<Pool, 'query'>;
  extract: (source: SoftwareSource) => Promise<SoftwareExtraction>;
  /** Writes the software ONLY if the entry still has none (a concurrent analysis wins). Returns whether it wrote. */
  save: (entryId: string, items: SoftwareItem[]) => Promise<boolean>;
  record: (entryId: string, outcome: string, found: number) => Promise<void>;
  say: (line: string) => void;
}

export interface Summary {
  candidates: number;
  withSoftware: number;
  items: number;
  failed: number;
}

export async function backfillSoftware(deps: Deps, opts: Options): Promise<Summary> {
  const candidates = await fetchCandidates(deps.db, opts);
  deps.say(
    `[software] entry con testo che parla di software e nessuna voce: ${candidates.length}` +
      `${opts.since ? ` (dal ${opts.since})` : ''}${opts.limit ? ` | al massimo ${opts.limit}` : ''}${opts.dryRun ? ' | DRY RUN (nessuna chiamata)' : ''}`,
  );
  const summary: Summary = { candidates: candidates.length, withSoftware: 0, items: 0, failed: 0 };
  for (const c of candidates) {
    if (opts.dryRun) {
      deps.say(`  ${c.id}  ${c.source_platform}  ${sourceTextOf(c).length} char`);
      continue;
    }
    const result = await deps.extract(c);
    if (result.outcome === 'failed') {
      // not recorded: the next run asks again (a router that was busy is not an answer)
      summary.failed += 1;
      deps.say(`  ${c.id}  non riuscita (si riprova alla prossima passata)`);
      continue;
    }
    let found = 0;
    if (result.items.length > 0 && (await deps.save(c.id, result.items))) {
      found = result.items.length;
      summary.withSoftware += 1;
      summary.items += found;
    }
    await deps.record(c.id, result.outcome, found);
    deps.say(`  ${c.id}  ${found > 0 ? result.items.map((i) => i.title).join(', ') : '-'}`);
  }
  if (!opts.dryRun) {
    deps.say(`[software] fatto: ${summary.withSoftware} entry con software (${summary.items} voci), ${summary.failed} da riprovare, su ${summary.candidates}`);
  }
  return summary;
}

async function main(): Promise<void> {
  const [{ pool, appendActionLog, createActionLog }, { extractSoftware }] = await Promise.all([import('../utils/db'), import('../services/softwareExtraction')]);
  try {
    await backfillSoftware(
      {
        db: pool,
        extract: (source) => extractSoftware(source),
        save: async (entryId, items) => {
          const r = await pool.query(
            `UPDATE entries SET results = jsonb_set(results, '{software}', $2::jsonb)
              WHERE id = $1 AND COALESCE(jsonb_array_length(results->'software'), 0) = 0`,
            [entryId, JSON.stringify(items)],
          );
          return (r.rowCount ?? 0) > 0;
        },
        record: async (entryId, outcome, found) => {
          await appendActionLog(entryId, createActionLog('backfill_software', { outcome, found }));
        },
        say: (line) => console.log(line),
      },
      parseArgs(process.argv.slice(2)),
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[software] errore fatale', err);
    process.exit(1);
  });
}
