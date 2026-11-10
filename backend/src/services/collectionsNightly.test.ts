import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn(), withClient: vi.fn(), pool: {} }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

vi.mock('./collectionsWiring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./collectionsWiring')>()),
  catchUpInputs: vi.fn(),
  realCatchUpDeps: vi.fn(),
}));
vi.mock('./collectionsEngineData', () => ({ listOwners: vi.fn(), realEngineDeps: vi.fn(), hasCollections: vi.fn() }));
vi.mock('./collectionsEngine', async (importOriginal) => ({ ...(await importOriginal<typeof import('./collectionsEngine')>()), consolidate: vi.fn() }));

import { logInfo, logWarning } from '../utils/logger';
import { consolidate as engineConsolidate, type ConsolidationResult } from './collectionsEngine';
import { hasCollections as realHasCollections, listOwners as realListOwners, realEngineDeps } from './collectionsEngineData';
import { catchUpInputs, collectionsAutoEnabled, realCatchUpDeps, type CatchUpSummary } from './collectionsWiring';
import {
  NIGHTLY_CATCH_UP_LIMIT,
  NIGHTLY_EVERY_MS,
  NIGHTLY_FIRST_RUN_MS,
  realNightlyDeps,
  runNightly,
  startNightlyConsolidation,
  startNightlySchedule,
} from './collectionsNightly';

// Raccolte, task 7 (spec §5.3 and §5.10): the nightly pass of the collections. First pass about ten minutes after the start (never at the boot: the backfill
// and the analyses are busier then), then every 24 hours; one owner that fails never stops the others; passes never overlap; COLLECTIONS_AUTO=0 starts nothing.

const summary = (over: Partial<CatchUpSummary> = {}): CatchUpSummary => ({ scanned: 10, needAny: 0, needVector: 0, needPlaces: 0, upToDate: 10, noText: 0, done: 0, pending: 0, ...over });
const result = (userId: string): ConsolidationResult => ({ userId, entries: 10, skippedDimensions: 0, collections: [], published: 3, watching: 1, created: 2, inherited: 2, modelCalls: 2, dropped: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.COLLECTIONS_AUTO;
});
afterEach(() => {
  delete process.env.COLLECTIONS_AUTO;
  vi.useRealTimers();
});

describe('the kill switch', () => {
  it('COLLECTIONS_AUTO=0 stops the discovery; anything else (or nothing) leaves it on', () => {
    expect(collectionsAutoEnabled()).toBe(true);
    process.env.COLLECTIONS_AUTO = '1';
    expect(collectionsAutoEnabled()).toBe(true);
    process.env.COLLECTIONS_AUTO = '0';
    expect(collectionsAutoEnabled()).toBe(false);
  });

  it('switched off, the schedule starts no timer at all, and stopping it is safe', () => {
    process.env.COLLECTIONS_AUTO = '0';
    const timers = { setTimeout: vi.fn(), setInterval: vi.fn(), clearTimeout: vi.fn(), clearInterval: vi.fn() };
    const handle = startNightlyConsolidation({ listOwners: vi.fn(), consolidate: vi.fn(), timers });
    expect(timers.setTimeout).not.toHaveBeenCalled();
    expect(timers.setInterval).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });
});

describe('one run: every owner, one after the other', () => {
  it('consolidates each owner in order, and says how many went well', async () => {
    const consolidate = vi.fn(async (u: string) => result(u));
    const out = await runNightly({ listOwners: async () => ['mike', 'sara'], consolidate });
    expect(consolidate.mock.calls.map((c) => c[0])).toEqual(['mike', 'sara']);
    expect(out).toEqual({ owners: 2, ok: 2, failed: 0, healed: 0, stillPending: 0, waiting: 0 });
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('collections nightly'), expect.objectContaining({ owners: 2, ok: 2, failed: 0 }));
  });

  it('an owner that fails is a warning and the others go on', async () => {
    const consolidate = vi.fn(async (u: string) => {
      if (u === 'mike') throw new Error('router down');
      return result(u);
    });
    const out = await runNightly({ listOwners: async () => ['mike', 'sara'], consolidate });
    expect(consolidate).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ owners: 2, ok: 1, failed: 1, healed: 0, stillPending: 0, waiting: 0 });
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('collections'), expect.objectContaining({ owner: 'mike', error: 'router down' }));
  });

  it('a list of owners that cannot be read is a warning, not an exception, and the next night tries again', async () => {
    const consolidate = vi.fn();
    const out = await runNightly({ listOwners: async () => { throw new Error('db down'); }, consolidate });
    expect(consolidate).not.toHaveBeenCalled();
    expect(out).toEqual({ owners: 0, ok: 0, failed: 1, healed: 0, stillPending: 0, waiting: 0 });
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('owners'), expect.objectContaining({ error: 'db down' }));
  });

  it('never runs for «anonymous», for an empty name, or twice for the same owner', async () => {
    const consolidate = vi.fn(async (u: string) => result(u));
    await runNightly({ listOwners: async () => ['mike', '', 'anonymous', ' mike ', 'sara'], consolidate });
    expect(consolidate.mock.calls.map((c) => c[0])).toEqual(['mike', 'sara']);
  });

  it('nobody to run for: nothing happens', async () => {
    const out = await runNightly({ listOwners: async () => [], consolidate: vi.fn() });
    expect(out).toEqual({ owners: 0, ok: 0, failed: 0, healed: 0, stillPending: 0, waiting: 0 });
  });
});

