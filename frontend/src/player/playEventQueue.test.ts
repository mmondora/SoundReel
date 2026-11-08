import { describe, expect, it, vi } from 'vitest';
import {
  FLUSH_AT,
  FLUSH_INTERVAL_MS,
  MAX_BATCH,
  MAX_KEEPALIVE_BATCH,
  MAX_QUEUED,
  PLAY_QUEUE_KEY,
  PlayEventQueue,
} from './playEventQueue';
import type { PlayEventQueueDeps, StorageLike } from './playEventQueue';
import type { PlayEvent } from '../types';

const ev = (n: number): PlayEvent => ({
  id: `e${n}`, songKey: `a::s${n}`, startedAt: '2026-11-08T06:00:00.000Z', tzOffsetMin: 60,
  listenedMs: 30_000, durationMs: 200_000, completed: false, origin: 'web', playlistId: null,
});

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

function harness(over: Partial<PlayEventQueueDeps> = {}, status: number | Error | ((events: PlayEvent[]) => number | Error) = 200) {
  let time = 1_000_000;
  const storage = memoryStorage();
  const sent: Array<{ ids: string[]; keepalive: boolean }> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const send = vi.fn(async (events: PlayEvent[], opts: { keepalive: boolean }) => {
    sent.push({ ids: events.map((e) => e.id), keepalive: opts.keepalive });
    const r = typeof status === 'function' ? status(events) : status;
    if (r instanceof Error) throw r;
    return r;
  });
  const queue = new PlayEventQueue({
    storage, send, now: () => time,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    ...over,
  });
  return { queue, storage, send, sent, timers, advance: (ms: number) => { time += ms; } };
}

const stored = (storage: { data: Record<string, string> }): PlayEvent[] => JSON.parse(storage.data[PLAY_QUEUE_KEY] ?? '[]') as PlayEvent[];

describe('PlayEventQueue: persistence', () => {
  it('writes every event to storage the moment it is queued and restores it in a new session', () => {
    const h = harness();
    h.queue.enqueue(ev(1));
    h.queue.enqueue(ev(2));
    expect(stored(h.storage).map((e) => e.id)).toEqual(['e1', 'e2']);

    const again = new PlayEventQueue({ storage: h.storage, send: h.send });
    expect(again.snapshot().map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('survives a broken or hostile storage', () => {
    const bad = memoryStorage({ [PLAY_QUEUE_KEY]: '{not json' });
    expect(new PlayEventQueue({ storage: bad, send: vi.fn() }).size()).toBe(0);
    const notArray = memoryStorage({ [PLAY_QUEUE_KEY]: '{"a":1}' });
    expect(new PlayEventQueue({ storage: notArray, send: vi.fn() }).size()).toBe(0);
    const mixed = memoryStorage({ [PLAY_QUEUE_KEY]: JSON.stringify([ev(1), { id: 5 }, null, 'x', ev(1), ev(2)]) });
    expect(new PlayEventQueue({ storage: mixed, send: vi.fn() }).snapshot().map((e) => e.id)).toEqual(['e1', 'e2']);
    const throwing: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    const q = new PlayEventQueue({ storage: throwing, send: vi.fn() });
    expect(() => q.enqueue(ev(1))).not.toThrow();
    expect(q.size()).toBe(1);
    expect(new PlayEventQueue({ storage: null, send: vi.fn() }).size()).toBe(0);
  });

  it('ignores a duplicate id and drops the OLDEST events past the cap', () => {
    const h = harness({ maxQueued: 5, flushAt: 1000 });
    h.queue.enqueue(ev(1));
    h.queue.enqueue(ev(1));
    expect(h.queue.size()).toBe(1);
    for (let i = 2; i <= 9; i += 1) h.queue.enqueue(ev(i));
    expect(h.queue.snapshot().map((e) => e.id)).toEqual(['e5', 'e6', 'e7', 'e8', 'e9']);
    expect(MAX_QUEUED).toBe(2000);
  });
});

describe('PlayEventQueue: when it flushes', () => {
  it('at 20 queued events — not before', async () => {
    expect(FLUSH_AT).toBe(20);
    const h = harness();
    for (let i = 1; i <= 19; i += 1) h.queue.enqueue(ev(i));
    await Promise.resolve();
    expect(h.send).not.toHaveBeenCalled();
    h.queue.enqueue(ev(20));
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(h.sent[0].ids).toHaveLength(20);
    await vi.waitFor(() => expect(h.queue.size()).toBe(0));
  });

  it('every 5 minutes (the timer) and once at start-up with what the last session left', async () => {
    expect(FLUSH_INTERVAL_MS).toBe(300_000);
    const storage = memoryStorage({ [PLAY_QUEUE_KEY]: JSON.stringify([ev(1)]) });
    const h = harness({ storage });
    h.queue.start();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1)); // start-up flush
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(300_000);

    h.queue.enqueue(ev(2));
    h.timers[0].fn(); // the 5-minute tick
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.sent[1].ids).toEqual(['e2']);

    h.queue.start(); // idempotent
    expect(h.timers).toHaveLength(1);
    h.queue.stop();
    expect(h.timers[0].cleared).toBe(true);
  });

  it('an empty queue sends nothing', async () => {
    const h = harness();
    await h.queue.flush();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a flush requested while the previous request is finishing is not lost', async () => {
    const h = harness();
    h.queue.enqueue(ev(1));
    const first = h.queue.flush();
    h.queue.enqueue(ev(2));
    void h.queue.flush(); // arrives while the first request is still in flight
    await first;
    await vi.waitFor(() => expect(h.queue.size()).toBe(0));
    expect(h.sent.flatMap((s) => s.ids)).toEqual(['e1', 'e2']);
  });

  it('only one request at a time: concurrent flushes share it', async () => {
    let release: (n: number) => void = () => undefined;
    const send = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const h = harness({ send });
    h.queue.enqueue(ev(1));
    const a = h.queue.flush();
    const b = h.queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
    release(200);
    await Promise.all([a, b]);
    expect(h.queue.size()).toBe(0);
  });
});

