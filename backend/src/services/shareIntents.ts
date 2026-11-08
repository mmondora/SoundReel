/**
 * What a share asked for and has not finished yet (ADR-0015, decision 5): the playlist to fill and the family to
 * tell. One open intent per entry and sender; the work that depends on the analysis (songs into the playlist, the
 * outcome, the recipients' notice) runs when the entry is ready and is gated by `finishIntent`, so two completions
 * can never announce the same share twice.
 */
import { randomUUID } from 'node:crypto';
import { query } from '../utils/db';

export type IntentStatus = 'pending' | 'done' | 'failed';

export interface ShareIntent {
  id: string;
  entryId: string;
  /** The sender. */
  userId: string;
  sourceUrl: string;
  playlistId: string | null;
  /** The valid recipients that were asked for (family, never the sender). */
  shareWith: string[];
  /** The subset that did not have the entry yet: only those get a notice. */
  notifyWith: string[];
  comment: string | null;
  status: IntentStatus;
}

interface IntentRow {
  id: string;
  entry_id: string;
  user_id: string;
  source_url: string;
  playlist_id: string | null;
  share_with: string[] | null;
  notify_with: string[] | null;
  comment: string | null;
  status: string;
}

function rowToIntent(row: IntentRow): ShareIntent {
  return {
    id: row.id,
    entryId: row.entry_id,
    userId: row.user_id,
    sourceUrl: row.source_url,
    playlistId: row.playlist_id,
    shareWith: row.share_with ?? [],
    notifyWith: row.notify_with ?? [],
    comment: row.comment,
    status: row.status as IntentStatus,
  };
}

export interface NewShareIntent {
  entryId: string;
  userId: string;
  sourceUrl: string;
  playlistId?: string | null;
  shareWith?: string[];
  notifyWith?: string[];
  comment?: string | null;
}

/**
 * Records the intent, or merges it into the one still open for the same entry and sender (the same link sent twice
 * before it was analysed): a later playlist wins, recipients are added up.
 */
export async function upsertPendingIntent(input: NewShareIntent): Promise<ShareIntent> {
  const rows = await query<IntentRow>(
    `INSERT INTO share_intents (id, entry_id, user_id, source_url, playlist_id, share_with, notify_with, comment)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8)
     ON CONFLICT (entry_id, user_id) WHERE status = 'pending' DO UPDATE SET
       playlist_id = COALESCE(EXCLUDED.playlist_id, share_intents.playlist_id),
       share_with = ARRAY(SELECT DISTINCT u FROM unnest(share_intents.share_with || EXCLUDED.share_with) AS u),
       notify_with = ARRAY(SELECT DISTINCT u FROM unnest(share_intents.notify_with || EXCLUDED.notify_with) AS u),
       comment = COALESCE(EXCLUDED.comment, share_intents.comment),
       updated_at = now()
     RETURNING *`,
    [
      randomUUID(),
      input.entryId,
      input.userId,
      input.sourceUrl,
      input.playlistId ?? null,
      input.shareWith ?? [],
      input.notifyWith ?? [],
      input.comment ?? null,
    ],
  );
  return rowToIntent(rows[0]);
}

export async function pendingIntentsForEntry(entryId: string): Promise<ShareIntent[]> {
  const rows = await query<IntentRow>(
    `SELECT * FROM share_intents WHERE entry_id = $1 AND status = 'pending' ORDER BY created_at`,
    [entryId],
  );
  return rows.map(rowToIntent);
}

/**
 * Open intents older than `olderThan` whose entry has no job left to run (queued or processing): the analysis ended
 * before the intent was recorded, or the process stopped between the job and the announcement. They are the ones a
 * resolver must look at again; an intent whose job is still alive is simply waiting.
 */
export async function stuckIntents(olderThan: Date, limit = 50): Promise<ShareIntent[]> {
  const rows = await query<IntentRow>(
    `SELECT i.* FROM share_intents i
      WHERE i.status = 'pending' AND i.created_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM job_queue j WHERE j.entry_id = i.entry_id AND j.status IN ('queued', 'processing')
        )
      ORDER BY i.created_at
      LIMIT $2`,
    [olderThan, limit],
  );
  return rows.map(rowToIntent);
}

/**
 * Closes an intent. `false` when somebody else already did: the caller must then not announce anything, which is
 * exactly what keeps a share from being announced twice.
 */
export async function finishIntent(id: string, status: 'done' | 'failed', result: Record<string, unknown>): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE share_intents SET status = $2, result = $3::jsonb, updated_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [id, status, JSON.stringify(result)],
  );
  return rows.length > 0;
}