describe('the first publication is not the night\'s: an owner who has no collection yet waits for it (the script, after a look at the preview)', () => {
  it('an owner who has no collection is NOT consolidated (nothing is published by itself), and the summary says he is waiting; his missing inputs are still healed', async () => {
    const consolidate = vi.fn(async (u: string) => result(u));
    const catchUp = vi.fn(async () => summary({ needAny: 1, done: 1 }));
    const out = await runNightly({ listOwners: async () => ['mike', 'sara'], consolidate, catchUp, published: async (owner) => owner === 'mike' });
    expect(consolidate.mock.calls.map((c) => c[0])).toEqual(['mike']);
    expect(catchUp.mock.calls.map((c) => c[0])).toEqual(['mike', 'sara']);
    expect(out).toMatchObject({ owners: 2, ok: 1, failed: 0, waiting: 1, healed: 2 });
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('waiting'), expect.objectContaining({ owner: 'sara' }));
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('1 waiting for the first publication'), expect.objectContaining({ waiting: 1, ok: 1 }));
  });

  it('every owner who already has collections is consolidated, as ever', async () => {
    const consolidate = vi.fn(async (u: string) => result(u));
    const out = await runNightly({ listOwners: async () => ['mike', 'sara'], consolidate, published: async () => true });
    expect(consolidate).toHaveBeenCalledTimes(2);
    expect(out.waiting).toBe(0);
  });

  it('not being able to tell whether an owner has collections is a failure of that owner only (a warning), and the others go on', async () => {
    const consolidate = vi.fn(async (u: string) => result(u));
    const out = await runNightly({
      listOwners: async () => ['mike', 'sara'],
      consolidate,
      published: async (owner) => { if (owner === 'mike') throw new Error('db down'); return true; },
    });
    expect(consolidate.mock.calls.map((c) => c[0])).toEqual(['sara']);
    expect(out).toMatchObject({ ok: 1, failed: 1, waiting: 0 });
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('collections'), expect.objectContaining({ owner: 'mike', error: 'db down' }));
  });

  it('the real night asks the database whether the owner has any collection (any state: a hidden or merged one is a publication too)', async () => {
    vi.mocked(realCatchUpDeps).mockReturnValue({} as never);
    vi.mocked(realEngineDeps).mockReturnValue({} as never);
    const deps = await realNightlyDeps();
    expect(deps.published).toBe(realHasCollections);
  });
});

