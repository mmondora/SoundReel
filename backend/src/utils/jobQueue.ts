import { query, withClient } from './db';

export type JobPlatform = 'instagram' | 'other';
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';
export type JobKind = 'analyze' | 'transcribe';

export interface JobQueueRow {
  id: number;
  entryId: string;
  sourceUrl: string;
  platform: JobPlatform;
  chatId: number;
  inputUser: string | null;
  status: JobStatus;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  /** False for repair runs, which must stay silent. */
  notify: boolean;
  kind: JobKind;
  /** Lower runs first. Backfilled history uses 10 so it yields to new content. */
  priority: number;
  /**
   * The media is already on disk; the analysis must not fetch anything.
   *
   * Set only by dispatchTranscribe. Deliberately not inferred from
   * `notify === false`: a repair run is silent too, and a repair exists
   * precisely because the download failed, so it must keep its download.
   */
  reanalyze: boolean;
  /**
   * Download only: no vision, no AI analysis, no ollama at all.
   *
   * A repair batch is spaced out by tens of minutes so Instagram does not
   * challenge the account again, and ollama keeps one model resident for 90
   * seconds. Running the analysis inline would therefore wake the GPU once per
   * job and switch models twice — the queue teardown that hangs this APU.
   * The deferred pass picks these entries up later, in one hot run.
   */
  skipAi: boolean;
}

interface JobQueueDbRow {
  id: number;
  entry_id: string;
  source_url: string;
  platform: string;
  chat_id: string;
  input_user: string | null;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
  updated_at: Date;
  notify: boolean;
  kind: string;
  priority: number;
  reanalyze: boolean;
  skip_ai: boolean;
}

function rowToJob(row: JobQueueDbRow): JobQueueRow {
  return {
    id: row.id,
    entryId: row.entry_id,
    sourceUrl: row.source_url,
    platform: row.platform as JobPlatform,
    chatId: Number(row.chat_id),
    inputUser: row.input_user,
    status: row.status as JobStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    notify: row.notify ?? true,
    kind: (row.kind as JobKind) ?? 'analyze',
    priority: row.priority ?? 0,
    reanalyze: row.reanalyze ?? false,
    skipAi: row.skip_ai ?? false,
  };
}

export async function enqueueJob(job: {
  entryId: string;
  sourceUrl: string;
  platform: JobPlatform;
  chatId: number;
  inputUser: string | null;
  /** Skip the Telegram message on completion. Defaults to notifying. */
  notify?: boolean;
  /** Earliest dispatch time; defaults to immediately. */
  nextAttemptAt?: Date;
  /** Defaults to the analysis pass. */
  kind?: JobKind;
  /** Lower runs first; defaults to 0. */
  priority?: number;
  /** Work from the media already on disk and fetch nothing. Defaults to false. */
  reanalyze?: boolean;
  /** Download only, leaving the AI analysis to a later batched pass. */
  skipAi?: boolean;
}): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO job_queue (entry_id, source_url, platform, chat_id, input_user, notify, next_attempt_at, kind, priority, reanalyze, skip_ai)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, NOW()),$8,$9,$10,$11)
     RETURNING id`,
    [job.entryId, job.sourceUrl, job.platform, job.chatId, job.inputUser,
     job.notify ?? true, job.nextAttemptAt ?? null,
     job.kind ?? 'analyze', job.priority ?? 0, job.reanalyze ?? false,
     job.skipAi ?? false]
  );
  return rows[0].id;
}

async function claimNext(platformClause: string): Promise<JobQueueRow | null> {
  return withClient(async (client) => {
    // withClient does not open a transaction — without an explicit BEGIN,
    // Postgres autocommits the SELECT, releasing the SKIP LOCKED row lock
    // before the UPDATE runs, letting two callers claim the same row.
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<JobQueueDbRow>(
        `SELECT * FROM job_queue
         WHERE status = 'queued' AND ${platformClause} AND next_attempt_at <= NOW()
         ORDER BY priority ASC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );
      const row = rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        `UPDATE job_queue SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await client.query('COMMIT');
      return rowToJob(row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/**
 * The three analyze lanes are disjoint, and `reanalyze` is what splits them.
 *
 * A re-analysis fetches nothing — it works from media already on disk — so the
 * rate limiting that shapes the other two lanes buys it nothing. What it does
 * do is hit ollama, which keeps a single model resident: running several at
 * once would thrash the model in and out. Hence its own strictly serial lane,
 * with no jitter to cool the model down between jobs.
 */
export function claimNextInstagramJob(): Promise<JobQueueRow | null> {
  return claimNext(`kind = 'analyze' AND platform = 'instagram' AND NOT reanalyze`);
}

export function claimNextOtherJob(): Promise<JobQueueRow | null> {
  return claimNext(`kind = 'analyze' AND platform <> 'instagram' AND NOT reanalyze`);
}

export function claimNextReanalyzeJob(): Promise<JobQueueRow | null> {
  return claimNext(`kind = 'analyze' AND reanalyze`);
}

export function claimNextTranscribeJob(): Promise<JobQueueRow | null> {
  return claimNext(`kind = 'transcribe'`);
}

export async function markJobDone(jobId: number): Promise<void> {
  await query(`UPDATE job_queue SET status = 'done', updated_at = NOW() WHERE id = $1`, [jobId]);
}

export async function markJobFailed(jobId: number): Promise<void> {
  await query(`UPDATE job_queue SET status = 'failed', updated_at = NOW() WHERE id = $1`, [jobId]);
}

export async function scheduleJobRetry(jobId: number, attempts: number, nextAttemptAt: Date): Promise<void> {
  await query(
    `UPDATE job_queue SET status = 'queued', attempts = $2, next_attempt_at = $3, updated_at = NOW() WHERE id = $1`,
    [jobId, attempts, nextAttemptAt.toISOString()]
  );
}

/**
 * Rimanda un job trasformandolo in una seconda passata sui media gia' scaricati.
 *
 * Serve quando l'estrazione e' andata bene e solo l'analisi AI e' morta per
 * una ragione transitoria: ritentare l'intero job rifarebbe il download, e su
 * Instagram e' esattamente cio' che non si deve fare. Il flag rende il
 * tentativo successivo gratuito lato rete e lo manda nella corsia seriale,
 * dove il modello resta caldo.
 */
export async function scheduleAiRetry(jobId: number, attempts: number, nextAttemptAt: Date): Promise<void> {
  await query(
    `UPDATE job_queue
        SET status = 'queued', attempts = $2, next_attempt_at = $3, reanalyze = true, skip_ai = false, updated_at = NOW()
      WHERE id = $1`,
    [jobId, attempts, nextAttemptAt.toISOString()]
  );
}

export async function requeueStuckJobs(): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE job_queue SET status = 'queued', updated_at = NOW() WHERE status = 'processing' RETURNING id`
  );
  return rows.length;
}
