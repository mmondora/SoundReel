/**
 * What a device did to itself, reported to the server so there is a detailed trail: today, deleting downloaded
 * songs to save space (`delete_songs`, with the full list). Stored durably in `device_events` (the console's
 * "clear logs" never touches it) and written to the activity log. Contract: docs/mondrop-stats.md §2.
 */
import { query } from '../utils/db';
import { describeActor, formatBytes, logActivity, type Actor } from './activityLog';
import { MAX_BATCH, type BatchResult } from './playEvents';

const DAY_MS = 86_400_000;
const MAX_AGE_MS = 400 * DAY_MS;
/** How many songs of one deletion we keep (a block of 2000 is already far beyond a phone's library). */
export const MAX_SONGS = 2000;
/** How many of them go into the console line itself; the full list stays in `device_events`. */
export const LOG_SONGS = 200;

export type DeleteReason = 'manual' | 'least_played' | 'free_space';
const REASONS: ReadonlySet<string> = new Set(['manual', 'least_played', 'free_space']);
const REASON_LABEL: Record<DeleteReason, string> = {
  manual: 'scelta a mano',
  least_played: 'meno ascoltate',
  free_space: 'libera spazio',
};

export interface DeletedSong {
  songKey: string;
  title: string;
  artist: string;
  bytes: number;
  plays: number;
  lastPlayedAt: string | null;
}

export interface DeleteSongsDetails {
  reason: DeleteReason;
  criteria: Record<string, unknown>;
  confirmations: number;
  count: number;
  bytes: number;
  songs: DeletedSong[];
  /** Songs the device listed beyond MAX_SONGS (kept out of the record, counted here). */
  songsDropped: number;
}

export interface DeviceEvent {
  eventId: string;
  at: string;
  type: 'delete_songs';
  details: DeleteSongsDetails;
}

export type DeviceValidation = { ok: true; event: DeviceEvent } | { ok: false; id: string | null; reason: string };

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const nat = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), Number.MAX_SAFE_INTEGER) : 0);

export function validateDeviceEvent(raw: unknown, now: number = Date.now()): DeviceValidation {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bad = (reason: string): DeviceValidation => ({ ok: false, id: typeof o.id === 'string' ? o.id.slice(0, 64) : null, reason });
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(o.id)) return bad('invalid_id');
  if (o.type !== 'delete_songs') return bad('unknown_type');
  const atMs = typeof o.at === 'string' ? Date.parse(o.at) : NaN;
  if (!Number.isFinite(atMs) || atMs < now - MAX_AGE_MS || atMs > now + DAY_MS) return bad('invalid_at');

  const d = (o.details && typeof o.details === 'object' ? o.details : {}) as Record<string, unknown>;
  if (typeof d.reason !== 'string' || !REASONS.has(d.reason)) return bad('invalid_reason');
  if (!Array.isArray(d.songs) || d.songs.length === 0) return bad('songs_required');

  const songs: DeletedSong[] = [];
  for (const item of d.songs.slice(0, MAX_SONGS)) {
    const s = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const songKey = str(s.songKey, 300);
    if (!songKey) return bad('invalid_song');
    const last = typeof s.lastPlayedAt === 'string' && Number.isFinite(Date.parse(s.lastPlayedAt)) ? new Date(s.lastPlayedAt).toISOString() : null;
    songs.push({ songKey, title: str(s.title, 200), artist: str(s.artist, 200), bytes: nat(s.bytes), plays: nat(s.plays), lastPlayedAt: last });
  }
  const listedBytes = songs.reduce((sum, s) => sum + s.bytes, 0);
  const criteria = d.criteria && typeof d.criteria === 'object' && !Array.isArray(d.criteria) ? (d.criteria as Record<string, unknown>) : {};
  return {
    ok: true,
    event: {
      eventId: o.id,
      at: new Date(atMs).toISOString(),
      type: 'delete_songs',
      details: {
        reason: d.reason as DeleteReason,
        criteria,
        confirmations: Math.min(Math.max(nat(d.confirmations), 1), 5),
        // what the device says it deleted, else what it listed
        count: Math.max(nat(d.count), songs.length),
        bytes: nat(d.bytes) || listedBytes,
        songs,
        songsDropped: Math.max(0, d.songs.length - songs.length),
      },
    },
  };
}

export type DeviceBatchOutcome = { ok: true; result: BatchResult } | { ok: false; status: 400 | 413; error: string };

/** The line the console shows for a deletion: who, how many, how much, why, how sure they were. */
export function deletionMessage(actor: Actor, d: DeleteSongsDetails): string {
  const what = d.count === 1 ? '1 brano' : `${d.count} brani`;
  const sure = d.confirmations > 1 ? ` · ${d.confirmations} conferme` : '';
  return `${describeActor(actor)} ha eliminato ${what} dal telefono (${formatBytes(d.bytes)}) — motivo: ${REASON_LABEL[d.reason]}${sure}`;
}

export async function recordDeviceEvents(
  userId: string,
  device: string,
  body: unknown,
  now: number = Date.now(),
): Promise<DeviceBatchOutcome> {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return { ok: false, status: 400, error: 'events_required' };
  if (events.length > MAX_BATCH) return { ok: false, status: 413, error: 'too_many_events' };

  const actor: Actor = { user: userId, device: device || null, channel: 'mondrop' };
  const rejected: BatchResult['rejected'] = [];
  let accepted = 0;
  let duplicates = 0;

  for (const raw of events) {
    const v = validateDeviceEvent(raw, now);
    if (!v.ok) {
      rejected.push({ id: v.id, reason: v.reason });
      continue;
    }
    const e = v.event;
    const rows = await query<{ id: number }>(
      `INSERT INTO device_events (at, user_id, device, type, details, event_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (user_id, event_id) DO NOTHING
       RETURNING id`,
      [e.at, userId, device, e.type, JSON.stringify(e.details), e.eventId],
    );
    if (rows.length === 0) {
      duplicates += 1;
      continue;
    }
    accepted += 1;
    const d = e.details;
    logActivity('device', e.type, deletionMessage(actor, d), actor, {
      eventId: e.eventId,
      at: e.at,
      reason: d.reason,
      criteria: d.criteria,
      confirmations: d.confirmations,
      count: d.count,
      bytes: d.bytes,
      songs: d.songs.slice(0, LOG_SONGS),
      songsNotShown: Math.max(0, d.songs.length - LOG_SONGS) + d.songsDropped,
    });
  }
  return { ok: true, result: { accepted, duplicates, rejected } };
}
