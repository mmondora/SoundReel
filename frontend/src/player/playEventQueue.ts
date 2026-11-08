/**
 * Offline-safe outbox of listening events (docs/mondrop-stats.md §1, D2/D3).
 *
 *   - events are persisted in localStorage the moment they are enqueued;
 *   - a flush happens at 20 queued events, every 5 minutes, at start-up (what the last session left), and when
 *     the page is hidden / unloaded (those use `keepalive` so the request outlives the page);
 *   - an event leaves the queue ONLY after the server answered exactly 200 (the server is idempotent per id, so
 *     re-sending is safe); any other status, or a network error, keeps it for the next attempt;
 *   - failures back off (30 s … 5 min) for automatic flushes; page-hide flushes ignore the backoff;
 *   - nothing here ever throws into the player.
 */
import type { PlayEvent } from '../types';

export const PLAY_QUEUE_KEY = 'soundreel.plays.queue.v1';
export const FLUSH_AT = 20;
/** The server accepts at most 500 events per request. */
export const MAX_BATCH = 500;
/** keepalive request bodies are capped (~64 KB) by browsers: stay well under it. */
export const MAX_KEEPALIVE_BATCH = 100;
export const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
/** A device that stays offline for long must not fill localStorage: the oldest events go first. */
export const MAX_QUEUED = 2000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PlayEventQueueDeps {
  storage: StorageLike | null;
  /** Resolves with the HTTP status; rejects on a network error. */
  send: (events: PlayEvent[], opts: { keepalive: boolean }) => Promise<number>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  flushAt?: number;
  intervalMs?: number;
  maxBatch?: number;
  maxQueued?: number;
  onError?: (err: unknown) => void;
}

export interface FlushOptions {
  /** The page is going away: one request that outlives it, ignoring the backoff. */
  keepalive?: boolean;
  /** Ignore the backoff (an explicit attempt). */
  force?: boolean;
}

function isEvent(value: unknown): value is PlayEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.songKey === 'string' &&
    typeof v.startedAt === 'string' &&
    typeof v.listenedMs === 'number' &&
    typeof v.tzOffsetMin === 'number'
  );
}

export class PlayEventQueue {
  private queue: PlayEvent[] = [];
  private readonly d: Required<Pick<PlayEventQueueDeps, 'flushAt' | 'intervalMs' | 'maxBatch' | 'maxQueued'>> & PlayEventQueueDeps;
  private readonly now: () => number;
  private inFlight: Promise<void> | null = null;
  private rerun: FlushOptions | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private timer: unknown = null;

  constructor(deps: PlayEventQueueDeps) {
    this.d = {
      ...deps,
      flushAt: deps.flushAt ?? FLUSH_AT,
      intervalMs: deps.intervalMs ?? FLUSH_INTERVAL_MS,
      maxBatch: Math.min(deps.maxBatch ?? MAX_BATCH, MAX_BATCH),
      maxQueued: deps.maxQueued ?? MAX_QUEUED,
    };
    this.now = deps.now ?? (() => Date.now());
    this.queue = this.load();
  }

  size(): number {
    return this.queue.length;
  }

  snapshot(): PlayEvent[] {
    return [...this.queue];
  }

  enqueue(event: PlayEvent): void {
    if (this.queue.some((e) => e.id === event.id)) return;
    this.queue.push(event);
    if (this.queue.length > this.d.maxQueued) this.queue.splice(0, this.queue.length - this.d.maxQueued);
    this.persist();
    if (this.queue.length >= this.d.flushAt) void this.flush();
  }

  /** Starts the 5-minute timer and sends whatever the previous session left behind. */
  start(): void {
    if (this.timer !== null) return;
    const set = this.d.setTimer ?? ((fn, ms) => window.setInterval(fn, ms));
    this.timer = set(() => { void this.flush(); }, this.d.intervalMs);
    void this.flush();
  }

  stop(): void {
    if (this.timer === null) return;
    const clear = this.d.clearTimer ?? ((h) => window.clearInterval(h as number));
    clear(this.timer);
    this.timer = null;
  }

  /**
   * Sends what is queued. Never rejects. Concurrent calls share the request that is already running; if one
   * arrives while it is finishing, the queue is flushed once more afterwards (so a trigger is never swallowed).
   */
  flush(opts: FlushOptions = {}): Promise<void> {
    if (this.inFlight) {
      this.rerun = {
        keepalive: this.rerun?.keepalive === true || opts.keepalive === true,
        force: this.rerun?.force === true || opts.force === true,
      };
      return this.inFlight;
    }
    const run = this.run(opts).finally(() => {
      this.inFlight = null;
      const again = this.rerun;
      this.rerun = null;
      if (again && this.queue.length > 0) void this.flush(again);
    });
    this.inFlight = run;
    return run;
  }

  private async run(opts: FlushOptions): Promise<void> {
    const keepalive = opts.keepalive === true;
    const force = keepalive || opts.force === true;
    if (!force && this.now() < this.nextAttemptAt) return;
    const cap = keepalive ? Math.min(this.d.maxBatch, MAX_KEEPALIVE_BATCH) : this.d.maxBatch;

    for (let round = 0; round < 50; round += 1) {
      if (this.queue.length === 0) return;
      const batch = this.queue.slice(0, cap);
      let status: number;
      try {
        status = await this.d.send(batch, { keepalive });
      } catch (err) {
        this.fail(err);
        return;
      }
      // Only an explicit 200 acknowledges the events; everything else keeps them for the next attempt.
      if (status !== 200) {
        this.fail(new Error(`HTTP ${status}`));
        return;
      }
      const sent = new Set(batch.map((e) => e.id));
      this.queue = this.queue.filter((e) => !sent.has(e.id));
      this.persist();
      this.failures = 0;
      this.nextAttemptAt = 0;
      if (keepalive) return; // the page gets one request
    }
  }

  private fail(err: unknown): void {
    this.failures += 1;
    this.nextAttemptAt = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
    try {
      this.d.onError?.(err);
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    try {
      this.d.storage?.setItem(PLAY_QUEUE_KEY, JSON.stringify(this.queue));
    } catch {
      /* quota / private mode: the in-memory queue still works for this session */
    }
  }

  private load(): PlayEvent[] {
    try {
      const raw = this.d.storage?.getItem(PLAY_QUEUE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const seen = new Set<string>();
      const valid = parsed.filter((e): e is PlayEvent => isEvent(e) && !seen.has(e.id) && !!seen.add(e.id));
      return valid.slice(-this.d.maxQueued);
    } catch {
      return [];
    }
  }
}

/** localStorage when it is usable (it throws in some private modes), else null. */
export function safeLocalStorage(): StorageLike | null {
  try {
    const s = window.localStorage;
    s.getItem(PLAY_QUEUE_KEY);
    return s;
  } catch {
    return null;
  }
}
