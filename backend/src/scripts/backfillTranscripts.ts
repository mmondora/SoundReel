/**
 * One-off backfill: queue a transcription job for every archived entry that
 * already has `audio.wav` on disk but no transcript. Whisper moved into its
 * own deferred job (kind: 'transcribe'); entries analysed before that only
 * ever went through the synchronous path.
 *
 * The candidate set is **83**, measured twice. An earlier draft said 489, which
 * was the count of media directories containing audio.wav — but Whisper worked
 * for months and only broke recently, so 410 of those directories belong to
 * entries that already have a transcript (and one has no entry row at all).
 * 494 dirs with audio, 454 entries with a transcript, 428 without; the
 * intersection of "has audio" and "has no transcript" is 83. The query below
 * has always computed that intersection at run time, so the wrong number was
 * only ever in the prose.
 *
 * NOT run as part of this task. See the guard in main() and the commit
 * message: 83 second analysis passes over already-enriched entries wait
 * until the additive merge (mergeAdditive-style) has proven itself in
 * production on new content first.
 *
 * Usage (inside the container, after the gate above has been cleared):
 *   node dist/scripts/backfillTranscripts.js                    # everything
 *   node dist/scripts/backfillTranscripts.js --limit=10 --richest  # trial wave
 */
import { promises as fs } from 'fs';
import path from 'path';
import { query } from '../utils/db';
import { enqueueJob } from '../utils/jobQueue';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';

/**
 * No spacing by default. Measured over the 83 candidates (not over all 494
 * dirs with audio, which is what the earlier 489/8.4-hour figure counted):
 * 137MB of 16-bit mono 16kHz WAV — 1.25 hours of audio, 75 minutes in total,
 * about 54 seconds a clip, which faster-whisper small clears in ten to twenty
 * minutes on the 5900X. An earlier draft spaced these two minutes apart and
 * would have spent 83 x 2 = 166 minutes waiting for a quarter of an hour of
 * work. The smaller number strengthens the case rather than weakening it: the
 * work shrank sixfold, the imposed wait scales with the job count, so the
 * ratio got worse. It guarded against a saturation that does not exist anyway:
 * Whisper runs on a dedicated box with no rate limit, and BACKFILL_PRIORITY
 * already keeps new content in front. Kept configurable for the rare case
 * someone wants a trickle.
 */
const STAGGER_MS = Number(process.env.BACKFILL_STAGGER_MS || 0);

/** Always behind anything the user just sent. */
const BACKFILL_PRIORITY = 10;

export interface BackfillRow {
  id: string;
  transcript: string | null;
  pendingTranscribe: boolean;
  /** How much this entry stands to lose if the merge is wrong. */
  richness?: number;
}

export interface BackfillOptions {
  /** Bound the wave. Undefined means every candidate. */
  limit?: number;
  /**
   * Put the entries with the most to lose first. The trial wave exists to
   * catch a merge that drops data, and only an entry that already carries
   * songs, films, notes or a summary can reveal that — a bare one would pass
   * whatever the merge did to it, because it has nothing to lose.
   */
  richestFirst?: boolean;
}

/**
 * Pure selection logic, kept apart from any I/O so it can be unit-tested
 * without a database or filesystem.
 */
export function selectBackfillCandidates(
  rows: BackfillRow[],
  hasAudio: (entryId: string) => boolean,
  opts: BackfillOptions = {}
): string[] {
  const eligible = rows
    .filter((r) => !r.transcript || r.transcript.trim().length === 0)
    .filter((r) => !r.pendingTranscribe)
    .filter((r) => hasAudio(r.id));

  const ordered = opts.richestFirst
    ? [...eligible].sort((a, b) => (b.richness ?? 0) - (a.richness ?? 0))
    : eligible;

  const bounded = opts.limit === undefined ? ordered : ordered.slice(0, opts.limit);
  return bounded.map((r) => r.id);
}

interface CandidateDbRow {
  id: string;
  source_url: string;
  transcript: string | null;
  pending: boolean;
  /** Cast to text in the query so pg returns it as a string rather than a JS number that could lose precision. */
  richness: string;
}

function parseArgs(): { limit: number | undefined; richestFirst: boolean } {
  const argv = process.argv.slice(2);
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  return {
    limit: limitArg ? Number(limitArg.split('=')[1]) : undefined,
    richestFirst: argv.includes('--richest'),
  };
}

async function hasAudioOnDisk(entryId: string): Promise<boolean> {
  try {
    await fs.access(path.join(MEDIA_ROOT, entryId, 'audio.wav'));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { limit, richestFirst } = parseArgs();

  const rows = await query<CandidateDbRow>(
    `SELECT e.id,
            e.source_url,
            e.results->>'transcript' AS transcript,
            EXISTS (
              SELECT 1 FROM job_queue j
              WHERE j.entry_id = e.id AND j.kind = 'transcribe'
                AND j.status IN ('queued','processing')
            ) AS pending,
            -- how much this entry stands to lose if the merge is wrong
            (jsonb_array_length(COALESCE(e.results->'songs','[]'::jsonb))
             + jsonb_array_length(COALESCE(e.results->'films','[]'::jsonb))
             + jsonb_array_length(COALESCE(e.results->'notes','[]'::jsonb))
             + CASE WHEN COALESCE(e.results->>'summary','') <> '' THEN 1 ELSE 0 END)::text AS richness
       FROM entries e
      ORDER BY e.created_at DESC`
  );

  const byId = new Map(rows.map((r) => [r.id, r]));

  const present = new Set<string>();
  for (const r of rows) {
    if (await hasAudioOnDisk(r.id)) present.add(r.id);
  }

  const candidates = selectBackfillCandidates(
    rows.map((r) => ({
      id: r.id,
      transcript: r.transcript,
      pendingTranscribe: r.pending,
      richness: Number(r.richness),
    })),
    (id) => present.has(id),
    { limit, richestFirst }
  );

  let queued = 0;
  for (const id of candidates) {
    const row = byId.get(id);
    if (!row) continue;
    await enqueueJob({
      entryId: id,
      sourceUrl: row.source_url,
      platform: 'other',
      chatId: 0,
      inputUser: null,
      notify: false,
      kind: 'transcribe',
      priority: BACKFILL_PRIORITY,
      nextAttemptAt: new Date(Date.now() + queued * STAGGER_MS),
    });
    queued++;
  }

  console.log(
    `Accodate ${queued} trascrizioni storiche su ${rows.length} entry esaminate` +
    (limit !== undefined ? ` (ondata limitata a ${limit}${richestFirst ? ', le più ricche' : ''}).` : '.')
  );
}

// Only run when invoked directly; importing this module (e.g. to unit-test
// selectBackfillCandidates) must not start a backfill. This is also the gate
// this task deliberately never opens: the script is written and tested, not
// executed — that happens only after Tasks 1-5 have proven the merge on new
// content in production.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