describe('catching up what a cold router left behind, before each owner is consolidated', () => {
  it('the budget is 200 entries a night: what a cold router cannot stretch', () => {
    expect(NIGHTLY_CATCH_UP_LIMIT).toBe(200);
  });

  it('heals the entries of an owner first, then consolidates him: the new vectors are in the pass', async () => {
    const order: string[] = [];
    const catchUp = vi.fn(async (owner: string) => { order.push(`catch ${owner}`); return summary({ needAny: 3, done: 3 }); });
    const consolidate = vi.fn(async (owner: string) => { order.push(`pass ${owner}`); return result(owner); });
    const out = await runNightly({ listOwners: async () => ['mike', 'sara'], consolidate, catchUp });
    expect(order).toEqual(['catch mike', 'pass mike', 'catch sara', 'pass sara']);
    expect(out).toEqual({ owners: 2, ok: 2, failed: 0, healed: 6, stillPending: 0, waiting: 0 });
  });

  it('is one budget for the whole night, shared by the owners: each gets what is left, and when it is spent nobody else is healed (the passes go on)', async () => {
    const asked: Array<[string, number]> = [];
    const catchUp = vi.fn(async (owner: string, limit: number) => { asked.push([owner, limit]); return summary({ needAny: limit === 200 ? 150 : limit, done: limit === 200 ? 150 : limit }); });
    const consolidate = vi.fn(async (owner: string) => result(owner));
    await runNightly({ listOwners: async () => ['a', 'b', 'c'], consolidate, catchUp });
    expect(asked).toEqual([['a', 200], ['b', 50]]);                         // a used 150, b the 50 that were left, c is not healed
    expect(consolidate).toHaveBeenCalledTimes(3);
  });

  it('the budget can be given', async () => {
    const catchUp = vi.fn(async () => summary());
    await runNightly({ listOwners: async () => ['mike'], consolidate: async (u) => result(u), catchUp, catchUpLimit: 7 });
    expect(catchUp).toHaveBeenCalledWith('mike', 7);
  });

  it('a budget of nothing heals nobody', async () => {
    const catchUp = vi.fn(async () => summary());
    await runNightly({ listOwners: async () => ['mike'], consolidate: async (u) => result(u), catchUp, catchUpLimit: 0 });
    expect(catchUp).not.toHaveBeenCalled();
  });

  it('a heal that fails is a warning and the owner is consolidated all the same', async () => {
    const catchUp = vi.fn().mockRejectedValueOnce(new Error('router down')).mockResolvedValue(summary());
    const consolidate = vi.fn(async (u: string) => result(u));
    const out = await runNightly({ listOwners: async () => ['mike', 'sara'], consolidate, catchUp });
    expect(consolidate.mock.calls.map((c) => c[0])).toEqual(['mike', 'sara']);
    expect(catchUp).toHaveBeenCalledTimes(2);
    expect(out.ok).toBe(2);
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('catching up'), expect.objectContaining({ owner: 'mike', error: 'router down' }));
  });

  it('a router that does not answer at all (there was something to do and nothing was done) is not asked again for the other owners tonight', async () => {
    const catchUp = vi.fn(async () => summary({ needAny: 5, done: 0, pending: 5 }));
    const consolidate = vi.fn(async (u: string) => result(u));
    const out = await runNightly({ listOwners: async () => ['mike', 'sara', 'anna'], consolidate, catchUp });
    expect(catchUp).toHaveBeenCalledTimes(1);
    expect(consolidate).toHaveBeenCalledTimes(3);
    expect(out.stillPending).toBe(5);
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('model'), expect.anything());
  });

  it('nothing to heal is not a router that is down: the next owner is healed too', async () => {
    const catchUp = vi.fn(async () => summary({ needAny: 0, done: 0 }));
    await runNightly({ listOwners: async () => ['mike', 'sara'], consolidate: async (u) => result(u), catchUp });
    expect(catchUp).toHaveBeenCalledTimes(2);
  });

  it('a partly good night is a good night: some done, some pending, the others are healed too', async () => {
    const catchUp = vi.fn(async () => summary({ needAny: 4, done: 3, pending: 1 }));
    const out = await runNightly({ listOwners: async () => ['mike', 'sara'], consolidate: async (u) => result(u), catchUp });
    expect(catchUp).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ healed: 6, stillPending: 2 });
  });

  it('without a way to heal (no dependency) the owners are only consolidated', async () => {
    const consolidate = vi.fn(async (u: string) => result(u));
    const out = await runNightly({ listOwners: async () => ['mike'], consolidate });
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ owners: 1, ok: 1, failed: 0, healed: 0, stillPending: 0, waiting: 0 });
  });

  it('the summary of the night says what was healed', async () => {
    await runNightly({ listOwners: async () => ['mike'], consolidate: async (u) => result(u), catchUp: async () => summary({ needAny: 2, done: 2 }) });
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('collections nightly'), expect.objectContaining({ healed: 2, stillPending: 0 }));
  });
});

describe('the real parts of the night', () => {
  it('heal with the whole-library run of the wiring (the same decision as the pipeline), for the owner, with the budget, and write (apply)', async () => {
    const wiringDeps = { marker: 'wiring-deps' };
    vi.mocked(realCatchUpDeps).mockReturnValue(wiringDeps as never);
    vi.mocked(catchUpInputs).mockResolvedValue(summary({ needAny: 1, done: 1 }));
    vi.mocked(realEngineDeps).mockReturnValue({ marker: 'engine-deps' } as never);
    vi.mocked(engineConsolidate).mockResolvedValue(result('mike'));
    const deps = await realNightlyDeps();
    expect(deps.listOwners).toBe(realListOwners);
    await deps.catchUp?.('mike', 123);
    expect(catchUpInputs).toHaveBeenCalledWith(wiringDeps, { apply: true, owner: 'mike', limit: 123 });
    await deps.consolidate('mike');
    expect(engineConsolidate).toHaveBeenCalledWith('mike', { marker: 'engine-deps' });
  });

  it('the progress lines of the heal go to the log', async () => {
    vi.mocked(realCatchUpDeps).mockReturnValue({} as never);
    vi.mocked(realEngineDeps).mockReturnValue({} as never);
    await realNightlyDeps();
    const say = vi.mocked(realCatchUpDeps).mock.calls[0][0] as (line: string) => void;
    say('  25 voci fatte');
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('25 voci fatte'));
  });
});

