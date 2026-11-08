/**
 * Aggregates over `play_events` for the web dashboard (docs/mondrop-stats.md §5) and the per-song numbers the
 * manifest carries (`plays`, `lastPlayedAt`). Days and hours come from `local_started_at`, the wall-clock time at
 * the device when the song was heard, so "7 in the morning" means 7 in the morning wherever the server runs.
 */
import { query } from '../utils/db';
import { canonicalGenre } from '../utils/genres';

export interface StatsFilter {
  /** null = every user (admin only: the route decides). */
  userIds: string[] | null;
  device?: string | null;
  /** Local calendar days, inclusive: "YYYY-MM-DD". */
  from: string;
  to: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: unknown): s is string => typeof s === 'string' && DAY_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

/** The shared filter; `alias` prefixes the columns when the table is joined (`e.`). */
function where(f: StatsFilter, alias = ''): { sql: string; params: unknown[] } {
  const a = alias;
  const params: unknown[] = [f.userIds, f.from, f.to, f.device ?? null];
  return {
    sql: `($1::text[] IS NULL OR ${a}user_id = ANY($1::text[]))
          AND ${a}local_started_at >= $2::date AND ${a}local_started_at < ($3::date + 1)
          AND ($4::text IS NULL OR ${a}device = $4::text)`,
    params,
  };
}

export interface SongTotals {
  songKey: string;
  plays: number;
  listenedMs: number;
  lastPlayedAt: string | null;
}

export interface ListeningStats {
  period: { from: string; to: string };
  totals: { plays: number; skips: number; listenedMs: number; songs: number; artists: number; devices: number };
  perDay: Array<{ day: string; plays: number; listenedMs: number }>;
  /** 7 rows (Monday = 0) × 24 hours (local), counted plays. */
  heatmap: number[][];
  topSongs: SongTotals[];
  topArtists: Array<{ artist: string; plays: number }>;
  topGenres: Array<{ genre: string; plays: number }>;
  perDevice: Array<{ device: string; plays: number; listenedMs: number }>;
  perOrigin: Array<{ origin: string; plays: number; listenedMs: number }>;
  /** Songs that have never had a counted play (all time, same users), filled in by the caller. */
  playedSongKeys: string[];
}

const n = (v: unknown): number => Number(v ?? 0);

export async function getListeningStats(f: StatsFilter): Promise<ListeningStats> {
  const w = where(f);
  const base = `FROM play_events WHERE ${w.sql}`;

  const [totals, perDay, heat, songs, artists, genres, devices, origins, played] = await Promise.all([
    query<{ plays: string; skips: string; listened_ms: string; songs: string; artists: string; devices: string }>(
      `SELECT COUNT(*) FILTER (WHERE counted) AS plays,
              COUNT(*) FILTER (WHERE NOT counted) AS skips,
              COALESCE(SUM(listened_ms), 0) AS listened_ms,
              COUNT(DISTINCT song_key) FILTER (WHERE counted) AS songs,
              COUNT(DISTINCT split_part(song_key, '::', 1)) FILTER (WHERE counted) AS artists,
              COUNT(DISTINCT device) AS devices
         ${base}`,
      w.params,
    ),
    query<{ day: string; plays: string; listened_ms: string }>(
      `SELECT to_char(local_started_at::date, 'YYYY-MM-DD') AS day, COUNT(*) FILTER (WHERE counted) AS plays,
              COALESCE(SUM(listened_ms), 0) AS listened_ms
         ${base} GROUP BY 1 ORDER BY 1`,
      w.params,
    ),
    query<{ dow: number; hour: number; plays: string }>(
      `SELECT (EXTRACT(ISODOW FROM local_started_at)::int - 1) AS dow, EXTRACT(HOUR FROM local_started_at)::int AS hour,
              COUNT(*) FILTER (WHERE counted) AS plays
         ${base} GROUP BY 1, 2`,
      w.params,
    ),
    query<{ song_key: string; plays: string; listened_ms: string; last_at: Date }>(
      `SELECT song_key, COUNT(*) FILTER (WHERE counted) AS plays, COALESCE(SUM(listened_ms), 0) AS listened_ms,
              MAX(started_at) FILTER (WHERE counted) AS last_at
         ${base} GROUP BY song_key HAVING COUNT(*) FILTER (WHERE counted) > 0
        ORDER BY plays DESC, last_at DESC LIMIT 20`,
      w.params,
    ),
    query<{ artist: string; plays: string }>(
      `SELECT split_part(song_key, '::', 1) AS artist, COUNT(*) FILTER (WHERE counted) AS plays
         ${base} GROUP BY 1 HAVING COUNT(*) FILTER (WHERE counted) > 0 ORDER BY plays DESC, artist LIMIT 20`,
      w.params,
    ),
    query<{ genre: string; plays: string }>(
      `SELECT g AS genre, COUNT(*) AS plays
         FROM play_events e JOIN song_meta sm ON sm.song_key = e.song_key, unnest(sm.genres) g
        WHERE e.counted AND ${where(f, 'e.').sql}
        GROUP BY g`,
      w.params,
    ),
    query<{ device: string; plays: string; listened_ms: string }>(
      `SELECT device, COUNT(*) FILTER (WHERE counted) AS plays, COALESCE(SUM(listened_ms), 0) AS listened_ms
         ${base} GROUP BY device ORDER BY plays DESC, device`,
      w.params,
    ),
    query<{ origin: string; plays: string; listened_ms: string }>(
      `SELECT origin, COUNT(*) FILTER (WHERE counted) AS plays, COALESCE(SUM(listened_ms), 0) AS listened_ms
         ${base} GROUP BY origin ORDER BY plays DESC, origin`,
      w.params,
    ),
    query<{ song_key: string }>(
      `SELECT DISTINCT song_key FROM play_events WHERE counted AND ($1::text[] IS NULL OR user_id = ANY($1::text[]))`,
      [f.userIds],
    ),
  ]);

  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of heat) if (r.dow >= 0 && r.dow < 7 && r.hour >= 0 && r.hour < 24) heatmap[r.dow][r.hour] = n(r.plays);

  // Deezer / iTunes name one genre several ways: the dashboard merges them like the filters do.
  const genreTotals = new Map<string, number>();
  for (const r of genres) genreTotals.set(canonicalGenre(r.genre), (genreTotals.get(canonicalGenre(r.genre)) ?? 0) + n(r.plays));

  const t = totals[0];
  return {
    period: { from: f.from, to: f.to },
    totals: {
      plays: n(t?.plays), skips: n(t?.skips), listenedMs: n(t?.listened_ms), songs: n(t?.songs), artists: n(t?.artists), devices: n(t?.devices),
    },
    perDay: fillDays(f.from, f.to, perDay.map((r) => ({ day: r.day, plays: n(r.plays), listenedMs: n(r.listened_ms) }))),
    heatmap,
    topSongs: songs.map((r) => ({ songKey: r.song_key, plays: n(r.plays), listenedMs: n(r.listened_ms), lastPlayedAt: r.last_at ? new Date(r.last_at).toISOString() : null })),
    topArtists: artists.map((r) => ({ artist: r.artist, plays: n(r.plays) })),
    topGenres: [...genreTotals].map(([genre, plays]) => ({ genre, plays })).sort((a, b) => b.plays - a.plays || a.genre.localeCompare(b.genre, 'it')).slice(0, 15),
    perDevice: devices.map((r) => ({ device: r.device || 'sconosciuto', plays: n(r.plays), listenedMs: n(r.listened_ms) })),
    perOrigin: origins.map((r) => ({ origin: r.origin, plays: n(r.plays), listenedMs: n(r.listened_ms) })),
    playedSongKeys: played.map((r) => r.song_key),
  };
}

