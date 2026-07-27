import { getEntry, updateEntry } from '../utils/db';
import { songKey } from './songMeta';
import type { Song } from '../types';
import type { ResolvedSong } from './songResolver';

/**
 * Maps resolved music-list songs to the Song shape stored on an entry's
 * results.songs. These songs were never matched against audio fingerprinting
 * or AI analysis, so they get their own source tag and no album/playlist data.
 */
export function resolvedToSongs(resolved: ResolvedSong[]): Song[] {
  return resolved.map((r) => ({
    title: r.title,
    artist: r.artist,
    album: null,
    source: 'music_list',
    spotifyUri: r.spotifyUri,
    spotifyUrl: r.spotifyUrl,
    youtubeUrl: r.youtubeUrl,
    soundcloudUrl: null,
    addedToPlaylist: false,
  }));
}

/**
 * Re-reads the entry at write time (rather than trusting a caller-held copy)
 * so a concurrent update to results.songs elsewhere in the pipeline isn't
 * clobbered, then dedupes the incoming songs against what's already stored
 * (by songKey) and appends the rest via a partial results.songs update.
 *
 * Throws on db errors (getEntry/updateEntry) — callers are expected to
 * catch and log, same as every other independent pipeline step.
 */
export async function appendSongsToEntry(entryId: string, songs: Song[]): Promise<number> {
  if (!songs.length) return 0;

  const entry = await getEntry(entryId);
  if (!entry) {
    throw new Error(`appendSongsToEntry: entry not found (${entryId})`);
  }

  const existingSongs: Song[] = Array.isArray(entry.results?.songs) ? entry.results.songs : [];
  const existingKeys = new Set(existingSongs.map((s) => songKey(s.artist, s.title)));

  const toAppend: Song[] = [];
  const seen = new Set<string>();
  for (const song of songs) {
    const key = songKey(song.artist, song.title);
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    toAppend.push(song);
  }

  if (!toAppend.length) return 0;

  await updateEntry(entryId, { 'results.songs': [...existingSongs, ...toAppend] });
  return toAppend.length;
}
