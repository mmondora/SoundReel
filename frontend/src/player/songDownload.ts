/**
 * First-play download of the web player (docs/mondrop-sync.md "Primo play").
 *
 * A song without a server-side MP3 starts playing at once through the YouTube fallback, and — in parallel —
 * the player asks the server to download it with priority `play`. The tracker then polls the state every few
 * seconds (bounded) and reports `ready` so the NEXT play can use the local file; it never interrupts the
 * playback that is running. One request per song per session (a failed REQUEST may be retried on the next play).
 */
import type { SongDownloadResponse, SongStateLocation, SongStateResponse } from '../types';

export type DownloadPhase = 'requesting' | 'downloading' | 'ready' | 'failed' | 'unavailable' | 'timeout';

export interface DownloadUiState {
  songKey: string;
  phase: DownloadPhase;
  /** Short reason for `failed` / `unavailable`. */
  error?: string;
  /** Where the file is once `ready`, when the server says (`GET /api/songs/:key/state` → `location`). */
  location?: SongStateLocation;
}

export interface DownloadTrackerDeps {
  request: (songKey: string) => Promise<SongDownloadResponse>;
  poll: (songKey: string) => Promise<SongStateResponse>;
  onChange: (state: DownloadUiState) => void;
  /** Poll period (default 5 s). */
  intervalMs?: number;
  /** Give up polling after this long (default 3 min). */
  maxMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DownloadTracker {
  start(songKey: string): void;
  stateOf(songKey: string): DownloadUiState | undefined;
  dispose(): void;
}

export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_POLL_MAX_MS = 180_000;

function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 120);
}

export function createDownloadTracker(deps: DownloadTrackerDeps): DownloadTracker {
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxMs = deps.maxMs ?? DEFAULT_POLL_MAX_MS;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => window.clearTimeout(h as number));

  const started = new Set<string>();
  const states = new Map<string, DownloadUiState>();
  const timers = new Map<string, unknown>();
  let disposed = false;

  function emit(state: DownloadUiState): void {
    if (disposed) return;
    states.set(state.songKey, state);
    deps.onChange(state);
  }

  function stopTimer(songKey: string): void {
    const handle = timers.get(songKey);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(songKey);
  }

  /** Maps a server state to a tracker state; `null` = still in progress, keep polling. */
  function terminal(
    songKey: string,
    state: SongStateResponse['state'],
    error?: string | null,
    location?: SongStateLocation,
  ): DownloadUiState | null {
    switch (state) {
      case 'ready':
        return location ? { songKey, phase: 'ready', location } : { songKey, phase: 'ready' };
      case 'failed':
        return { songKey, phase: 'failed', error: error ?? undefined };
      case 'no_source':
        return { songKey, phase: 'unavailable', error: error ?? undefined };
      default:
        return null;
    }
  }

  function schedule(songKey: string, startedAt: number): void {
    if (disposed) return;
    timers.set(
      songKey,
      setTimer(() => {
        timers.delete(songKey);
        void tick(songKey, startedAt);
      }, intervalMs),
    );
  }

  async function tick(songKey: string, startedAt: number): Promise<void> {
    if (disposed) return;
    try {
      const res = await deps.poll(songKey);
      const done = terminal(songKey, res.state, res.error, res.location);
      if (done) {
        emit(done);
        return;
      }
    } catch {
      // A failed poll is not a failed download: keep trying until the deadline.
    }
    if (now() - startedAt >= maxMs) {
      emit({ songKey, phase: 'timeout' });
      return;
    }
    schedule(songKey, startedAt);
  }

  return {
    start(songKey: string): void {
      if (disposed || started.has(songKey)) return;
      started.add(songKey);
      const startedAt = now();
      emit({ songKey, phase: 'requesting' });
      deps
        .request(songKey)
        .then((res) => {
          const done = terminal(songKey, res.state, (res.track as { error?: string | null } | undefined)?.error);
          if (done) {
            emit(done);
            return;
          }
          emit({ songKey, phase: 'downloading' });
          schedule(songKey, startedAt);
        })
        .catch((err: unknown) => {
          // The request itself failed (network, auth, 5xx): report it, and let the next play try again.
          started.delete(songKey);
          emit({ songKey, phase: 'failed', error: message(err) });
        });
    },

    stateOf(songKey: string): DownloadUiState | undefined {
      return states.get(songKey);
    },

    dispose(): void {
      disposed = true;
      for (const key of [...timers.keys()]) stopTimer(key);
    },
  };
}
