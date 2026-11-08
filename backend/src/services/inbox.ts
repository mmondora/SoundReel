/**
 * The Mondrop inbox (ADR-0015, contract docs/mondrop-inbox.md): the notifications of a user and the entries other
 * people shared with him. The server is the source of truth; the app reads it, push only rings the doorbell.
 *
 * Rules decided by Michele (spec 2026-11-08-mondrop-share-inbox-design.md):
 * - information disappears by itself after 3 days, read or not;
 * - **errors never expire**: they stay until the user removes them or the same link later succeeds;
 * - received shares are not notifications: they live in `entry_shares` and stay while the share exists;
 * - a received share counts ONCE in the badge: "seen" and "read" are the same act.
 *
 * Removal is a soft delete (`removed_at`) so another device can be told what disappeared (`removedIds`).
 * Every function touches only the rows of the user it is given: the routes pass the owner of the key, never an id
 * the client chose.
 */
import { randomUUID } from 'node:crypto';
import { query } from '../utils/db';
import { entryTitle, entryUrl } from '../utils/entryLinks';

export type InboxKind = 'share_result' | 'share_received';
export type InboxLevel = 'info' | 'error';

export const INFO_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** At most this many errors per user: the oldest ones go first. */
export const ERROR_CAP = 100;
/** How long the server remembers a removal, so a second device can be told about it. */
export const REMOVAL_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;
/** `since` is read this much earlier: a row committed a moment after the last answer is never missed. */
const SINCE_OVERLAP_MS = 2_000;
const MAX_TITLE = 200;
const MAX_BODY = 600;

interface InboxRow {
  id: string;
  user_id: string;
  kind: string;
  level: string;
  title: string;
  body: string;
  entry_id: string | null;
  url: string | null;
  link_key: string | null;
  data: unknown;
  created_at: Date;
  updated_at: Date;
  read_at: Date | null;
  expires_at: Date | null;
}

export interface InboxItem {
  id: string;
  userId: string;
  kind: InboxKind;
  level: InboxLevel;
  title: string;
  body: string;
  entryId: string | null;
  url: string | null;
  /** The entry's stored source_url: how an error is closed when the same link later succeeds. */
  linkKey: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  /** null for errors: they never expire. */
  expiresAt: string | null;
}

/** What the app receives (`docs/mondrop-inbox.md`): no owner, no link key, no internal timestamps. */
export interface InboxWire {
  id: string;
  kind: InboxKind;
  level: InboxLevel;
  title: string;
  body: string;
  entryId: string | null;
  url: string | null;
  createdAt: string;
  readAt: string | null;
  expiresAt: string | null;
  data: Record<string, unknown>;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : d instanceof Date ? d.toISOString() : String(d));

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function rowToItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as InboxKind,
    level: row.level === 'error' ? 'error' : 'info',
    title: row.title,
    body: row.body,
    entryId: row.entry_id,
    url: row.url,
    linkKey: row.link_key,
    data: asObject(row.data),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    readAt: iso(row.read_at),
    expiresAt: iso(row.expires_at),
  };
}

export function toWire(item: InboxItem): InboxWire {
  return {
    id: item.id,
    kind: item.kind,
    level: item.level,
    title: item.title,
    body: item.body,
    entryId: item.entryId,
    url: item.url,
    createdAt: item.createdAt,
    readAt: item.readAt,
    expiresAt: item.expiresAt,
    data: item.data,
  };
}

export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface NewInboxItem {
  userId: string;
  kind: InboxKind;
  level?: InboxLevel;
  title: string;
  body?: string;
  entryId?: string | null;
  url?: string | null;
  linkKey?: string | null;
  data?: Record<string, unknown>;
  /** The user already knows (he just saw the outcome in the share sheet): stored as read, no news. */
  read?: boolean;
}

export async function createInboxItem(input: NewInboxItem, now: Date = new Date()): Promise<InboxItem> {
  const level: InboxLevel = input.level === 'error' ? 'error' : 'info';
  const expiresAt = level === 'error' ? null : new Date(now.getTime() + INFO_TTL_MS);
  const rows = await query<InboxRow>(
    `INSERT INTO inbox_items
       (id, user_id, kind, level, title, body, entry_id, url, link_key, data, created_at, updated_at, read_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $11, $12, $13)
     RETURNING *`,
    [
      randomUUID(),
      input.userId,
      input.kind,
      level,
      input.title.slice(0, MAX_TITLE),
      (input.body ?? '').slice(0, MAX_BODY),
      input.entryId ?? null,
      input.url ?? (input.entryId ? entryUrl(input.entryId) : null),
      input.linkKey ?? null,
      JSON.stringify(input.data ?? {}),
      now,
      input.read ? now : null,
      expiresAt,
    ],
  );
  if (level === 'error') await enforceErrorCap(input.userId, now);
  return rowToItem(rows[0]);
}

