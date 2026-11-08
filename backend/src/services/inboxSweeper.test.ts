import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn(), pool: { query: vi.fn() }, getEntry: vi.fn(), addEntryShares: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { STUCK_EVERY_MS, SWEEP_EVERY_MS, resolveOnce, startInboxSweeper, sweepOnce } from './inboxSweeper';
import { logInfo, logWarning } from '../utils/logger';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('sweepOnce', () => {
  it('says what it removed, and stays quiet when there was nothing to do', async () => {
    await sweepOnce(async () => ({ expired: 2, purged: 1, intentsPurged: 0 }));
    expect(logInfo).toHaveBeenCalledWith('inbox sweep', { expired: 2, purged: 1, intentsPurged: 0 });
    vi.mocked(logInfo).mockClear();
    await sweepOnce(async () => ({ expired: 0, purged: 0, intentsPurged: 0 }));
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('a failing run costs nothing: it is logged and the next one tries again', async () => {
    const result = await sweepOnce(async () => { throw new Error('db down'); });
    expect(result).toBeNull();
    expect(logWarning).toHaveBeenCalled();
  });
});

describe('resolveOnce', () => {
  it('says how many stuck shares it closed, and stays quiet when there were none', async () => {
    expect(await resolveOnce(async () => 2)).toBe(2);
    expect(logInfo).toHaveBeenCalledWith('stuck shares resolved', { closed: 2 });
    vi.mocked(logInfo).mockClear();
    expect(await resolveOnce(async () => 0)).toBe(0);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('a failing run costs nothing', async () => {
    expect(await resolveOnce(async () => { throw new Error('db down'); })).toBe(0);
    expect(logWarning).toHaveBeenCalled();
  });
});

describe('startInboxSweeper', () => {
  it('housekeeping: first run shortly after boot, then every hour, and it can be stopped', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => ({ expired: 0, purged: 0, intentsPurged: 0 }));
    const stop = startInboxSweeper(sweep, async () => 0);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SWEEP_EVERY_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(SWEEP_EVERY_MS * 3);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('stuck shares: looked at after boot and then every 10 minutes, until stopped', async () => {
    vi.useFakeTimers();
    const resolve = vi.fn(async () => 0);
    const stop = startInboxSweeper(async () => ({ expired: 0, purged: 0, intentsPurged: 0 }), resolve);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STUCK_EVERY_MS);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(STUCK_EVERY_MS).toBe(10 * 60 * 1000);
    stop();
    await vi.advanceTimersByTimeAsync(STUCK_EVERY_MS * 5);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
