/**
 * One shared, short-lived snapshot of the music library scan, so listing songs, building a playlist
 * manifest and the download worker do not each walk /music again. Anything that writes into the library
 * (a finished download) calls `invalidateLibraryTracks()` so the new file shows up at once.
 */
import { scanLibrary, type LibraryTrack } from './musicLibrary';

let cached: LibraryTrack[] | null = null;
let cachedAt = 0;
let inflight: Promise<LibraryTrack[]> | null = null;

export async function getLibraryTracks(maxAgeMs = 60_000): Promise<LibraryTrack[]> {
  if (cached && Date.now() - cachedAt < maxAgeMs) return cached;
  // Concurrent callers (a manifest + the worker) share one directory walk.
  inflight ??= scanLibrary()
    .then((tracks) => {
      cached = tracks;
      cachedAt = Date.now();
      return tracks;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidateLibraryTracks(): void {
  cached = null;
  cachedAt = 0;
}
