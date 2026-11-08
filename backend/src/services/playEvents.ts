/**
 * Listening sessions reported by the clients (Mondrop, the web player). The client sends raw facts; the server
 * decides what counts as a play, so the rule can change without updating any app.
 * Contract: docs/mondrop-stats.md §1.
 */
import { query } from '../utils/db';

export const MAX_BATCH = 500;
/** A session counts when it lasted at least min(30 s, 50 % of the song). Shorter ones are skips. */
export const COUNT_MIN_MS = 30_000;
export const COUNT_MIN_RATIO = 0.5;

const DAY_MS = 86_400_000;
const MAX_AGE_MS = 400 * DAY_MS;

export type PlayOrigin = 'local' | 'stream' | 'web';
const ORIGINS: ReadonlySet<string> = new Set(['local', 'stream', 'web']);

export interface PlayEvent {
  id: string;
  songKey: string;
  /** ISO 8601 UTC. */
  startedAt: string;
  /** startedAt shifted by the device's UTC offset: the wall-clock time the person heard it (no zone). */
  localStartedAt: string;
  tzOffsetMin: number;
  listenedMs: number;
  durationMs: number | null;
  completed: boolean;
  origin: PlayOrigin;
  playlistId: string | null;
  counted: boolean;
}

export type Validation = { ok: true; event: PlayEvent } | { ok: false; id: string | null; reason: string };

export function isCounted(listenedMs: number, durationMs: number | null): boolean {
  const threshold = durationMs && durationMs > 0 ? Math.min(COUNT_MIN_MS, durationMs * COUNT_MIN_RATIO) : COUNT_MIN_MS;
  return listenedMs >= threshold;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function validatePlayEvent(raw: unknown, now: number = Date.now()): Validation {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof o.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(o.id) ? o.id : null;
  const bad = (reason: string): Validation => ({ ok: false, id: typeof o.id === 'string' ? o.id.slice(0, 64) : null, reason });
  if (!id) return bad('invalid_id');

  if (typeof o.songKey !== 'string' || !o.songKey.trim() || o.songKey.length > 300) return bad('invalid_songKey');

  const startedMs = typeof o.startedAt === 'string' ? Date.parse(o.startedAt) : NaN;
  if (!Number.isFinite(startedMs) || startedMs < now - MAX_AGE_MS || startedMs > now + DAY_MS) return bad('invalid_startedAt');

  if (!isInt(o.tzOffsetMin, -840, 840)) return bad('invalid_tzOffsetMin');
  if (!isInt(o.listenedMs, 0, DAY_MS)) return bad('invalid_listenedMs');
  const durationMs = o.durationMs === null || o.durationMs === undefined ? null : o.durationMs;
  if (durationMs !== null && !isInt(durationMs, 0, DAY_MS)) return bad('invalid_durationMs');
  if (o.completed !== undefined && typeof o.completed !== 'boolean') return bad('invalid_completed');
  const origin = o.origin === undefined ? 'local' : o.origin;
  if (typeof origin !== 'string' || !ORIGINS.has(origin)) return bad('invalid_origin');
  const playlistId = o.playlistId === null || o.playlistId === undefined ? null : o.playlistId;
  if (playlistId !== null && (typeof playlistId !== 'string' || playlistId.length > 100)) return bad('invalid_playlistId');

  return {
    ok: true,
    event: {
      id,
      songKey: o.songKey,
      startedAt: new Date(startedMs).toISOString(),
      localStartedAt: new Date(startedMs + o.tzOffsetMin * 60_000).toISOString().replace('Z', ''),
      tzOffsetMin: o.tzOffsetMin,
      listenedMs: o.listenedMs,
      durationMs,
      completed: o.completed === true,
      origin: origin as PlayOrigin,
      playlistId,
      counted: isCounted(o.listenedMs, durationMs),
    },
  };
}

export interface BatchResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ id: string | null; reason: string }>;
}

export type BatchOutcome = { ok: true; result: BatchResult; counted: number } | { ok: false; status: 400 | 413; error: string };

/** Validate a client batch and store what is valid. Idempotent: an event already stored is a duplicate, not an error. */
export async function recordPlayEvents(
  userId: string,
  device: string,
  body: unknown,
  now: number = Date.now(),
): Promise<BatchOutcome> {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return { ok: false, status: 400, error: 'events_required' };
  if (events.length > MAX_BATCH) return { ok: false, status: 413, error: 'too_many_events' };

  const valid: PlayEvent[] = [];
  const rejected: BatchResult['rejected'] = [];
  for (const raw of events) {
    const v = validatePlayEvent(raw, now);
    if (v.ok) valid.push(v.event);
    else rejected.push({ id: v.id, reason: v.reason });
  }

  let accepted = 0;
  let counted = 0;
  if (valid.length > 0) {
    const rows = await query<{ id: string; counted: boolean }>(
      `INSERT INTO play_events
         (user_id, id, device, song_key, started_at, local_started_at, tz_offset_min, listened_ms, duration_ms,
          completed, origin, playlist_id, counted)
       SELECT $1, t.id, t.device, t.song_key, t.started_at, t.local_started_at, t.tz_offset_min, t.listened_ms,
              t.duration_ms, t.completed, t.origin, t.playlist_id, t.counted
         FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamp[], $7::int[], $8::int[],
                     $9::int[], $10::boolean[], $11::text[], $12::text[], $13::boolean[])
              AS t(id, device, song_key, started_at, local_started_at, tz_offset_min, listened_ms, duration_ms,
                   completed, origin, playlist_id, counted)
       ON CONFLICT (user_id, id) DO NOTHING
       RETURNING id, counted`,
      [
        userId,
        valid.map((e) => e.id),
        valid.map(() => device),
        valid.map((e) => e.songKey),
        valid.map((e) => e.startedAt),
        valid.map((e) => e.localStartedAt),
        valid.map((e) => e.tzOffsetMin),
        valid.map((e) => e.listenedMs),
        valid.map((e) => e.durationMs),
        valid.map((e) => e.completed),
        valid.map((e) => e.origin),
        valid.map((e) => e.playlistId),
        valid.map((e) => e.counted),
      ],
    );
    accepted = rows.length;
    counted = rows.filter((r) => r.counted).length;
  }
  return { ok: true, counted, result: { accepted, duplicates: valid.length - accepted, rejected } };
}