describe('PlayEventQueue: an event leaves the queue ONLY after a 200', () => {
  it('200 removes exactly the events that were sent (an event queued meanwhile stays until ITS request is acknowledged)', async () => {
    let queue: PlayEventQueue;
    let calls = 0;
    // 1st request: acknowledged, and a new event arrives while it is in flight; 2nd request (for that one): fails.
    const h = harness({}, () => { calls += 1; if (calls === 1) { queue.enqueue(ev(99)); return 200; } return 500; });
    queue = h.queue;
    h.queue.enqueue(ev(1));
    h.queue.enqueue(ev(2));
    await h.queue.flush();
    expect(h.sent[0].ids).toEqual(['e1', 'e2']);
    expect(h.queue.snapshot().map((e) => e.id)).toEqual(['e99']);
    expect(stored(h.storage).map((e) => e.id)).toEqual(['e99']);
  });

  it.each([500, 502, 401, 403, 404, 429, 201, 204, 400, 0])('status %i keeps every event', async (status) => {
    const h = harness({}, status);
    h.queue.enqueue(ev(1));
    h.queue.enqueue(ev(2));
    await h.queue.flush();
    expect(h.queue.size()).toBe(2);
    expect(stored(h.storage)).toHaveLength(2);
  });

  it('a network error keeps every event and never rejects', async () => {
    const onError = vi.fn();
    const h = harness({ onError }, new Error('Failed to fetch'));
    h.queue.enqueue(ev(1));
    await expect(h.queue.flush()).resolves.toBeUndefined();
    expect(h.queue.size()).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a throwing onError does not break anything', async () => {
    const h = harness({ onError: () => { throw new Error('x'); } }, 500);
    h.queue.enqueue(ev(1));
    await expect(h.queue.flush()).resolves.toBeUndefined();
    expect(h.queue.size()).toBe(1);
  });

  it('what failed is sent again later, and then removed', async () => {
    let status = 500;
    const h = harness({}, () => status);
    h.queue.enqueue(ev(1));
    await h.queue.flush();
    expect(h.queue.size()).toBe(1);
    status = 200;
    await h.queue.flush({ force: true });
    expect(h.queue.size()).toBe(0);
    expect(h.sent.map((s) => s.ids)).toEqual([['e1'], ['e1']]);
  });
});

describe('PlayEventQueue: batches and backoff', () => {
  it('never sends more than 500 events in a request, and keeps going until the queue is empty', async () => {
    expect(MAX_BATCH).toBe(500);
    const h = harness({ flushAt: 100_000, maxQueued: 5000 });
    for (let i = 1; i <= 1200; i += 1) h.queue.enqueue(ev(i));
    await h.queue.flush();
    expect(h.sent.map((s) => s.ids.length)).toEqual([500, 500, 200]);
    expect(h.queue.size()).toBe(0);
  });

  it('a request that has to outlive the page (keepalive) is small, single, and ignores the backoff', async () => {
    expect(MAX_KEEPALIVE_BATCH).toBe(100);
    let status = 500;
    const h = harness({ flushAt: 100_000 }, () => status);
    for (let i = 1; i <= 150; i += 1) h.queue.enqueue(ev(i));
    await h.queue.flush(); // fails → backoff
    status = 200;
    await h.queue.flush({ keepalive: true });
    expect(h.sent[h.sent.length - 1].keepalive).toBe(true);
    expect(h.sent[h.sent.length - 1].ids).toHaveLength(100);
    expect(h.queue.size()).toBe(50);
  });

  it('after a failure automatic flushes wait (30 s, 60 s, … up to 5 min); a success resets it', async () => {
    let status = 500;
    const h = harness({ flushAt: 100_000 }, () => status);
    h.queue.enqueue(ev(1));
    await h.queue.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.queue.flush(); // too soon
    expect(h.send).toHaveBeenCalledTimes(1);
    h.advance(29_999);
    await h.queue.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.queue.flush(); // 30 s passed → second failure → wait 60 s
    expect(h.send).toHaveBeenCalledTimes(2);
    h.advance(59_000);
    await h.queue.flush();
    expect(h.send).toHaveBeenCalledTimes(2);
    h.advance(1_000);
    status = 200;
    await h.queue.flush();
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.queue.size()).toBe(0);

    h.queue.enqueue(ev(2));
    await h.queue.flush(); // backoff was reset by the success
    expect(h.send).toHaveBeenCalledTimes(4);
  });
});
