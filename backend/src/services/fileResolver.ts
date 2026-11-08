/**
 * "Reuse first": before a song is downloaded from YouTube, look for a file we already have.
 *   1. the music library on disk (Spooty's files and everything downloaded earlier)
 *   2. the media server's catalogue (`media_index`): the song simply IS that file — nothing is copied
 *      (spec 2026-11-07-web-player-ux-design.md W6, ADR-0010)
 * Only then does the download worker go to YouTube.
 */
import { getLibraryTracks } from './libraryCache';
import { findLibraryTrack } from './musicLibrary';
import { chooseIndexHit, lookupMediaIndex, type IndexHit } from './mediaIndex';
import { headMediaFile, mediaUrlForVolumePath, mediaVolumePresent } from './mediaServer';
import { absFromRel, fileFacts, MIN_MP3_BYTES, type FileFacts } from './musicStore';

export interface LibraryMatch {
  relPath: string;
  facts: FileFacts;
}

/** The library file backing a song, if there is one and it is really on disk. */
export async function findLibraryMatch(artist: string, title: string): Promise<LibraryMatch | null> {
  const track = findLibraryTrack(await getLibraryTracks(), artist, title);
  if (!track) return null;
  const abs = absFromRel(track.relPath);
  const facts = abs ? await fileFacts(abs) : null;
  return facts ? { relPath: track.relPath, facts } : null;
}

/** The file on the media server worth reusing for a song (never a live/bootleg cut, never junk). */
export async function findMediaServerMatch(artist: string, title: string): Promise<IndexHit | null> {
  return chooseIndexHit(await lookupMediaIndex(artist, title), { artist, title });
}

/** The box answers but its media volume is not there (the USB drive is unplugged): do not act on its 404s. */
export class MediaVolumeMissingError extends Error {
  constructor() {
    super('media server: volume non disponibile (chiavetta scollegata?)');
    this.name = 'MediaVolumeMissingError';
  }
}

export interface AdoptedFile {
  bytes: number;
  /** The box's own modification time (0 when it does not say): part of the file's version for the clients. */
  mtimeMs: number;
  durationS: number | null;
  original: { relPath: string; url: string };
}

/**
 * Take a file of the media server as the song's file, WITHOUT copying it. The box is asked once (HEAD) so the
 * size and date are real and a file that vanished since the last catalogue scan is not adopted. A box that
 * does not answer is trusted on its catalogue: that very box listed the file, and the periodic check of
 * published files re-verifies it (and turns the song back into a job if the file is gone).
 * A 404 is believed only when the rest of the volume answers: with the drive unplugged EVERY file is a 404, and
 * downloading the song again from YouTube would only create a duplicate for when the drive comes back
 * (MediaVolumeMissingError: the caller waits).
 */
export async function adoptMediaServerFile(
  hit: IndexHit,
  options: { head?: typeof headMediaFile; volumePresent?: () => Promise<boolean> } = {},
): Promise<AdoptedFile | null> {
  const url = mediaUrlForVolumePath(hit.relPath);
  const head = await (options.head ?? headMediaFile)(url);
  if (head.kind === 'missing') {
    if (!(await (options.volumePresent ?? mediaVolumePresent)())) throw new MediaVolumeMissingError();
    return null;
  }
  const bytes = head.kind === 'ok' ? (head.bytes ?? hit.bytes) : hit.bytes;
  if (!bytes || bytes < MIN_MP3_BYTES) return null;
  return {
    bytes,
    mtimeMs: head.kind === 'ok' ? (head.lastModifiedMs ?? 0) : 0,
    durationS: hit.durationS,
    original: { relPath: hit.relPath, url },
  };
}
