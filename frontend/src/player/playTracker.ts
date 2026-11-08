/**
 * Listening sessions of the web player (docs/mondrop-stats.md §1, D3).
 *
 * The tracker records RAW FACTS — how many milliseconds were really listened — and the server decides what
 * counts as a "play". Time accumulates only while the media is actually playing: a pause, buffering or a seek
 * adds nothing (and subtracts nothing: it is wall-clock time between "playing" and "not playing").
 *
 * One session = one song from start to end/switch. A session shorter than 3 s produces no event. The tracker
 * never throws into the player: every public method is safe to call from an event handler.
 */
import type { PlayEvent } from '../types';

/** Sessions shorter than this are not worth sending (contract §1). */
export const MIN_SESSION_MS = 3000;

export interface TrackedSong {
  songKey: string;
  playlistId: string | null;
  /** Known duration of the song, if any. */
  durationMs?: number | null;
}

export interface PlayTrackerOptions {
  onEvent: (event: PlayEvent) => void;
  now?: () => number;
  uuid?: () => string;
  /** Minutes EAST of UTC at the given instant. Default: -getTimezoneOffset() (note the sign). */
  tzOffsetMin?: (atMs: number) => number;
  minSessionMs?: number;
}

/** UUID v4: crypto.randomUUID where available, else a getRandomValues / Math.random fallback. */
export function newEventId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export const localTzOffsetMin = (atMs: number): number => -new Date(atMs).getTimezoneOffset();

interface Session {
  song: TrackedSong;
  durationMs: number | null;
  /** When playback first started in this session (becomes `startedAt`). */
  startedAtMs: number | null;
  listenedMs: number;
  /** Wall-clock instant the current playing stretch began; null while not playing. */
  playingSince: number | null;
}

export class PlayTracker {
  private readonly onEvent: (event: PlayEvent) => void;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly tz: (atMs: number) => number;
  private readonly minMs: number;
  private session: Session | null = null;

  constructor(opts: PlayTrackerOptions) {
    this.onEvent = opts.onEvent;
    this.now = opts.now ?? (() => Date.now());
    this.uuid = opts.uuid ?? newEventId;
    this.tz = opts.tzOffsetMin ?? localTzOffsetMin;
    this.minMs = opts.minSessionMs ?? MIN_SESSION_MS;
  }

  /** A new song (or the same one started over) is loaded: the previous session ends here. `null` = nothing loaded. */
  setSong(song: TrackedSong | null): void {
    this.close(false);
    this.session = song
      ? {
          song,
          durationMs: this.cleanDuration(song.durationMs),
          startedAtMs: null,
          listenedMs: 0,
          playingSince: null,
        }
      : null;
  }

  setDuration(ms: number | null | undefined): void {
    if (this.session) this.session.durationMs = this.cleanDuration(ms) ?? this.session.durationMs;
  }

  /** The media is playing (also called after buffering / a pause). Idempotent. */
  playing(): void {
    const s = this.session;
    if (!s || s.playingSince !== null) return;
    const t = this.now();
    s.playingSince = t;
    if (s.startedAtMs === null) s.startedAtMs = t;
  }

  /** Pause, buffering, error, anything that is not playing. Idempotent. */
  paused(): void {
    this.stopClock();
  }

  /** The song reached its end: the session closes as completed and a replay starts a NEW session. */
  ended(): void {
    this.close(true);
  }

  /** The page is going away: close whatever is running (the song stays loaded for a possible restore). */
  finish(): void {
    this.close(false);
  }

  /** Milliseconds listened so far in the running session (testing / UI). */
  listenedMs(): number {
    const s = this.session;
    if (!s) return 0;
    return s.listenedMs + (s.playingSince !== null ? this.now() - s.playingSince : 0);
  }

  private stopClock(): void {
    const s = this.session;
    if (!s || s.playingSince === null) return;
    s.listenedMs += Math.max(0, this.now() - s.playingSince);
    s.playingSince = null;
  }

  private cleanDuration(ms: number | null | undefined): number | null {
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
  }

  /** Ends the session: emits an event when it is long enough, then keeps the song loaded with a fresh idle session. */
  private close(completed: boolean): void {
    const s = this.session;
    if (!s) return;
    this.stopClock();
    const listenedMs = Math.round(s.listenedMs);
    if (s.startedAtMs !== null && listenedMs >= this.minMs) {
      try {
        this.onEvent({
          id: this.uuid(),
          songKey: s.song.songKey,
          startedAt: new Date(s.startedAtMs).toISOString(),
          tzOffsetMin: this.tz(s.startedAtMs),
          listenedMs,
          durationMs: s.durationMs,
          completed,
          origin: 'web',
          playlistId: s.song.playlistId,
        });
      } catch {
        /* a listener failing must never reach the player */
      }
    }
    this.session = { song: s.song, durationMs: s.durationMs, startedAtMs: null, listenedMs: 0, playingSince: null };
  }
}
