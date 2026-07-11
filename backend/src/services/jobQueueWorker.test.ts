import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/jobQueue', () => ({
  claimNextInstagramJob: vi.fn(),
  claimNextOtherJob: vi.fn(),
  markJobDone: vi.fn(),
  markJobFailed: vi.fn(),
  scheduleJobRetry: vi.fn(),
}));

vi.mock('../routes/telegram', () => ({
  sendTelegramMessage: vi.fn(),
  formatAnalysisError: vi.fn().mockReturnValue('error-text'),
  formatTelegramResponse: vi.fn().mockResolvedValue('ok-text'),
}));

vi.mock('./debugLogger', () => {
  class Logger {
    startTimer = vi.fn();
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    endTimer = vi.fn();
  }
  return { Logger };
});

import {
  computeJitterDelayMs,
  computeBackoffMs,
  tick,
  createInitialWorkerState,
} from './jobQueueWorker';
import {
  claimNextInstagramJob,
  claimNextOtherJob,
  markJobDone,
  markJobFailed,
  scheduleJobRetry,
  type JobQueueRow,
} from '../utils/jobQueue';
import { sendTelegramMessage } from '../routes/telegram';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const IG_JOB: JobQueueRow = {
  id: 1, entryId: 'e1', sourceUrl: 'https://instagram.com/reel/x', platform: 'instagram',
  chatId: 42, inputUser: '@mike', status: 'processing', attempts: 0,
  nextAttemptAt: '', createdAt: '', updatedAt: '',
};

describe('computeJitterDelayMs', () => {
  it('rand=0 → 30000 (lower bound)', () => {
    expect(computeJitterDelayMs(() => 0)).toBe(30_000);
  });

  it('rand just under 1 → just under 90000 (upper bound)', () => {
    const v = computeJitterDelayMs(() => 0.999999);
    expect(v).toBeGreaterThanOrEqual(89_999);
    expect(v).toBeLessThan(90_000);
  });
});

describe('computeBackoffMs', () => {
  it('instagram attempt 1 → 60s', () => {
    expect(computeBackoffMs('instagram', 1)).toBe(60_000);
  });
  it('instagram attempt 3 → 420s', () => {
    expect(computeBackoffMs('instagram', 3)).toBe(420_000);
  });
  it('instagram attempt 4 → null (terminal, exhausted)', () => {
    expect(computeBackoffMs('instagram', 4)).toBeNull();
  });
  it('other attempt 1 → 60s', () => {
    expect(computeBackoffMs('other', 1)).toBe(60_000);
  });
  it('other attempt 2 → null (terminal, exhausted)', () => {
    expect(computeBackoffMs('other', 2)).toBeNull();
  });
});

describe('tick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });

  it('no jobs queued → state stays idle', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(null);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    const state = createInitialWorkerState();
    await tick(state);
    expect(state.igBusy).toBe(false);
    expect(state.otherInFlight).toBe(0);
  });

  it('IG lane already busy → does not attempt to claim another IG job', async () => {
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    const state = createInitialWorkerState();
    state.igBusy = true;
    await tick(state);
    expect(claimNextInstagramJob).not.toHaveBeenCalled();
  });

  it('IG jitter window not elapsed yet → does not attempt to claim', async () => {
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    const state = createInitialWorkerState();
    state.igNextAllowedAt = Date.now() + 60_000;
    await tick(state);
    expect(claimNextInstagramJob).not.toHaveBeenCalled();
  });

  it('IG job found + analyze succeeds → marks done, sends result, opens jitter window', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(IG_JOB);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, entryId: 'e1', entry: { results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null } } }),
    } as never);

    const state = createInitialWorkerState();
    await tick(state);
    await flush();

    expect(markJobDone).toHaveBeenCalledWith(1);
    expect(sendTelegramMessage).toHaveBeenCalledWith(42, 'ok-text', expect.any(String));
    expect(state.igBusy).toBe(false);
    expect(state.igNextAllowedAt).toBeGreaterThan(Date.now() + 29_000);
  });

  it('IG job fails, attempts=0 → schedules retry with 60s backoff, does not mark failed', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(IG_JOB);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const state = createInitialWorkerState();
    await tick(state);
    await flush();

    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 1, expect.any(Date));
    expect(markJobFailed).not.toHaveBeenCalled();
  });

  it('IG job fails at attempts=3 (exhausted) → marks failed, sends error message, no more retry', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue({ ...IG_JOB, attempts: 3 });
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const state = createInitialWorkerState();
    await tick(state);
    await flush();

    expect(markJobFailed).toHaveBeenCalledWith(1);
    expect(scheduleJobRetry).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalled();
  });

  it('other-platform jobs dispatch up to the concurrency cap of 3, then stop', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(null);
    let claims = 0;
    vi.mocked(claimNextOtherJob).mockImplementation(async () => {
      claims++;
      return claims <= 3 ? { ...IG_JOB, id: claims, platform: 'other' } : null;
    });
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {})); // never resolves — keeps jobs in flight

    const state = createInitialWorkerState();
    await tick(state);

    expect(state.otherInFlight).toBe(3);
    expect(claimNextOtherJob).toHaveBeenCalledTimes(4); // 3 successful claims + 1 empty to stop the loop
  });
});
