/**
 * Where the web player takes a song from — the "Sorgente" switch (rules W5–W7; decisions S1–S6 of
 * docs/superpowers/specs/2026-11-07-web-player-ux-design.md).
 *
 *   - Auto (default): on the home network the media server, from the internet Internet (YouTube).
 *   - Internet: always the YouTube fallback (video in the picture box, no load on the home bandwidth).
 *   - Media server: the file at home through the backend (`/api/songs/:key/file`: the Fritz first, geekom's disk if
 *     the file is not on the Fritz yet); a song that is on neither plays from Internet.
 *
 * The parallel download (W1) does not depend on the switch: it is due whenever the song is on neither FS nor MS.
 * Everything here is pure; the player context feeds it the facts (mode, network, location).
 */
import type { NetworkKind, SongLocation } from '../types';

export type SourceMode = 'auto' | 'internet' | 'media';
export const SOURCE_MODES: readonly SourceMode[] = ['auto', 'internet', 'media'];
export const DEFAULT_SOURCE_MODE: SourceMode = 'auto';

/** What the switch comes down to once Auto is resolved. */
export type SourceChoice = 'internet' | 'media';

/** What a song is really played from: the media server, geekom's disk, or the YouTube fallback. */
export type PlayFrom = 'media-server' | 'disk' | 'youtube';

/**
 * The switch with Auto resolved by the network. A network that is not known (the request is still running, or
 * `GET /api/net` failed) counts as external: the safe side, because it never loads the home line (S5).
 */
export function sourceChoiceFor(mode: SourceMode, network: NetworkKind | null | undefined): SourceChoice {
  if (mode === 'internet') return 'internet';
  if (mode === 'media') return 'media';
  return network === 'internal' ? 'media' : 'internet';
}

export interface SourcePlan {
  /** The switch, resolved. */
  choice: SourceChoice;
  /** What this song will really play from. */
  from: PlayFrom;
  /**
   * The song is neither on FS nor on the media server, so the server should fetch it (priority "play") while it
   * plays from Internet, whatever the switch says (S6). The caller adds "once per song per session" and
   * "only when the server positively said there is no file".
   */
  download: boolean;
}

/** Where a song plays from, given the switch, the network and where the song's file is. */
export function effectiveSource(
  mode: SourceMode,
  network: NetworkKind | null | undefined,
  location: SongLocation,
): SourcePlan {
  const choice = sourceChoiceFor(mode, network);
  const download = !location.fs && !location.mediaServer;
  let from: PlayFrom = 'youtube';
  if (choice === 'media') {
    // S4: the media server first; the disk of geekom when the Fritz does not have it yet; else Internet.
    if (location.mediaServer) from = 'media-server';
    else if (location.fs) from = 'disk';
  }
  return { choice, from, download };
}

/** True when the song plays from a file at home (and not from the YouTube fallback). */
export const playsFromHome = (from: PlayFrom | null): boolean => from === 'media-server' || from === 'disk';

// ---------------------------------------------------------------------------
// The manual choice is remembered by this browser only (S5); Auto is worked out again at every page load.
// ---------------------------------------------------------------------------

export const SOURCE_MODE_STORAGE_KEY = 'soundreel.player.sourceMode.v1';

export function parseSourceMode(raw: unknown): SourceMode {
  return raw === 'internet' || raw === 'media' ? raw : DEFAULT_SOURCE_MODE;
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/** The remembered mode; storage that is missing or throws (private mode, blocked site data) means Auto. */
export function loadSourceMode(storage?: ReadableStorage | null): SourceMode {
  try {
    const s = storage === undefined ? window.localStorage : storage;
    return parseSourceMode(s?.getItem(SOURCE_MODE_STORAGE_KEY));
  } catch {
    return DEFAULT_SOURCE_MODE;
  }
}

export function saveSourceMode(mode: SourceMode, storage?: WritableStorage | null): void {
  try {
    const s = storage === undefined ? window.localStorage : storage;
    s?.setItem(SOURCE_MODE_STORAGE_KEY, mode);
  } catch {
    // The choice then only lasts until the page is closed.
  }
}
