/**
 * Where a song is, as plain facts (spec W2/W8, ADR-0010): on geekom's disk (`fs`), on the media server
 * (`mediaServer`), and the path / URL of each, so the web can show them and the green dot can mean exactly
 * "on the file system or on the media server". One bulk call serves a whole song list: a single query on
 * `song_files`, the cached library scan and the in-memory catalogue of the box — never a query per song.
 */
import { chooseIndexHit, normKey, type IndexHit } from './mediaIndex';
import { mediaUrlForVolumePath, volumePathFromUrl } from './mediaServer';
import { libraryDisplayRoot } from './musicFolders';
import { findLibraryTrack, type LibraryTrack } from './musicLibrary';
import { getMediaSnapshot, type MediaSnapshot } from './musicSnapshot';
import { listSongFileLocations, type SongFileLocationRow } from './songFiles';

export interface SongLocation {
  /** A file on geekom's disk (Spooty's library, or our own store). */
  fs: boolean;
  /** A file on the media server: the box's own file, a verified replica of ours, or a catalogue entry. */
  mediaServer: boolean;
  /** Display path of the disk file (`~/Music/…`). */
  fsPath: string | null;
  /** Direct URL of the file on the media server. */
  mediaUrl: string | null;
  /** The same file's path on the box's volume. */
  mediaPath: string | null;
  /** YouTube watch URL when the song's video is known. */
  streamUrl: string | null;
}

export interface LocateInput {
  songKey: string;
  artist: string;
  title: string;
}

export interface LocateDeps {
  rows?: Map<string, SongFileLocationRow>;
  media?: MediaSnapshot;
  displayRoot?: string;
}

const asIndexHits = (media: MediaSnapshot, artist: string, title: string): IndexHit[] =>
  (media.byNormKey.get(normKey(artist, title)) ?? []).map((f) => ({ store: 'fritz', durationS: null, ...f }));

export async function locateSongs(
  songs: Iterable<LocateInput>,
  tracks: LibraryTrack[],
  deps: LocateDeps = {},
): Promise<Map<string, SongLocation>> {
  const [rows, media] = await Promise.all([deps.rows ?? listSongFileLocations(), deps.media ?? getMediaSnapshot()]);
  const root = deps.displayRoot ?? libraryDisplayRoot();
  const out = new Map<string, SongLocation>();

  for (const song of songs) {
    const row = rows.get(song.songKey);
    const ready = row?.status === 'ready';

    // disk: the file recorded for the song, else a library file with the same artist and title
    let fsRel: string | null = ready && row?.relPath ? row.relPath : null;
    if (!fsRel) fsRel = findLibraryTrack(tracks, song.artist, song.title)?.relPath ?? null;

    // media server: the box's own file (adopted), our replica once verified there, else the box's catalogue
    let mediaPath: string | null = null;
    let mediaUrl: string | null = null;
    if (ready && row?.mediaRelPath) {
      mediaPath = row.mediaRelPath;
      mediaUrl = row.mediaUrl ?? mediaUrlForVolumePath(mediaPath);
    } else if (ready && row?.mediaUrl) {
      mediaUrl = row.mediaUrl;
      mediaPath = volumePathFromUrl(row.mediaUrl);
    } else {
      const hit = chooseIndexHit(asIndexHits(media, song.artist, song.title), { artist: song.artist, title: song.title });
      if (hit) {
        mediaPath = hit.relPath;
        mediaUrl = mediaUrlForVolumePath(hit.relPath);
      }
    }

    out.set(song.songKey, {
      fs: fsRel !== null,
      mediaServer: mediaUrl !== null,
      fsPath: fsRel !== null ? `${root}/${fsRel}` : null,
      mediaUrl,
      mediaPath,
      streamUrl: row?.videoId ? `https://www.youtube.com/watch?v=${row.videoId}` : null,
    });
  }
  return out;
}
