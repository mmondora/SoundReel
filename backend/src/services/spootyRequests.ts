/**
 * Persistence for Spotify links being tracked against Spooty (table `spooty_requests`,
 * migration 015). One row per journal entry; the watcher polls the due ones.
 */
import { query } from '../utils/db';

export type SpootyRequestStatus = 'queued' | 'tracking' | 'completed' | 'failed';

export interface SpootyRequest {
  id: number;
  entryId: string;
  ownerUser: string;
  spotifyUrl: string;
  kind: string;
  spootyPlaylistId: number | null;
  chatId: number | null;
  status: SpootyRequestStatus;
  attempts: number;
  lastError: string | null;
  nextCheckAt: Date;
  createdAt: Date;
}

interface Row {
  id: number;
  entry_id: string;
  owner_user: string;
  spotify_url: string;
  kind: string;
  spooty_playlist_id: number | null;
  chat_id: string | number | null;
  status: string;
  attempts: number;
  last_error: string | null;
  next_check_at: Date;
  created_at: Date;
}

const COLS =
  'id, entry_id, owner_user, spotify_url, kind, spooty_playlist_id, chat_id, status, attempts, last_error, next_check_at, created_at';

function fromRow(r: Row): SpootyRequest {
  return {
    id: r.id,
    entryId: r.entry_id,
    ownerUser: r.owner_user,
    spotifyUrl: r.spotify_url,
    kind: r.kind,
    spootyPlaylistId: r.spooty_playlist_id,
    chatId: r.chat_id === null || r.chat_id === undefined ? null : Number(r.chat_id),
    status: r.status as SpootyRequestStatus,
    attempts: r.attempts,
    lastError: r.last_error,
    nextCheckAt: new Date(r.next_check_at),
    createdAt: new Date(r.created_at),
  };
}

export async function insertSpootyRequest(input: {
  entryId: string;
  ownerUser: string;
  spotifyUrl: string;
  kind: string;
  spootyPlaylistId: number | null;
  chatId: number | null;
  status: SpootyRequestStatus;
}): Promise<SpootyRequest> {
  const rows = await query<Row>(
    `INSERT INTO spooty_requests (entry_id, owner_user, spotify_url, kind, spooty_playlist_id, chat_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (entry_id) DO UPDATE SET
       spooty_playlist_id = COALESCE(EXCLUDED.spooty_playlist_id, spooty_requests.spooty_playlist_id),
       status = EXCLUDED.status,
       next_check_at = now(),
       updated_at = now()
     RETURNING ${COLS}`,
    [input.entryId, input.ownerUser, input.spotifyUrl, input.kind, input.spootyPlaylistId, input.chatId, input.status],
  );
  return fromRow(rows[0]);
}

export async function getSpootyRequestByEntry(entryId: string): Promise<SpootyRequest | null> {
  const rows = await query<Row>(`SELECT ${COLS} FROM spooty_requests WHERE entry_id = $1`, [entryId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listDueSpootyRequests(limit = 25): Promise<SpootyRequest[]> {
  const rows = await query<Row>(
    `SELECT ${COLS} FROM spooty_requests
     WHERE status IN ('queued', 'tracking') AND next_check_at <= now()
     ORDER BY next_check_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map(fromRow);
}

export interface SpootyRequestPatch {
  status?: SpootyRequestStatus;
  spootyPlaylistId?: number | null;
  attempts?: number;
  lastError?: string | null;
  /** Delay from now, in ms. */
  nextCheckInMs?: number;
}

export async function patchSpootyRequest(id: number, patch: SpootyRequestPatch): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [id];
  const push = (sql: string, value: unknown): void => {
    params.push(value);
    sets.push(sql.replace('?', `$${params.length}`));
  };
  if (patch.status !== undefined) push('status = ?', patch.status);
  if (patch.spootyPlaylistId !== undefined) push('spooty_playlist_id = ?', patch.spootyPlaylistId);
  if (patch.attempts !== undefined) push('attempts = ?', patch.attempts);
  if (patch.lastError !== undefined) push('last_error = ?', patch.lastError);
  if (patch.nextCheckInMs !== undefined) push(`next_check_at = now() + (? * interval '1 millisecond')`, patch.nextCheckInMs);
  await query(`UPDATE spooty_requests SET ${sets.join(', ')} WHERE id = $1`, params);
}

/** Entries whose Spotify link Spooty is still working on (so a YouTube download would only duplicate it). */
export async function listOpenSpootyEntryIds(entryIds: string[]): Promise<Set<string>> {
  if (entryIds.length === 0) return new Set();
  const rows = await query<{ entry_id: string }>(
    `SELECT entry_id FROM spooty_requests WHERE status IN ('queued', 'tracking') AND entry_id = ANY($1::text[])`,
    [entryIds],
  );
  return new Set(rows.map((r) => r.entry_id));
}
