/**
 * Re-queue entries left in `error` status, spread over a window of days.
 *
 * Most of these failed because the Instagram session had expired or was
 * rate-limited, so they are worth another attempt — but retrying 50+ Instagram
 * scrapes back to back is exactly the pattern that gets an account flagged.
 * Each job is therefore scheduled at its own `next_attempt_at`, spaced evenly
 * across the window with random jitter so the sequence has no regular period.
 *
 * The worker's own per-job jitter and one-at-a-time Instagram lane still apply
 * on top of this.
 *
 * Jobs are queued with notify=false: this is a repair run over content the user
 * submitted days ago, and a burst of Telegram messages would be noise.
 *
 * Usage (inside the container):
 *   node dist/scripts/requeueErrors.js --dry-run
 *   node dist/scripts/requeueErrors.js --days 4
 */
import { pool, appendActionLog, createActionLog } from '../utils/db';
import { enqueueJob } from '../utils/jobQueue';
import type { JobPlatform } from '../utils/jobQueue';

/** Spread ±25% around each slot so the dispatch times are not periodic. */
const JITTER_RATIO = 0.25;

interface Row {
  id: string;
  source_url: string;
  source_platform: string;
  input_user: string | null;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const daysIdx = argv.indexOf('--days');
  const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 4;
  if (!Number.isFinite(days) || days <= 0) {
    console.error('--days deve essere un numero positivo');
    process.exit(1);
  }
  return { dryRun: argv.includes('--dry-run'), days };
}

async function fetchErrorEntries(): Promise<Row[]> {
  // Skip anything already waiting in the queue so re-running cannot double-book.
  const { rows } = await pool.query<Row>(
    `SELECT e.id, e.source_url, e.source_platform, e.input_user
       FROM entries e
      WHERE e.status = 'error'
        AND NOT EXISTS (
          SELECT 1 FROM job_queue j
           WHERE j.entry_id = e.id AND j.status IN ('queued', 'processing')
        )
      ORDER BY e.created_at ASC`
  );
  return rows;
}

/** The chat to attribute jobs to; unused while notify is false, but the column is NOT NULL. */
async function resolveChatId(): Promise<number> {
  const { rows } = await pool.query<{ chat_id: string }>(
    `SELECT chat_id FROM job_queue GROUP BY chat_id ORDER BY count(*) DESC LIMIT 1`
  );
  return rows.length ? Number(rows[0].chat_id) : 0;
}

async function main(): Promise<void> {
  const { dryRun, days } = parseArgs();

  const rows = await fetchErrorEntries();
  const chatId = await resolveChatId();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const slotMs = rows.length > 0 ? windowMs / rows.length : 0;

  console.log(
    `[requeue] entry in errore da riaccodare: ${rows.length} | finestra: ${days} giorni ` +
    `| una ogni ~${Math.round(slotMs / 60000)} min${dryRun ? ' | DRY RUN (nessuna modifica)' : ''}`
  );

  if (!rows.length) {
    await pool.end();
    return;
  }

  let queued = 0;
  for (const [i, row] of rows.entries()) {
    // Centre of this entry's slot, nudged by up to ±25% of a slot.
    const jitter = (Math.random() * 2 - 1) * slotMs * JITTER_RATIO;
    const offsetMs = Math.max(0, slotMs * i + slotMs / 2 + jitter);
    const at = new Date(Date.now() + offsetMs);
    const platform: JobPlatform = row.source_platform === 'instagram' ? 'instagram' : 'other';

    if (dryRun) {
      console.log(`  ${row.id}  ${platform}  → ${at.toISOString()}`);
      continue;
    }

    await enqueueJob({
      entryId: row.id,
      sourceUrl: row.source_url,
      platform,
      chatId,
      inputUser: row.input_user,
      notify: false,
      nextAttemptAt: at,
    });
    await appendActionLog(row.id, createActionLog('requeued_for_retry', {
      scheduledFor: at.toISOString(),
      platform,
      silent: true,
    }));
    queued++;
  }

  if (!dryRun) {
    const last = new Date(Date.now() + windowMs);
    console.log(`\n[requeue] accodate: ${queued} | ultima prevista entro ${last.toISOString()}`);
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[requeue] errore fatale', err);
    process.exit(1);
  });
}
