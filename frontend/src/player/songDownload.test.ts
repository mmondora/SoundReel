import { describe, expect, it, vi } from 'vitest';
import { createDownloadTracker } from './songDownload';
import type { DownloadUiState } from './songDownload';
import type { SongDownloadResponse, SongStateResponse } from '../types';

/** Manual clock + timers so the 5 s / 3 min policy is tested without waiting. */
function harness(opts: {
  request?: (key: string) => Promise<SongDownloadResponse>;
  poll?: (key: string) => Promise<SongStateResponse>;
  maxMs?: number;
} = {}) {
  let time = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const states: DownloadUiState[] = [];
  const request = vi.fn(opts.request ?? (async () => ({ ok: true, state: 'preparing' as const })));
  const poll = vi.fn(opts.poll ?? (async () => stateOf('preparing')));
  const tracker = createDownloadTracker({
    request,
    poll,
    onChange: (s) => states.push(s),
    intervalMs: 5000,
    maxMs: opts.maxMs ?? 180_000,
    now: () => time,
    setTimer: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: time + ms, fn });
      return id;
    },
    clearTimer: (h) => { pending.delete(h as number); },
  });
  /** Advance the clock by `ms`, firing due timers (and letting promises settle after each). */
  async function advance(ms: number): Promise<void> {
    const end = time + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at;
      pending.delete(due[0]);
      due[1].fn();
      await flush();
    }
    time = end;
  }
  return { tracker, request, poll, states, advance, pendingTimers: () => pending.size };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function stateOf(state: SongStateResponse['state'], error: string | null = null): SongStateResponse {
  return { state, source: null, version: null, bytes: null, error, inLibrary: state === 'ready' };
}

const phases = (states: DownloadUiState[]) => states.map((s) => s.phase);
const last = <T,>(items: T[]): T | undefined => items[items.length - 1];

describe('createDownloadTracker', () => {
  it('requests the download once and reports requesting → downloading', async () => {
    const h = harness();
    h.tracker.start('a::b');
    await flush();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request).toHaveBeenCalledWith('a::b');
    expect(phases(h.states)).toEqual(['requesting', 'downloading']);
    expect(h.tracker.stateOf('a::b')?.phase).toBe('downloading');
  });

  it('is once per song per session: a second start does nothing', async () => {
    const h = harness();
    h.tracker.start('a::b');
    h.tracker.start('a::b');
    await flush();
    h.tracker.start('a::b');
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('polls every 5 s and stops when the file is ready', async () => {
    let calls = 0;
    const h = harness({ poll: async () => stateOf(++calls >= 3 ? 'ready' : 'preparing') });
    h.tracker.start('a::b');
    await flush();
    await h.advance(4999);
    expect(h.poll).not.toHaveBeenCalled();
    await h.advance(1);
    expect(h.poll).toHaveBeenCalledTimes(1);
    await h.advance(10_000);
    expect(h.poll).toHaveBeenCalledTimes(3);
    expect(phases(h.states)).toEqual(['requesting', 'downloading', 'ready']);
    await h.advance(60_000);
    expect(h.poll).toHaveBeenCalledTimes(3);
    expect(h.pendingTimers()).toBe(0);
  });

  it('when the file is ready the state carries the location the server reported (FS / MS)', async () => {
    const h = harness({
      poll: async () => ({ ...stateOf('ready'), location: { fs: true, mediaServer: true } }),
    });
    h.tracker.start('a::b');
    await flush();
    await h.advance(5000);
    expect(last(h.states)).toEqual({ songKey: 'a::b', phase: 'ready', location: { fs: true, mediaServer: true } });
  });

  it('a file that is already ready needs no polling at all', async () => {
    const h = harness({ request: async () => ({ ok: true, state: 'ready' }) });
    h.tracker.start('a::b');
    await flush();
    expect(phases(h.states)).toEqual(['requesting', 'ready']);
    expect(h.pendingTimers()).toBe(0);
    expect(h.poll).not.toHaveBeenCalled();
  });

  it('no_source is reported as unavailable, failed as failed — both stop polling', async () => {
    const a = harness({ request: async () => ({ ok: true, state: 'no_source', track: { error: 'nessun risultato' } }) });
    a.tracker.start('x::y');
    await flush();
    expect(last(a.states)).toEqual({ songKey: 'x::y', phase: 'unavailable', error: 'nessun risultato' });

    const b = harness({ poll: async () => stateOf('failed', 'HTTP 403') });
    b.tracker.start('x::y');
    await flush();
    await b.advance(5000);
    expect(last(b.states)).toEqual({ songKey: 'x::y', phase: 'failed', error: 'HTTP 403' });
    await b.advance(60_000);
    expect(b.poll).toHaveBeenCalledTimes(1);
  });

  it('gives up after about 3 minutes with a timeout state', async () => {
    const h = harness();
    h.tracker.start('a::b');
    await flush();
    await h.advance(181_000);
    expect(last(h.states)?.phase).toBe('timeout');
    const pollsAtTimeout = h.poll.mock.calls.length;
    expect(pollsAtTimeout).toBeGreaterThanOrEqual(35);
    await h.advance(60_000);
    expect(h.poll).toHaveBeenCalledTimes(pollsAtTimeout);
    expect(h.pendingTimers()).toBe(0);
  });

  it('a failed poll is not a failed download: it keeps polling', async () => {
    let calls = 0;
    const h = harness({
      poll: async () => {
        calls += 1;
        if (calls < 3) throw new Error('network');
        return stateOf('ready');
      },
    });
    h.tracker.start('a::b');
    await flush();
    await h.advance(15_000);
    expect(phases(h.states)).toEqual(['requesting', 'downloading', 'ready']);
  });

  it('a failed REQUEST is reported and may be retried by the next play', async () => {
    let n = 0;
    const h = harness({
      request: async () => {
        n += 1;
        if (n === 1) throw new Error('{"error":"unauthorized"}');
        return { ok: true, state: 'ready' as const };
      },
    });
    h.tracker.start('a::b');
    await flush();
    expect(last(h.states)).toEqual({ songKey: 'a::b', phase: 'failed', error: 'unauthorized' });
    h.tracker.start('a::b');
    await flush();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(last(h.states)?.phase).toBe('ready');
  });

  it('tracks several songs independently', async () => {
    const h = harness({ poll: async (key) => stateOf(key === 'one::1' ? 'ready' : 'preparing') });
    h.tracker.start('one::1');
    h.tracker.start('two::2');
    await flush();
    await h.advance(5000);
    expect(h.tracker.stateOf('one::1')?.phase).toBe('ready');
    expect(h.tracker.stateOf('two::2')?.phase).toBe('downloading');
  });

  it('dispose stops timers and silences later results', async () => {
    const h = harness();
    h.tracker.start('a::b');
    await flush();
    h.tracker.dispose();
    const before = h.states.length;
    await h.advance(60_000);
    expect(h.poll).not.toHaveBeenCalled();
    expect(h.states).toHaveLength(before);
    h.tracker.start('c::d');
    await flush();
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});
