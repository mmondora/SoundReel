import { promises as fs } from 'fs';
import path from 'path';
import { listEntries } from '../utils/db';
import { listSongMeta, patchSongUserMeta } from './songMeta';
import { aggregateSongs, LIST_ENTRIES_LIMIT } from '../routes/songs';
import { logWarning } from '../utils/logger';

export interface LibraryTrack {
  artist: string;
  title: string;
  album: string | null;
}

/**
 * Recursively scans the mounted music share for .mp3 files and parses each
 * filename into an artist/title pair. Filenames follow `Artist - Title.mp3`;
 * only the FIRST ' - ' is treated as the artist/title separator so titles
 * that legitimately contain ' - ' (e.g. remix credits) are preserved intact.
 * A file with no ' - ' at all is treated as title-only (artist '').
 *
 * The immediate parent directory name is used as the album (playlists/albums
 * live one level under the library root); root-level files have album null.
 *
 * This is a feature-off-by-default integration: when MUSIC_LIBRARY_PATH is
 * unset, or the root is missing/unreadable (e.g. the share isn't mounted),
 * this logs a warning once per call and returns [] rather than throwing —
 * callers (syncDownloadedFlags) treat that as "nothing to sync".
 */
export async function scanLibrary(root?: string): Promise<LibraryTrack[]> {
  const libraryRoot = root ?? process.env.MUSIC_LIBRARY_PATH;
  if (!libraryRoot) {
    logWarning('scanLibrary: MUSIC_LIBRARY_PATH not set, music library sync is disabled');
    return [];
  }

  let relativePaths: string[];
  try {
    relativePaths = (await fs.readdir(libraryRoot, { recursive: true })) as string[];
  } catch (err) {
    logWarning('scanLibrary: music library root is missing or unreadable', {
      root: libraryRoot,
      err: String(err),
    });
    return [];
  }

  const tracks: LibraryTrack[] = [];
  for (const relPath of relativePaths) {
    if (!relPath.toLowerCase().endsWith('.mp3')) continue;

    const parts = relPath.split(path.sep);
    const filename = parts[parts.length - 1];
    const base = filename.slice(0, -'.mp3'.length);
    const album = parts.length > 1 ? parts[parts.length - 2] : null;

    const sepIdx = base.indexOf(' - ');
    const artist = sepIdx === -1 ? '' : base.slice(0, sepIdx).trim();
    const title = sepIdx === -1 ? base.trim() : base.slice(sepIdx + 3).trim();

    tracks.push({ artist, title, album });
  }

  return tracks;
}

/**
 * Lowercases, collapses internal whitespace and strips trailing "(...)" /
 * "[...]" groups repeatedly (e.g. 'Title (Live) [Remaster]' -> 'title'),
 * so DB titles carrying remaster/live suffixes still match plain library
 * filenames.
 */
export function normalizeForMatch(s: string): string {
  let result = s.toLowerCase().trim().replace(/\s+/g, ' ');

  let prev: string;
  do {
    prev = result;
    result = result.replace(/\s*[([][^()[\]]*[)\]]$/, '').trim();
  } while (result !== prev);

  return result;
}

/**
 * A song is considered present in the library when some track's title
 * matches (normalized) AND either artist is empty (unparsed filename, or
 * an unattributed DB mention) or the normalized artists contain one another
 * — handling multi-credit strings like 'Bedouin Burger, Zeid Hamdan' matching
 * a DB artist of just 'Bedouin Burger', in either direction.
 */
export function libraryHasSong(tracks: LibraryTrack[], artist: string, title: string): boolean {
  const wantTitle = normalizeForMatch(title);
  const wantArtist = normalizeForMatch(artist);

  return tracks.some((track) => {
    if (normalizeForMatch(track.title) !== wantTitle) return false;

    const trackArtist = normalizeForMatch(track.artist);
    if (trackArtist === '' || wantArtist === '') return true;

    return trackArtist.includes(wantArtist) || wantArtist.includes(trackArtist);
  });
}

/**
 * Scans the music share and marks every aggregated song already present on
 * disk as downloaded. Only flips false/unset -> true; never unsets a song
 * that was already marked downloaded by some other path.
 */
export async function syncDownloadedFlags(): Promise<{ scanned: number; matched: number; updated: number }> {
  const tracks = await scanLibrary();
  if (tracks.length === 0) {
    return { scanned: 0, matched: 0, updated: 0 };
  }

  const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listSongMeta()]);
  const songs = aggregateSongs(entries, metaMap);

  let matched = 0;
  let updated = 0;

  for (const song of songs.values()) {
    if (!libraryHasSong(tracks, song.artist, song.title)) continue;
    matched += 1;

    if (song.meta?.downloaded) continue;

    await patchSongUserMeta(song.songKey, { downloaded: true });
    updated += 1;
  }

  return { scanned: tracks.length, matched, updated };
}