describe('the schedule', () => {
  function fakeTimers() {
    const calls: Array<{ kind: 'timeout' | 'interval'; ms: number; fn: () => void; unref: ReturnType<typeof vi.fn>; cleared: boolean }> = [];
    const make = (kind: 'timeout' | 'interval') => (fn: () => void, ms: number) => {
      const entry = { kind, ms, fn, unref: vi.fn(), cleared: false };
      calls.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    };
    const clear = (t: unknown) => { (t as { cleared: boolean }).cleared = true; };
    return { calls, timers: { setTimeout: make('timeout'), setInterval: make('interval'), clearTimeout: clear, clearInterval: clear } };
  }

  it('the constants: about ten minutes after the start, then once a day', () => {
    expect(NIGHTLY_FIRST_RUN_MS).toBe(10 * 60 * 1000);
    expect(NIGHTLY_EVERY_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('starts one timeout (the first run) and one interval (the daily run), and neither keeps the process alive', () => {
    const { calls, timers } = fakeTimers();
    startNightlySchedule(async () => undefined, { timers });
    expect(calls.map((c) => [c.kind, c.ms])).toEqual([['timeout', NIGHTLY_FIRST_RUN_MS], ['interval', NIGHTLY_EVERY_MS]]);
    for (const c of calls) expect(c.unref).toHaveBeenCalledTimes(1);
  });

  it('the delays can be given (a test, or an urgent run)', () => {
    const { calls, timers } = fakeTimers();
    startNightlySchedule(async () => undefined, { timers, firstRunMs: 5, everyMs: 7 });
    expect(calls.map((c) => c.ms)).toEqual([5, 7]);
  });

  it('runs at the first timeout and at every tick', async () => {
    const { calls, timers } = fakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    startNightlySchedule(run, { timers });
    expect(run).not.toHaveBeenCalled();
    calls[0].fn();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    calls[1].fn();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a run that fails never stops the schedule: it is a warning and the next tick runs', async () => {
    const { calls, timers } = fakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    startNightlySchedule(run, { timers });
    calls[1].fn();
    await new Promise((r) => setImmediate(r));
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('collections nightly'), expect.objectContaining({ error: 'boom' }));
    calls[1].fn();
    await new Promise((r) => setImmediate(r));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a tick that finds the previous run still going does not start another', async () => {
    const { calls, timers } = fakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    startNightlySchedule(run, { timers });
    calls[0].fn();
    calls[1].fn();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((r) => setImmediate(r));
    calls[1].fn();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('the stop function clears both timers, and a timer that fires after it runs nothing', async () => {
    const { calls, timers } = fakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startNightlySchedule(run, { timers });
    stop();
    expect(calls.every((c) => c.cleared)).toBe(true);
    calls[0].fn();
    calls[1].fn();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  describe('with the real timers (fake clock)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('ten minutes after the start, then at 24 h, 48 h…, and not after the stop', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      const stop = startNightlySchedule(run);
      await vi.advanceTimersByTimeAsync(NIGHTLY_FIRST_RUN_MS - 1);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(NIGHTLY_EVERY_MS);
      expect(run).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(NIGHTLY_EVERY_MS * 2);
      expect(run).toHaveBeenCalledTimes(2);
    });
  });
});

describe('startNightlyConsolidation', () => {
  it('runs the pass for every owner when the first timer fires, and stops with its handle', async () => {
    const calls: Array<() => void> = [];
    const timers = {
      setTimeout: (fn: () => void) => { calls.push(fn); return {} as ReturnType<typeof setTimeout>; },
      setInterval: () => ({}) as ReturnType<typeof setInterval>,
      clearTimeout: vi.fn(),
      clearInterval: vi.fn(),
    };
    const consolidate = vi.fn(async (u: string) => result(u));
    const handle = startNightlyConsolidation({ listOwners: async () => ['mike'], consolidate, timers });
    calls[0]();
    await new Promise((r) => setImmediate(r));
    expect(consolidate).toHaveBeenCalledWith('mike');
    handle.stop();
    expect(timers.clearTimeout).toHaveBeenCalled();
    expect(timers.clearInterval).toHaveBeenCalled();
  });
});
