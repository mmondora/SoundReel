/**
 * The songs a user can see (every song mentioned in an entry they own or that is shared with them), joined
 * with their metadata. Aggregating the whole journal is not free, and a client waiting for a song polls every
 * couple of seconds, so the result is kept for a few seconds per user.
 */
import { listEntries } from '../utils/db';
import { listSongMeta } from './songMeta';
import { aggregateSongs, LIST_ENTRIES_LIMIT } from '../routes/songs';
import type { AggregatedSong } from '../types';

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; songs: Map<string, AggregatedSong> }>();

export async function getUserSongs(userId: string, isAdmin = false, maxAgeMs = TTL_MS): Promise<Map<string, AggregatedSong>> {
  const key = `${userId}|${isAdmin ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.songs;
  const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT, { userId, isAdmin }), listSongMeta()]);
  const songs = aggregateSongs(entries, metaMap);
  cache.set(key, { at: Date.now(), songs });
  return songs;
}

export function invalidateUserSongs(): void {
  cache.clear();
}
