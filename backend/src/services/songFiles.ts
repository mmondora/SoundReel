/**
 * Persistence for per-song MP3 files and their download queue (table `song_files`,
 * migration 016). One row per song: the status drives the queue, so there is exactly
 * one job per song and re-requesting a song never duplicates work.
 *
 *   queued ──claim──▶ downloading ──▶ ready
 *      ▲                  │
 *      └──── backoff ─────┤──▶ failed     (retryable on request)
 *                         └──▶ no_source  (needs a user-supplied YouTube link)
 */
import { query } from '../utils/db';

export type SongFileStatus = 'queued' | 'downloading' | 'ready' | 'failed' | 'no_source';
/**
 * library = a file already in the library (Spooty, earlier downloads) · ytdlp = downloaded from YouTube ·
 * mediaserver = the song IS a file of the media server (no copy of ours: `rel_path` is null) ·
 * existing = legacy (2.7.0 copied the box's file onto the disk; 2.8.0 retires those copies)
 */
export type SongFileSource = 'library' | 'ytdlp' | 'mediaserver' | 'existing';

/** 10 = somebody is waiting for the song (first play), 0 = playlist sync. */
export const PRIORITY_PLAY = 10;
export const PRIORITY_SYNC = 0;

export interface SongFile {
  songKey: string;
  status: SongFileStatus;
  source: SongFileSource | null;
  relPath: string | null;
  bytes: number | null;
  mtimeMs: number | null;
  durationS: number | null;
  match: string | null;
  videoId: string | null;
  videoUrlOverride: string | null;
  mediaUrl: string | null;
  /** Volume-relative path of the box's OWN file when the song is that file (adopted, never copied); null for a replica of ours. */
  mediaRelPath: string | null;
  publishedAt: Date | null;
  error: string | null;
  attempts: number;
  priority: number;
  nextAttemptAt: Date;
  lockedAt: Date | null;
  requestedBy: string | null;
  artist: string;
  title: string;
  album: string | null;
  coverUrl: string | null;
  expectedDurationS: number | null;
  updatedAt: Date;
}

interface Row {
  song_key: string;
  status: string;
  source: string | null;
  rel_path: string | null;
  bytes: string | number | null;
  mtime_ms: string | number | null;
  duration_s: number | null;
  match: string | null;
  video_id: string | null;
  video_url_override: string | null;
  media_url: string | null;
  media_rel_path: string | null;
  published_at: Date | null;
  error: string | null;
  attempts: number;
  priority: number;
  next_attempt_at: Date;
  locked_at: Date | null;
  requested_by: string | null;
  artist: string;
  title: string;
  album: string | null;
  cover_url: string | null;
  expected_duration_s: number | null;
  updated_at: Date;
}

const COLS = `song_key, status, source, rel_path, bytes, mtime_ms, duration_s, match, video_id, video_url_override,
  media_url, media_rel_path, published_at, error, attempts, priority, next_attempt_at, locked_at, requested_by,
  artist, title, album, cover_url, expected_duration_s, updated_at`;

const num = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v));

export function fromRow(r: Row): SongFile {
  return {
    songKey: r.song_key,
    status: r.status as SongFileStatus,
    source: r.source as SongFileSource | null,
    relPath: r.rel_path,
    bytes: num(r.bytes),
    mtimeMs: num(r.mtime_ms),
    durationS: r.duration_s,
    match: r.match,
    videoId: r.video_id,
    videoUrlOverride: r.video_url_override,
    mediaUrl: r.media_url,
    mediaRelPath: r.media_rel_path,
    publishedAt: r.published_at ? new Date(r.published_at) : null,
    error: r.error,
    attempts: r.attempts,
    priority: r.priority,
    nextAttemptAt: new Date(r.next_attempt_at),
    lockedAt: r.locked_at ? new Date(r.locked_at) : null,
    requestedBy: r.requested_by,
    artist: r.artist,
    title: r.title,
    album: r.album,
    coverUrl: r.cover_url,
    expectedDurationS: r.expected_duration_s,
    updatedAt: new Date(r.updated_at),
  };
}

