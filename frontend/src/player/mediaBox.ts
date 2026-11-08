/**
 * The picture box at the top of the web player (rule W4, docs/superpowers/specs/2026-11-07-web-player-ux-design.md).
 *
 *   - the song plays FROM THE VIDEO (the YouTube fallback) → the video is shown in the box, in place of the photo;
 *   - the song plays from the LOCAL FILE (geekom's disk or the media server: audio streamed from the server) →
 *     the box shows the album cover;
 *   - the video cannot start / the embed is blocked → back to the cover;
 *   - when the first-play download finishes the song in progress is NOT switched (rule W1): what decides the
 *     box is what is actually playing, never what the server could play next time.
 *
 * Pure: the player context reports facts as events, the reducer keeps them per song, `chooseMediaBox` decides.
 */

import type { PlayFrom } from './playbackSource';

/** What the current song is really being played from. */
export type PlaybackSource = 'local' | 'video';
export type MediaBoxMode = 'video' | 'cover';

export interface MediaState {
  /** The song these facts belong to. */
  songKey: string | null;
  /** null until it is known (the player is still deciding between the file and the video). */
  source: PlaybackSource | null;
  /** Which source exactly (media server, geekom's disk, YouTube) — what the player badge says (rule W5). */
  from: PlayFrom | null;
  /** The video could not start (no video found, embed blocked, player error). */
  videoFailed: boolean;
}

export const INITIAL_MEDIA_STATE: MediaState = { songKey: null, source: null, from: null, videoFailed: false };

export type MediaEvent =
  /** A song is loaded (or started over): nothing is known about it yet. */
  | { type: 'songChanged'; songKey: string }
  /** The home file is playing: from the media server or from geekom's disk (both come through the backend). */
  | { type: 'localStarted'; songKey: string; from: Exclude<PlayFrom, 'youtube'> }
  /** The player went for the YouTube video. */
  | { type: 'videoRequested'; songKey: string }
  /** No video id, the embed is blocked, the player errored. */
  | { type: 'videoFailed'; songKey: string }
  /** The first-play download finished: for the song in progress this changes NOTHING (W1). */
  | { type: 'downloadReady'; songKey: string };

export function mediaReducer(state: MediaState, event: MediaEvent): MediaState {
  if (event.type === 'songChanged') return { songKey: event.songKey, source: null, from: null, videoFailed: false };

  // A late report about a song that is no longer the current one must not touch the current one.
  if (event.songKey !== state.songKey) return state;

  switch (event.type) {
    case 'localStarted':
      return { ...state, source: 'local', from: event.from, videoFailed: false };
    case 'videoRequested':
      return { ...state, source: 'video', from: 'youtube', videoFailed: false };
    case 'videoFailed':
      return { ...state, source: 'video', from: 'youtube', videoFailed: true };
    case 'downloadReady':
      return state;
  }
}

/** Video only while the song really plays from the video and the video works; the cover in every other case. */
export function chooseMediaBox(state: MediaState): MediaBoxMode {
  return state.source === 'video' && !state.videoFailed ? 'video' : 'cover';
}

/**
 * What the player badge says: where the song is really playing from. Nothing while it is still being decided, and
 * nothing when the video failed (then it plays from nowhere).
 */
export function playingFrom(state: MediaState): PlayFrom | null {
  return state.videoFailed ? null : state.from;
}

/**
 * Cover candidates in order: the song's own cover (`song_meta.cover_url`: Deezer/iTunes lookup, Shazam, Spotify),
 * then the thumbnail of the entry that mentions it. The box falls back to a neutral placeholder after the last one,
 * so it is never empty (and never changes size).
 */
export function coverCandidates(coverUrl: string | null | undefined, entryThumbnailUrl: string | null | undefined): string[] {
  const out: string[] = [];
  for (const url of [coverUrl, entryThumbnailUrl]) {
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** The cover to show given the candidates that already failed to load (null = the neutral placeholder). */
export function pickCover(candidates: readonly string[], failed: ReadonlySet<string>): string | null {
  return candidates.find((url) => !failed.has(url)) ?? null;
}
