/**
 * Songs that exist only as FILES (ADR-0018): Bassi Maestro's 32 albums tracks on the box, the 10 in geekom's library, none
 * of them ever saved from a post. The journal does not know them, but they can be found, played, downloaded and put in a
 * playlist like any other song.
 *
 * Two sources, both read-only, both already held in memory by the library search (ADR-0011):
 *   - geekom's music library (the built-in folder: an extra folder is mounted read-only elsewhere and cannot be served),
 *   - the box's catalogue (`media_index`).
 * The identity of a song is its `songKey`, the same key as playlists, `song_files` and `song_meta`, so a file and a journal
 * song with the same artist and title (case and spaces aside) are ONE song.
 *
 * A library-only song has no post, no mentions, no metadata. The server serves it ONLY if its file exists, and never
 * downloads it from YouTube (`libraryOnly` tells `ensurePrepared` to leave it alone).
 */
import type { AggregatedSong } from '../types';
import { getLocalFiles, type LocalFile } from './musicFolders';
import { getMediaSnapshot, type MediaFile } from './musicSnapshot';
import { songKey } from './songMeta';

export interface LibraryEntry {
  songKey: string;
  artist: string;
  title: string;
  album: string | null;
  /** The file on geekom's disk, if there is one. */
  local: LocalFile | null;
  /** The file on the box, if there is one. */
  media: MediaFile | null;
}

const TTL_MS = 30_000;
let cache: { at: number; byKey: Map<string, LibraryEntry>; all: LibraryEntry[] } | null = null;

/** Every song that is a file of geekom's library or of the box, one entry each (the two sources joined by name). */
export async function libraryEntries(maxAgeMs = TTL_MS): Promise<{ byKey: Map<string, LibraryEntry>; all: LibraryEntry[] }> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache;
  // The identity is the song KEY (the key of playlists, files and metadata), not a loose match: «S.I.C.» and
  // «S.I.C. (2019 Remastered)» are two songs, as they are everywhere else (ADR-0017, D5).
  const byKeyMap = new Map<string, LibraryEntry>();
  const join = (artist: string, title: string, part: { local?: LocalFile; media?: MediaFile }): void => {
    const key = songKey(artist, title);
    const known = byKeyMap.get(key);
    if (!known) {
      byKeyMap.set(key, { songKey: key, artist, title, album: null, local: part.local ?? null, media: part.media ?? null });
      return;
    }
    if (part.local && !known.local) known.local = part.local;
    // of several files of the box for one song, the one that carries a real album tag says which album it is on
    if (part.media && (!known.media || (!known.media.album && part.media.album))) known.media = part.media;
  };
  // geekom first: when a song is on both, its key (and spelling) is the one of the file we can serve from disk
  for (const f of getLocalFiles()) if (f.builtIn) join(f.artist, f.title, { local: f });
  for (const f of (await getMediaSnapshot()).files) join(f.artist, f.title, { media: f });
  // The album: the box's TAG when it has one. A folder of geekom's library is a Spooty playlist name («Bassi Maestro»),
  // not an album, so it is only the fallback.
  for (const e of byKeyMap.values()) e.album = e.media?.album || e.local?.album || null;
  const all = [...byKeyMap.values()];
  cache = { at: Date.now(), byKey: byKeyMap, all };
  return cache;
}

export function invalidateLibraryEntries(): void {
  cache = null;
}

/** A song as the rest of the server knows songs, rebuilt from a file. It has no mentions and no metadata. */
export function songFromEntry(e: LibraryEntry): AggregatedSong {
  return {
    songKey: e.songKey,
    title: e.title,
    artist: e.artist,
    album: e.album,
    youtubeUrl: null,
    spotifyUrl: null,
    mentions: [],
    meta: null,
    inLibrary: true,
    fs: e.local !== null,
    mediaServer: e.media !== null,
    libraryOnly: true,
  };
}

/** The library-only song behind this key, or undefined when no file of the library or the box carries it. */
export async function libraryOnlySong(key: string): Promise<AggregatedSong | undefined> {
  const entry = (await libraryEntries()).byKey.get(key);
  return entry ? songFromEntry(entry) : undefined;
}

/**
 * The EXACT files behind a library-only song: the one on geekom's disk and/or the one on the box, as they were listed.
 * Serving a library-only song goes through this and never through a loose name match, which strips «(2019 Remastered)»
 * and would play one version's file for another's row.
 */
export async function libraryFilesOf(key: string): Promise<{ local: LocalFile | null; media: MediaFile | null } | undefined> {
  const entry = (await libraryEntries()).byKey.get(key);
  return entry ? { local: entry.local, media: entry.media } : undefined;
}
