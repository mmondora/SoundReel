/**
 * The likes of the songs (ADR-0028, contract docs/mondrop-likes.md): «this song pleases me», of ONE person (the user of the Mondrop key), kept on the server
 * (rule P: the phone draws it and sends it, it does not decide it). Migration 025.
 *
 * One row per person and song (`song_likes`, key (user_id, song_key)); no «dislike»; nothing about the song itself, because a song key is the identity everywhere.
 * The favorite, the like and the dislike of the SITE (`song_meta`) are another thing: one value for the song, the same for everybody. Nothing here touches them.
 *
 * The rules that decide what a key is and what the moment of a like is are pure; the queries only read and write. Nothing here asks whether the song EXISTS:
 * a song that is only a file has a key of its own and can be liked like any other (and a like for a song that is gone is harmless).
 */
import { query } from '../utils/db';

/** The same limit as a song put in a playlist (`POST /api/mondrop/playlists/:id/songs`): what can be put in a playlist can be liked. */
export const MAX_SONG_KEY = 500;

/**
 * The longest a key can be once percent-encoded in a path: a character takes at most nine (three UTF-8 bytes, `%E6%97%A5`). The router of the server must
 * accept that much (`maxParamLength`): its default of 100 answers 404 to a long title (classical music), which the app would take for an old server.
 */
export const MAX_ENCODED_SONG_KEY = MAX_SONG_KEY * 9;

/** The key as the app sends it, trimmed; null when it is no key (not a string, empty, or longer than `MAX_SONG_KEY`). Never touched otherwise: a key is an identity, not a spelling. */
export function normalizeSongKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key.length >= 1 && key.length <= MAX_SONG_KEY ? key : null;
}

/** What the app writes (`2026-11-10T17:58:00.000Z`, or with an offset): a date AND a time, never a bare number or a year. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * When the like was given: the moment the app says (a like given without a network goes out later), but never in the future (the earlier of the two), and
 * «now» when the app says nothing or says something that is not a date. A bad value is never an error.
 */
export function likeTime(raw: unknown, now: Date): Date {
  if (typeof raw !== 'string' || !ISO_INSTANT.test(raw)) return now;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return now;
  return ms < now.getTime() ? new Date(ms) : now;
}

export interface LikeRow {
  songKey: string;
  /** ISO string, as the contract says. */
  likedAt: string;
}

type DbInstant = Date | string;

/** The likes of ONE person, the most recent first (at the same moment, by key: two reads never swap two rows). */
export async function listLikes(userId: string): Promise<LikeRow[]> {
  const rows = await query<{ song_key: string; liked_at: DbInstant }>(
    'SELECT song_key, liked_at FROM song_likes WHERE user_id = $1 ORDER BY liked_at DESC, song_key COLLATE "C" ASC',
    [userId],
  );
  return rows.map((r) => ({ songKey: r.song_key, likedAt: new Date(r.liked_at).toISOString() }));
}

/** Only the keys, in the same order: what the playlist «Mi piace» reads. */
export async function likedKeys(userId: string): Promise<string[]> {
  const rows = await query<{ song_key: string }>(
    'SELECT song_key FROM song_likes WHERE user_id = $1 ORDER BY liked_at DESC, song_key COLLATE "C" ASC',
    [userId],
  );
  return rows.map((r) => r.song_key);
}

/**
 * Puts the like. IDEMPOTENT: a like that is already there is not touched (its FIRST date stays) and `created` is false. `created` is what tells the caller
 * that the person has just liked it (the first like of a person makes his playlist).
 */
export async function putLike(userId: string, songKey: string, at: Date): Promise<{ created: boolean; likedAt: Date }> {
  const inserted = await query<{ liked_at: DbInstant }>(
    'INSERT INTO song_likes (user_id, song_key, liked_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, song_key) DO NOTHING RETURNING liked_at',
    [userId, songKey, at],
  );
  if (inserted[0]) return { created: true, likedAt: new Date(inserted[0].liked_at) };
  const there = await query<{ liked_at: DbInstant }>('SELECT liked_at FROM song_likes WHERE user_id = $1 AND song_key = $2', [userId, songKey]);
  return { created: false, likedAt: there[0] ? new Date(there[0].liked_at) : at };
}

/** Removes the like of THAT person. IDEMPOTENT: true when it was there, false when it was not (never an error). */
export async function removeLike(userId: string, songKey: string): Promise<boolean> {
  const rows = await query<{ song_key: string }>('DELETE FROM song_likes WHERE user_id = $1 AND song_key = $2 RETURNING song_key', [userId, songKey]);
  return rows.length > 0;
}
