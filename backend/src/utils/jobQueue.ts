import { query, withClient } from './db';

export type JobPlatform = 'instagram' | 'other';
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

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
}): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO job_queue (entry_id, source_url, platform, chat_id, input_user, notify, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, NOW()))
     RETURNING id`,
    [job.entryId, job.sourceUrl, job.platform, job.chatId, job.inputUser,
     job.notify ?? true, job.nextAttemptAt ?? null]
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
         ORDER BY created_at ASC
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

export function claimNextInstagramJob(): Promise<JobQueueRow | null> {
  return claimNext(`platform = 'instagram'`);
}

export function claimNextOtherJob(): Promise<JobQueueRow | null> {
  return claimNext(`platform <> 'instagram'`);
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

export async function requeueStuckJobs(): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE job_queue SET status = 'queued', updated_at = NOW() WHERE status = 'processing' RETURNING id`
  );
  return rows.length;
}