/** Beyond the cap the oldest errors are removed, so a broken source cannot grow the list without end. */
async function enforceErrorCap(userId: string, now: Date): Promise<void> {
  await query(
    `UPDATE inbox_items SET removed_at = $2, updated_at = $2
      WHERE id IN (
        SELECT id FROM inbox_items
         WHERE user_id = $1 AND level = 'error' AND removed_at IS NULL
         ORDER BY created_at DESC
         OFFSET $3
      )`,
    [userId, now, ERROR_CAP],
  );
}

/**
 * Which of these users were ever told that this entry was shared with them (a `share_received` notice, in whatever
 * state: unread, read, deleted or expired). The notice goes to the ones who were not: a share that failed the first
 * time and works the second tells them the second time, and sharing again changes nothing for the ones already told.
 */
export async function usersNotifiedAbout(entryId: string, users: string[]): Promise<string[]> {
  if (users.length === 0) return [];
  const rows = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM inbox_items
      WHERE kind = 'share_received' AND entry_id = $1 AND user_id = ANY($2::text[])`,
    [entryId, users],
  );
  return rows.map((r) => r.user_id);
}

/** The same link went through: the errors that were waiting for it close by themselves. Returns their ids. */
export async function closeErrorsForLink(userId: string, linkKey: string, now: Date = new Date()): Promise<string[]> {
  if (!linkKey) return [];
  const rows = await query<{ id: string }>(
    `UPDATE inbox_items SET removed_at = $3, updated_at = $3
      WHERE user_id = $1 AND level = 'error' AND link_key = $2 AND removed_at IS NULL
      RETURNING id`,
    [userId, linkKey, now],
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface InboxPage {
  notifications: InboxItem[];
  /** With `since`: what disappeared meanwhile (deleted elsewhere, closed, expired). */
  removedIds: string[];
}

export async function listInbox(
  userId: string,
  opts: { since?: Date | null; limit?: number } = {},
  now: Date = new Date(),
): Promise<InboxPage> {
  const limit = clampLimit(opts.limit);
  const since = opts.since ? new Date(opts.since.getTime() - SINCE_OVERLAP_MS) : null;

  const rows = await query<InboxRow>(
    `SELECT * FROM inbox_items
      WHERE user_id = $1 AND removed_at IS NULL
        AND (expires_at IS NULL OR expires_at > $2)
        AND ($3::timestamptz IS NULL OR updated_at > $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [userId, now, since, limit],
  );

  let removedIds: string[] = [];
  if (since) {
    const removed = await query<{ id: string }>(
      `SELECT id FROM inbox_items
        WHERE user_id = $1
          AND ( (removed_at IS NOT NULL AND removed_at > $2)
             OR (removed_at IS NULL AND expires_at IS NOT NULL AND expires_at > $2 AND expires_at <= $3) )`,
      [userId, since, now],
    );
    removedIds = removed.map((r) => r.id);
  }
  return { notifications: rows.map(rowToItem), removedIds };
}

/**
 * The number on the badge. Every received share counts once: an unread `share_received` notification stands for its
 * share, and a share whose notification is gone (read, deleted or expired) counts only while the share is unseen.
 */
export async function unreadCount(userId: string, now: Date = new Date()): Promise<number> {
  const rows = await query<{ unread: number }>(
    `SELECT (
        (SELECT count(*) FROM inbox_items
          WHERE user_id = $1 AND removed_at IS NULL AND read_at IS NULL
            AND (expires_at IS NULL OR expires_at > $2))
        +
        (SELECT count(*) FROM entry_shares es
          WHERE es.shared_with = $1 AND es.seen_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM inbox_items i
               WHERE i.user_id = $1 AND i.kind = 'share_received' AND i.entry_id = es.entry_id
                 AND i.removed_at IS NULL AND i.read_at IS NULL
                 AND (i.expires_at IS NULL OR i.expires_at > $2)))
      )::int AS unread`,
    [userId, now],
  );
  return rows[0]?.unread ?? 0;
}

export interface ReceivedShare {
  entryId: string;
  from: string;
  sharedAt: string;
  title: string;
  kind: 'spotify' | 'shazam' | 'generic';
  counts: { songs: number; films: number; notes: number; software: number };
  seen: boolean;
  url: string;
}

interface ReceivedRow {
  entry_id: string;
  shared_by: string;
  shared_at: Date;
  seen_at: Date | null;
  caption: string | null;
  source_url: string;
  source_platform: string;
  results: unknown;
}

const arrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/** The entries other people shared with this user, newest first. They do not expire: the share is the source. */
export async function listReceived(userId: string, limitRaw?: unknown): Promise<ReceivedShare[]> {
  const rows = await query<ReceivedRow>(
    `SELECT es.entry_id, es.shared_by, es.created_at AS shared_at, es.seen_at,
            e.caption, e.source_url, e.source_platform, e.results
       FROM entry_shares es
       JOIN entries e ON e.id = es.entry_id
      WHERE es.shared_with = $1
      ORDER BY es.created_at DESC
      LIMIT $2`,
    [userId, clampLimit(limitRaw)],
  );
  return rows.map((r) => {
    const results = asObject(r.results);
    return {
      entryId: r.entry_id,
      from: r.shared_by,
      sharedAt: iso(r.shared_at) as string,
      title: entryTitle({
        caption: r.caption,
        summary: typeof results.summary === 'string' ? results.summary : null,
        sourceUrl: r.source_url,
      }),
      kind: r.source_platform === 'spotify' ? 'spotify' : r.source_platform === 'shazam' ? 'shazam' : 'generic',
      counts: {
        songs: arrayLength(results.songs),
        films: arrayLength(results.films),
        notes: arrayLength(results.notes),
        software: arrayLength(results.software),
      },
      seen: r.seen_at !== null,
      url: entryUrl(r.entry_id),
    };
  });
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

/** Seen and read are one act: opening a share also reads the notice that announced it. */
async function markShareSeen(userId: string, entryId: string, now: Date): Promise<boolean> {
  const rows = await query<{ entry_id: string }>(
    `UPDATE entry_shares SET seen_at = COALESCE(seen_at, $3)
      WHERE entry_id = $1 AND shared_with = $2
      RETURNING entry_id`,
    [entryId, userId, now],
  );
  if (rows.length === 0) return false;
  await query(
    `UPDATE inbox_items SET read_at = $3, updated_at = $3
      WHERE user_id = $2 AND kind = 'share_received' AND entry_id = $1
        AND removed_at IS NULL AND read_at IS NULL`,
    [entryId, userId, now],
  );
  return true;
}

/** `false` when the item is not this user's (or is gone): the route answers 404, never reveals another user's mail. */
export async function markRead(userId: string, id: string, now: Date = new Date()): Promise<boolean> {
  const found = await query<{ kind: string; entry_id: string | null; read_at: Date | null }>(
    `SELECT kind, entry_id, read_at FROM inbox_items WHERE id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [id, userId],
  );
  const item = found[0];
  if (!item) return false;
  if (item.read_at === null) {
    await query(`UPDATE inbox_items SET read_at = $3, updated_at = $3 WHERE id = $1 AND user_id = $2`, [id, userId, now]);
  }
  if (item.kind === 'share_received' && item.entry_id) await markShareSeen(userId, item.entry_id, now);
  return true;
}

/** Reads every notification and sees every received share. Returns how many things were waiting (the old badge). */
export async function markAllRead(userId: string, now: Date = new Date()): Promise<number> {
  const waiting = await unreadCount(userId, now);
  await query(
    `UPDATE inbox_items SET read_at = $2, updated_at = $2
      WHERE user_id = $1 AND removed_at IS NULL AND read_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
    [userId, now],
  );
  await query(`UPDATE entry_shares SET seen_at = $2 WHERE shared_with = $1 AND seen_at IS NULL`, [userId, now]);
  return waiting;
}

/** Removes a notification (an error leaves only this way). Deleting a "shared with you" notice also sees the share. */
export async function deleteItem(userId: string, id: string, now: Date = new Date()): Promise<boolean> {
  const rows = await query<{ kind: string; entry_id: string | null }>(
    `UPDATE inbox_items SET removed_at = $3, updated_at = $3
      WHERE id = $1 AND user_id = $2 AND removed_at IS NULL
      RETURNING kind, entry_id`,
    [id, userId, now],
  );
  const item = rows[0];
  if (!item) return false;
  if (item.kind === 'share_received' && item.entry_id) await markShareSeen(userId, item.entry_id, now);
  return true;
}

/** `false` when nothing was shared with this user under that entry id. */
export async function markReceivedSeen(userId: string, entryId: string, now: Date = new Date()): Promise<boolean> {
  return markShareSeen(userId, entryId, now);
}

// ---------------------------------------------------------------------------
// Housekeeping (daily)
// ---------------------------------------------------------------------------

export interface SweepResult {
  expired: number;
  purged: number;
  intentsPurged: number;
}

/**
 * Information past its 3 days is removed (softly: a device that was away is still told), removals older than a week
 * are forgotten, and finished share intents are dropped. Errors are never touched.
 */
export async function sweepInbox(now: Date = new Date()): Promise<SweepResult> {
  const expired = await query<{ id: string }>(
    `UPDATE inbox_items SET removed_at = $1, updated_at = $1
      WHERE removed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $1
      RETURNING id`,
    [now],
  );
  const purged = await query<{ id: string }>(
    `DELETE FROM inbox_items WHERE removed_at IS NOT NULL AND removed_at < $1 RETURNING id`,
    [new Date(now.getTime() - REMOVAL_MEMORY_MS)],
  );
  const intents = await query<{ id: string }>(
    `DELETE FROM share_intents
      WHERE (status <> 'pending' AND updated_at < $1) OR updated_at < $2
      RETURNING id`,
    [new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)],
  );
  return { expired: expired.length, purged: purged.length, intentsPurged: intents.length };
}