/** One row per calendar day of the period, zeros included, so a chart has no holes. */
export function fillDays(
  from: string,
  to: string,
  rows: Array<{ day: string; plays: number; listenedMs: number }>,
): Array<{ day: string; plays: number; listenedMs: number }> {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: Array<{ day: string; plays: number; listenedMs: number }> = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 3700; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, plays: 0, listenedMs: 0 });
  }
  return out;
}

export interface RecentPlay {
  id: string;
  userId: string;
  device: string;
  songKey: string;
  startedAt: string;
  localStartedAt: string;
  listenedMs: number;
  durationMs: number | null;
  counted: boolean;
  completed: boolean;
  origin: string;
}

export async function getRecentPlays(f: { userIds: string[] | null; device?: string | null }, limit = 50): Promise<RecentPlay[]> {
  const rows = await query<{
    id: string; user_id: string; device: string; song_key: string; started_at: Date; local_started_at: string;
    listened_ms: number; duration_ms: number | null; counted: boolean; completed: boolean; origin: string;
  }>(
    // `local_started_at` is a zone-less wall-clock time: read it as text, never through a JS Date (which would
    // shift it by the timezone of the process).
    `SELECT id, user_id, device, song_key, started_at, to_char(local_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS local_started_at,
            listened_ms, duration_ms, counted, completed, origin
       FROM play_events
      WHERE ($1::text[] IS NULL OR user_id = ANY($1::text[])) AND ($2::text IS NULL OR device = $2::text)
      ORDER BY started_at DESC LIMIT $3`,
    [f.userIds, f.device ?? null, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    id: r.id, userId: r.user_id, device: r.device, songKey: r.song_key,
    startedAt: new Date(r.started_at).toISOString(),
    localStartedAt: r.local_started_at,
    listenedMs: r.listened_ms, durationMs: r.duration_ms, counted: r.counted, completed: r.completed, origin: r.origin,
  }));
}

/** Counted plays of a user (all devices, all time) per song, for `plays` / `lastPlayedAt` on manifest tracks. */
export async function getSongPlayStats(userId: string, songKeys: string[]): Promise<Map<string, { plays: number; lastPlayedAt: string | null }>> {
  const out = new Map<string, { plays: number; lastPlayedAt: string | null }>();
  if (songKeys.length === 0) return out;
  const rows = await query<{ song_key: string; plays: number; last_at: Date | null }>(
    `SELECT song_key, COUNT(*) FILTER (WHERE counted)::int AS plays, MAX(started_at) FILTER (WHERE counted) AS last_at
       FROM play_events WHERE user_id = $1 AND song_key = ANY($2::text[]) GROUP BY song_key`,
    [userId, songKeys],
  );
  for (const r of rows) out.set(r.song_key, { plays: r.plays, lastPlayedAt: r.last_at ? new Date(r.last_at).toISOString() : null });
  return out;
}
