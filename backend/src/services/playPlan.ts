/**
 * What the WEB player plays for a song — decided by the SERVER (rule P, ADR-0018, spec 2026-11-08-mondrop-search-spotify-style-design.md
 * S11): `GET /api/songs/:songKey/play`. Until 2.14.1 the browser worked this out by itself (`GET /api/net`, the flags of the list,
 * `effectiveSource`); it was the same rule written on the wrong side. The browser now asks and FOLLOWS.
 *
 * Michele's rule (8 November): from the internet the song starts from YouTube, always; at home it starts from the file when
 * SoundReel has it, otherwise from YouTube in the meantime while the server prepares the file (the next plays use the file).
 * The «Sorgente» switch of the player stays as a PREFERENCE the browser sends (`prefer`): Auto lets the server decide by the
 * network of the request, Internet forces YouTube, Media server forces the home file when there is one.
 *
 * Pure: the route feeds it the facts (preference, network, where the song's file is).
 */
import type { NetworkKind } from '../utils/network';

export type SourceMode = 'auto' | 'internet' | 'media';
export const SOURCE_MODES: readonly SourceMode[] = ['auto', 'internet', 'media'];

/** What the switch comes down to once Auto is resolved. */
export type SourceChoice = 'internet' | 'media';

/** What a song is really played from: the media server, geekom's disk, or the YouTube fallback. */
export type PlayFrom = 'media-server' | 'disk' | 'youtube';

export interface SongPlace {
  /** The file is on geekom's disk. */
  fs: boolean;
  /** The file is on the home media server. */
  mediaServer: boolean;
}

export interface PlayPlan {
  /** The switch, resolved. */
  choice: SourceChoice;
  /** What this song will really play from. */
  from: PlayFrom;
  /**
   * The song is neither on geekom's disk nor on the media server: the server should fetch it (the client asks for it once,
   * `POST /api/songs/:key/download` with priority «play») while it plays from YouTube, whatever the switch says.
   */
  download: boolean;
}

/** The preference of the request; anything that is not a mode (a missing or a mistyped query) is Auto. */
export function parsePrefer(raw: unknown): SourceMode {
  return raw === 'internet' || raw === 'media' ? raw : 'auto';
}

/**
 * The switch with Auto resolved by the network of the request. A request whose network is not known counts as external: the
 * safe side, because it never loads the home line.
 */
export function choiceFor(prefer: SourceMode, network: NetworkKind | null | undefined): SourceChoice {
  if (prefer === 'internet') return 'internet';
  if (prefer === 'media') return 'media';
  return network === 'internal' ? 'media' : 'internet';
}

/** Where a song plays from, given the preference, the network of the request and where the song's file is. */
export function playPlan(prefer: SourceMode, network: NetworkKind | null | undefined, place: SongPlace): PlayPlan {
  const choice = choiceFor(prefer, network);
  const download = !place.fs && !place.mediaServer;
  let from: PlayFrom = 'youtube';
  if (choice === 'media') {
    // the media server first; geekom's disk when the Fritz does not have it yet; else YouTube
    if (place.mediaServer) from = 'media-server';
    else if (place.fs) from = 'disk';
  }
  return { choice, from, download };
}
