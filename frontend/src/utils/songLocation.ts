/**
 * Where a song's file lives (D10, docs/mondrop-stats.md §6): FS = geekom's disk, MS = the media server (Fritz),
 * both possible, neither = streaming only (YouTube). The badge text is FS, MS or FS+MS; no badge = streaming only.
 */
import type { AggregatedSong, SongLocation, SongPlace, SongStateLocation, SongStateResponse } from '../types';
import type { DownloadUiState } from '../player/songDownload';

export type LocationBadgeKind = 'FS' | 'MS' | 'FS+MS';

type LocatedSong = Pick<AggregatedSong, 'fs' | 'mediaServer' | 'inLibrary'>;

/**
 * Backend flags win; an old backend sends none of them, and then `inLibrary` (a file in the music library)
 * means FS. `override` is what this session learned (a first-play download that finished): it replaces only
 * the parts it knows.
 */
export function resolveSongLocation(song: LocatedSong, override?: Partial<SongLocation> | null): SongLocation {
  const base: SongLocation = {
    fs: song.fs ?? song.inLibrary ?? false,
    mediaServer: song.mediaServer ?? false,
  };
  if (!override) return base;
  return { fs: override.fs ?? base.fs, mediaServer: override.mediaServer ?? base.mediaServer };
}

export function locationBadge(loc: SongLocation): LocationBadgeKind | null {
  if (loc.fs && loc.mediaServer) return 'FS+MS';
  if (loc.fs) return 'FS';
  if (loc.mediaServer) return 'MS';
  return null;
}

/**
 * A finished first-play download means the file is on geekom's disk (FS) for sure; MS only if the server says so.
 * The addresses (rule W8) come along when the server sent them.
 */
export function locationOverridesFrom(
  states: Readonly<Record<string, DownloadUiState>>,
): Record<string, Partial<SongStateLocation>> {
  const out: Record<string, Partial<SongStateLocation>> = {};
  for (const [key, state] of Object.entries(states)) {
    if (state.phase !== 'ready') continue;
    const loc = state.location;
    out[key] = {
      fs: loc?.fs ?? true,
      ...(loc ? { mediaServer: loc.mediaServer } : {}),
      ...(loc?.fsPath != null ? { fsPath: loc.fsPath } : {}),
      ...(loc?.mediaUrl != null ? { mediaUrl: loc.mediaUrl } : {}),
      ...(loc?.streamUrl != null ? { streamUrl: loc.streamUrl } : {}),
    };
  }
  return out;
}

/** Convenience: the location of a song given the session's finished downloads. */
export function songLocationIn(
  song: LocatedSong & Pick<AggregatedSong, 'songKey'>,
  overrides: Readonly<Record<string, Partial<SongLocation>>>,
): SongLocation {
  return resolveSongLocation(song, overrides[song.songKey]);
}

/** Is the file on FS or on the media server? The only thing the green dot means (rule S8). */
export const isAtHome = (loc: SongLocation): boolean => loc.fs || loc.mediaServer;

/**
 * Location plus addresses (rule W8). An address is only shown for a place the song really is at: a path with
 * `fs` false (a stale value) must not look like the file is there.
 */
export function resolveSongPlace(
  song: LocatedSong & Pick<AggregatedSong, 'fsPath' | 'mediaUrl'>,
  override?: Partial<SongStateLocation> | null,
): SongPlace {
  const loc = resolveSongLocation(song, override);
  return {
    ...loc,
    fsPath: loc.fs ? (override?.fsPath ?? song.fsPath ?? null) : null,
    mediaUrl: loc.mediaServer ? (override?.mediaUrl ?? song.mediaUrl ?? null) : null,
    streamUrl: override?.streamUrl ?? null,
  };
}

/** What `GET /api/songs/:key/state` says about where the file is; an old backend only has `inLibrary` (= FS). */
export function locationFromState(res: Pick<SongStateResponse, 'inLibrary' | 'location'>): SongStateLocation {
  return res.location ?? { fs: res.inLibrary === true, mediaServer: false };
}

export interface YoutubeLink {
  url: string;
  /** true = a known video (watch URL); false = a search page, because no video is known yet. */
  exact: boolean;
}

/** The YouTube address of a song: the known video when there is one, else a search link (never the Data API). */
export function youtubeLink(
  song: Pick<AggregatedSong, 'artist' | 'title' | 'youtubeUrl'>,
  streamUrl?: string | null,
): YoutubeLink {
  const known = streamUrl?.trim() || song.youtubeUrl?.trim();
  if (known) return { url: known, exact: true };
  const query = `${song.artist} ${song.title}`.trim();
  return { url: `https://youtube.com/results?search_query=${encodeURIComponent(query)}`, exact: false };
}
