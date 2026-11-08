/**
 * The "Sorgente" switch of the web player (rules W5–W7; decisions S1–S6 of
 * docs/superpowers/specs/2026-11-07-web-player-ux-design.md), as a PREFERENCE only.
 *
 * Where a song plays from is decided by the SERVER (rule P, ADR-0018: `GET /api/songs/:key/play?prefer=…`). The browser
 * sends this preference and follows the answer; it makes no network test and no source choice of its own:
 *
 *   - Auto (default): the server looks at the network of the request. From the internet the YouTube video, always; at home
 *     the file when SoundReel has it, else the video meanwhile (the server prepares the file for the next plays).
 *   - Internet: always the YouTube video (no load on the home bandwidth).
 *   - Media server: the file at home through the backend (`/api/songs/:key/file`: the Fritz first, geekom's disk if the
 *     file is not on the Fritz yet); a song that is on neither plays from the video.
 *
 * What is left here is the vocabulary, the preference remembered by this browser and `playsFromHome`.
 */

export type SourceMode = 'auto' | 'internet' | 'media';
export const SOURCE_MODES: readonly SourceMode[] = ['auto', 'internet', 'media'];
export const DEFAULT_SOURCE_MODE: SourceMode = 'auto';

/** What the switch comes down to once the server has resolved Auto (`choice` of the play plan). */
export type SourceChoice = 'internet' | 'media';

/** What a song is really played from: the media server, geekom's disk, or the YouTube fallback. */
export type PlayFrom = 'media-server' | 'disk' | 'youtube';

/** True when the song plays from a file at home (and not from the YouTube fallback). */
export const playsFromHome = (from: PlayFrom | null): boolean => from === 'media-server' || from === 'disk';

// ---------------------------------------------------------------------------
// The manual choice is remembered by this browser only (S5); Auto is worked out again at every song, by the server.
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