export async function getSongFile(songKey: string): Promise<SongFile | null> {
  const rows = await query<Row>(`SELECT ${COLS} FROM song_files WHERE song_key = $1`, [songKey]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function getSongFiles(songKeys: string[]): Promise<Map<string, SongFile>> {
  const out = new Map<string, SongFile>();
  if (songKeys.length === 0) return out;
  const rows = await query<Row>(`SELECT ${COLS} FROM song_files WHERE song_key = ANY($1::text[])`, [songKeys]);
  for (const r of rows) out.set(r.song_key, fromRow(r));
  return out;
}

export interface SongRequest {
  songKey: string;
  artist: string;
  title: string;
  album?: string | null;
  coverUrl?: string | null;
  expectedDurationS?: number | null;
  requestedBy?: string | null;
  priority?: number;
  /** Put a failed / no_source song back in the queue (an explicit retry or somebody is waiting for it). */
  retry?: boolean;
}

/**
 * Ask for a song's file. Never touches a song that is already `ready` or being downloaded;
 * an already queued song only gets its priority raised (and is made due when somebody waits).
 */
export async function enqueueSongDownload(req: SongRequest): Promise<SongFile> {
  const priority = req.priority ?? PRIORITY_SYNC;
  const rows = await query<Row>(
    `INSERT INTO song_files
       (song_key, status, priority, requested_by, artist, title, album, cover_url, expected_duration_s)
     VALUES ($1, 'queued', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (song_key) DO UPDATE SET
       status = CASE
         WHEN song_files.status IN ('failed', 'no_source') AND $9::boolean THEN 'queued'
         ELSE song_files.status END,
       attempts = CASE
         WHEN song_files.status IN ('failed', 'no_source') AND $9::boolean THEN 0
         ELSE song_files.attempts END,
       error = CASE
         WHEN song_files.status IN ('failed', 'no_source') AND $9::boolean THEN NULL
         ELSE song_files.error END,
       priority = CASE
         WHEN song_files.status IN ('ready', 'downloading') THEN song_files.priority
         ELSE GREATEST(song_files.priority, EXCLUDED.priority) END,
       next_attempt_at = CASE
         WHEN (song_files.status = 'queued' OR (song_files.status IN ('failed', 'no_source') AND $9::boolean))
              AND EXCLUDED.priority >= ${PRIORITY_PLAY}
           THEN now()
         WHEN song_files.status IN ('failed', 'no_source') AND $9::boolean THEN now()
         ELSE song_files.next_attempt_at END,
       requested_by = COALESCE(song_files.requested_by, EXCLUDED.requested_by),
       artist = CASE WHEN song_files.artist = '' THEN EXCLUDED.artist ELSE song_files.artist END,
       title = CASE WHEN song_files.title = '' THEN EXCLUDED.title ELSE song_files.title END,
       album = COALESCE(song_files.album, EXCLUDED.album),
       cover_url = COALESCE(song_files.cover_url, EXCLUDED.cover_url),
       expected_duration_s = COALESCE(song_files.expected_duration_s, EXCLUDED.expected_duration_s),
       updated_at = now()
     RETURNING ${COLS}`,
    [
      req.songKey,
      priority,
      req.requestedBy ?? null,
      req.artist,
      req.title,
      req.album ?? null,
      req.coverUrl ?? null,
      req.expectedDurationS ?? null,
      req.retry === true,
    ],
  );
  return fromRow(rows[0]);
}

/** Atomically take up to `limit` due jobs (highest priority first). Safe with several workers. */
export async function claimNextDownloads(limit: number): Promise<SongFile[]> {
  const rows = await query<Row>(
    `UPDATE song_files SET status = 'downloading', locked_at = now(), updated_at = now()
      WHERE song_key IN (
        SELECT song_key FROM song_files
         WHERE status = 'queued' AND next_attempt_at <= now()
         ORDER BY priority DESC, next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING ${COLS}`,
    [limit],
  );
  // UPDATE … RETURNING does not keep the subquery's ORDER BY: the caller starts them in priority order.
  return rows
    .map(fromRow)
    .sort((a, b) => b.priority - a.priority || a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
}

/** Jobs whose worker died mid-download go back to the queue. Returns how many. */
export async function releaseStaleDownloads(maxAgeMs: number): Promise<number> {
  const rows = await query<{ song_key: string }>(
    `UPDATE song_files SET status = 'queued', locked_at = NULL, updated_at = now()
      WHERE status = 'downloading' AND locked_at < now() - ($1 * interval '1 millisecond')
      RETURNING song_key`,
    [maxAgeMs],
  );
  return rows.length;
}

export interface ReadyFile {
  source: SongFileSource;
  /** Null for a song that only lives on the media server. */
  relPath: string | null;
  bytes: number;
  mtimeMs: number;
  durationS?: number | null;
  match?: string | null;
  videoId?: string | null;
  /** The song IS this file of the media server (path on the volume + direct URL): published at once, never copied. */
  original?: { relPath: string; url: string } | null;
}

/**
 * Record a finished file (creating the row for library/existing files that never went through
 * the queue). A new file invalidates any earlier replica URL: it will be verified again.
 */
export async function markReady(
  songKey: string,
  file: ReadyFile,
  meta?: { artist?: string; title?: string; album?: string | null; coverUrl?: string | null },
): Promise<SongFile> {
  const changed = `(song_files.rel_path IS DISTINCT FROM EXCLUDED.rel_path OR song_files.bytes IS DISTINCT FROM EXCLUDED.bytes)`;
  const rows = await query<Row>(
    `INSERT INTO song_files (song_key, status, source, rel_path, bytes, mtime_ms, duration_s, match, video_id, artist, title, album, cover_url,
                             media_url, media_rel_path, published_at)
     VALUES ($1, 'ready', $2, $3, $4, $5, $6, $7, $8, COALESCE($9, ''), COALESCE($10, ''), $11, $12,
             $13, $14, CASE WHEN $13::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (song_key) DO UPDATE SET
       status = 'ready', source = EXCLUDED.source, rel_path = EXCLUDED.rel_path, bytes = EXCLUDED.bytes,
       mtime_ms = EXCLUDED.mtime_ms, duration_s = COALESCE(EXCLUDED.duration_s, song_files.duration_s),
       match = EXCLUDED.match, video_id = COALESCE(EXCLUDED.video_id, song_files.video_id),
       error = NULL, attempts = 0, locked_at = NULL,
       -- a song that IS a file of the media server (adopted original) is published at once; any other new
       -- file invalidates an earlier replica URL, which is verified again
       media_url = CASE WHEN EXCLUDED.media_url IS NOT NULL THEN EXCLUDED.media_url
                        WHEN ${changed} THEN NULL ELSE song_files.media_url END,
       media_rel_path = CASE WHEN EXCLUDED.media_rel_path IS NOT NULL THEN EXCLUDED.media_rel_path
                             WHEN ${changed} THEN NULL ELSE song_files.media_rel_path END,
       published_at = CASE WHEN EXCLUDED.media_url IS NOT NULL THEN now()
                           WHEN ${changed} THEN NULL ELSE song_files.published_at END,
       album = COALESCE(song_files.album, EXCLUDED.album),
       cover_url = COALESCE(song_files.cover_url, EXCLUDED.cover_url),
       updated_at = now()
     RETURNING ${COLS}`,
    [
      songKey,
      file.source,
      file.relPath,
      file.bytes,
      file.mtimeMs,
      file.durationS ?? null,
      file.match ?? null,
      file.videoId ?? null,
      meta?.artist ?? null,
      meta?.title ?? null,
      meta?.album ?? null,
      meta?.coverUrl ?? null,
      file.original?.url ?? null,
      file.original?.relPath ?? null,
    ],
  );
  return fromRow(rows[0]);
}

export interface FailureOutcome {
  error: string;
  /** `no_source` and `failed` end the job (until retried); omitted = back to the queue after the delay. */
  terminal?: 'failed' | 'no_source';
  retryInMs?: number;
}

export async function markAttemptFailed(songKey: string, outcome: FailureOutcome): Promise<void> {
  if (outcome.terminal) {
    await query(
      `UPDATE song_files SET status = $2, error = $3, attempts = attempts + 1, locked_at = NULL, updated_at = now()
        WHERE song_key = $1`,
      [songKey, outcome.terminal, outcome.error],
    );
    return;
  }
  await query(
    `UPDATE song_files SET status = 'queued', error = $2, attempts = attempts + 1, locked_at = NULL,
            next_attempt_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
      WHERE song_key = $1`,
    [songKey, outcome.error, outcome.retryInMs ?? 60_000],
  );
}

/**
 * Put a job back in the queue for later WITHOUT counting an attempt: the work is not failing, something it
 * depends on (the box's USB drive) is away. It runs again after `delayMs`.
 */
export async function deferJob(songKey: string, delayMs: number, reason: string): Promise<void> {
  await query(
    `UPDATE song_files SET status = 'queued', locked_at = NULL, error = $3,
            next_attempt_at = now() + ($2 * interval '1 millisecond'), updated_at = now()
      WHERE song_key = $1`,
    [songKey, delayMs, reason],
  );
}

/** A user-supplied YouTube URL wins over the search; the song goes back in the queue at once. */
export async function setVideoOverride(songKey: string, youtubeUrl: string): Promise<void> {
  await query(
    `UPDATE song_files SET video_url_override = $2, status = CASE WHEN status = 'ready' THEN status ELSE 'queued' END,
            error = CASE WHEN status = 'ready' THEN error ELSE NULL END,
            attempts = CASE WHEN status = 'ready' THEN attempts ELSE 0 END,
            next_attempt_at = now(), updated_at = now()
      WHERE song_key = $1`,
    [songKey, youtubeUrl],
  );
}

/** Forget a ready file whose bytes are gone (deleted from disk): the song becomes a new job. */
export async function resetToQueued(songKey: string): Promise<void> {
  await query(
    `UPDATE song_files SET status = 'queued', source = NULL, rel_path = NULL, bytes = NULL, mtime_ms = NULL,
            media_url = NULL, media_rel_path = NULL, published_at = NULL, error = NULL, attempts = 0, locked_at = NULL,
            next_attempt_at = now(), updated_at = now()
      WHERE song_key = $1`,
    [songKey],
  );
}

/**
 * A song whose local copy was retired: it is now just the media server's own file (`original`). Only ever
 * applied to a ready row; the caller has already verified the original and removed the local file.
 */
export async function markMediaOnly(
  songKey: string,
  file: { bytes: number; mtimeMs: number; original: { relPath: string; url: string } },
): Promise<void> {
  await query(
    `UPDATE song_files SET source = 'mediaserver', rel_path = NULL, bytes = $2, mtime_ms = $3,
            media_rel_path = $4, media_url = $5, published_at = now(), updated_at = now()
      WHERE song_key = $1 AND status = 'ready'`,
    [songKey, file.bytes, file.mtimeMs, file.original.relPath, file.original.url],
  );
}

/** Ready files that 2.7.0 copied from the media server onto the disk (source `existing`): see services/retireCopies. */
export async function listLegacyCopies(limit = 500): Promise<SongFile[]> {
  const rows = await query<Row>(
    `SELECT ${COLS} FROM song_files WHERE status = 'ready' AND source = 'existing' AND rel_path IS NOT NULL
      ORDER BY updated_at ASC LIMIT $1`,
    [limit],
  );
  return rows.map(fromRow);
}

export async function markPublished(songKey: string, mediaUrl: string): Promise<void> {
  await query(`UPDATE song_files SET media_url = $2, published_at = now(), updated_at = now() WHERE song_key = $1`, [
    songKey,
    mediaUrl,
  ]);
}

export async function clearPublished(songKey: string): Promise<void> {
  await query(`UPDATE song_files SET media_url = NULL, published_at = NULL, updated_at = now() WHERE song_key = $1`, [
    songKey,
  ]);
}

/** Ready files whose replica on the media server has not been verified yet. */
export async function listReadyUnpublished(limit = 200): Promise<SongFile[]> {
  const rows = await query<Row>(
    `SELECT ${COLS} FROM song_files WHERE status = 'ready' AND published_at IS NULL AND rel_path IS NOT NULL
      ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(fromRow);
}

/** Published files not re-checked for a while (the replica may have been removed from the stick). */
export async function listPublishedOlderThan(maxAgeMs: number, limit = 200): Promise<SongFile[]> {
  const rows = await query<Row>(
    `SELECT ${COLS} FROM song_files
      WHERE status = 'ready' AND published_at IS NOT NULL AND published_at < now() - ($1 * interval '1 millisecond')
      ORDER BY published_at ASC LIMIT $2`,
    [maxAgeMs, limit],
  );
  return rows.map(fromRow);
}

export async function countSongFilesByStatus(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: string | number }>(
    `SELECT status, COUNT(*) AS n FROM song_files GROUP BY status`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

export async function countPublished(): Promise<number> {
  const rows = await query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM song_files WHERE status = 'ready' AND published_at IS NOT NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Where every ready song's file is, for flagging a whole song list with one query (spec W2/W8). */
export interface SongFileLocationRow {
  songKey: string;
  status: SongFileStatus;
  relPath: string | null;
  mediaRelPath: string | null;
  mediaUrl: string | null;
  videoId: string | null;
}

export async function listSongFileLocations(): Promise<Map<string, SongFileLocationRow>> {
  const rows = await query<{
    song_key: string;
    status: string;
    rel_path: string | null;
    media_rel_path: string | null;
    media_url: string | null;
    video_id: string | null;
  }>(`SELECT song_key, status, rel_path, media_rel_path, CASE WHEN published_at IS NULL THEN NULL ELSE media_url END AS media_url, video_id
        FROM song_files WHERE status = 'ready' OR video_id IS NOT NULL`);
  return new Map(
    rows.map((r) => [
      r.song_key,
      {
        songKey: r.song_key,
        status: r.status as SongFileStatus,
        relPath: r.rel_path,
        mediaRelPath: r.media_rel_path,
        mediaUrl: r.media_url,
        videoId: r.video_id,
      },
    ]),
  );
}

/** Keys of every song with a ready file (a cheap way to flag a whole song list). */
export async function listReadySongKeys(): Promise<Set<string>> {
  const rows = await query<{ song_key: string }>(`SELECT song_key FROM song_files WHERE status = 'ready'`);
  return new Set(rows.map((r) => r.song_key));
}
