import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/jobQueue', () => ({
  claimNextInstagramJob: vi.fn(),
  claimNextOtherJob: vi.fn(),
  claimNextTranscribeJob: vi.fn(),
  enqueueJob: vi.fn(),
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
  nextAttemptAt: '', createdAt: '', updatedAt: '', notify: true,
  kind: 'analyze', priority: 0, reanalyze: false,
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
    // The while condition is checked BEFORE each claim, so once otherInFlight
    // reaches the cap the loop exits without an extra trailing claim call —
    // it does not need to observe a null to know it's full.
    expect(claimNextOtherJob).toHaveBeenCalledTimes(3);
  });

  it('IG job succeeds but Telegram notify fails → job stays done, no retry/failure triggered', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(IG_JOB);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, entryId: 'e1', entry: { results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null } } }),
    } as never);
    vi.mocked(sendTelegramMessage).mockRejectedValue(new Error('ETELEGRAM: network error'));

    const state = createInitialWorkerState();
    await tick(state);
    await flush();
    await flush();

    expect(markJobDone).toHaveBeenCalledWith(1);
    expect(scheduleJobRetry).not.toHaveBeenCalled();
    expect(markJobFailed).not.toHaveBeenCalled();
    expect(state.igBusy).toBe(false);
  });

  it('IG job fails and handleFailure itself throws (DB unreachable) → does not produce an unhandled rejection, onSettle still runs', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(IG_JOB);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    vi.mocked(scheduleJobRetry).mockRejectedValue(new Error('DB unreachable'));

    const state = createInitialWorkerState();
    await tick(state);
    await flush();
    await flush();

    // If handleFailure's own throw escaped dispatch(), it would surface as an
    // unhandled promise rejection and Vitest would fail this test automatically.
    // Reaching these assertions with onSettle having run is sufficient evidence.
    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 1, expect.any(Date));
    expect(state.igBusy).toBe(false);
  });
});

describe('notify flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ success: true, entryId: 'e1', entry: {} }),
    }));
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
  });

  it('sends a Telegram message for a normal job', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(IG_JOB);
    await tick(createInitialWorkerState());
    await flush();
    expect(sendTelegramMessage).toHaveBeenCalled();
  });

  // A repair run re-queues content submitted days ago; notifying would spam.
  it('stays silent when the job opted out', async () => {
    vi.mocked(claimNextInstagramJob).mockResolvedValue({ ...IG_JOB, notify: false });
    await tick(createInitialWorkerState());
    await flush();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});

describe('reanalyze flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ success: true, entryId: 'e1', entry: {} }),
    }));
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
  });

  async function analyzeBody(job: JobQueueRow): Promise<Record<string, unknown>> {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(job);
    await tick(createInitialWorkerState());
    await flush();
    const call = vi.mocked(fetch).mock.calls[0];
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  }

  it('does not ask for a re-analysis on an ordinary job', async () => {
    expect((await analyzeBody(IG_JOB)).reanalyze).toBe(false);
  });

  // The regression this pins: inferring the flag from notify made every repair
  // run skip its download, and a repair exists precisely because the download
  // failed. Silence and "media already on disk" are unrelated properties.
  it('leaves a silent repair free to download', async () => {
    expect((await analyzeBody({ ...IG_JOB, notify: false })).reanalyze).toBe(false);
  });

  it('asks for a re-analysis only when the job carries the flag', async () => {
    expect((await analyzeBody({ ...IG_JOB, notify: false, reanalyze: true })).reanalyze).toBe(true);
  });
});

describe('dispatchTranscribe', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // vi.doMock('fs', ...) below persists past its own test (resetModules()
    // clears the module cache, not the mock registrations) — unmock it here
    // so a later test in this file can't silently inherit the ENOENT stub.
    vi.doUnmock('fs');
  });

  it('reschedules without burning an attempt when whisper is unreachable', async () => {
    const scheduleJobRetry = vi.fn();
    const transcribeLocal = vi.fn();
    vi.doMock('../utils/jobQueue', () => ({
      scheduleJobRetry, markJobDone: vi.fn(), markJobFailed: vi.fn(),
      enqueueJob: vi.fn(), claimNextTranscribeJob: vi.fn(),
      claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    vi.doMock('./whisperClient', () => ({
      isWhisperReachable: vi.fn(async () => false),
      transcribeLocal,
    }));

    const { dispatchTranscribe, TRANSCRIBE_RETRY_MS } = await import('./jobQueueWorker');
    const job = { id: 7, entryId: 'e1', attempts: 2 } as never;
    await dispatchTranscribe(job);

    expect(transcribeLocal).not.toHaveBeenCalled();
    expect(scheduleJobRetry).toHaveBeenCalledTimes(1);
    // attempts unchanged — an absent service is not a failure
    expect(scheduleJobRetry.mock.calls[0][1]).toBe(2);
    const when = scheduleJobRetry.mock.calls[0][2] as Date;
    expect(when.getTime()).toBeGreaterThan(Date.now() + TRANSCRIBE_RETRY_MS - 5_000);
  });

  it('fails without retrying when the audio file is gone', async () => {
    const markJobFailed = vi.fn();
    const scheduleJobRetry = vi.fn();
    const appendActionLog = vi.fn();
    vi.doMock('../utils/jobQueue', () => ({
      scheduleJobRetry, markJobDone: vi.fn(), markJobFailed,
      enqueueJob: vi.fn(), claimNextTranscribeJob: vi.fn(),
      claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    vi.doMock('./whisperClient', () => ({
      isWhisperReachable: vi.fn(async () => true),
      transcribeLocal: vi.fn(),
    }));
    // ../utils/db builds a real pg Pool at module load; leaving it unmocked
    // makes appendActionLog attempt a real connection (repo convention is to
    // always mock it — see songPersistence.test.ts, filmMeta.test.ts,
    // telegram.test.ts).
    vi.doMock('../utils/db', () => ({
      updateEntry: vi.fn(),
      appendActionLog,
    }));
    vi.doMock('../utils/logger', () => ({
      createActionLog: vi.fn((action: string, details: Record<string, unknown>) => ({
        action, details, timestamp: 'test',
      })),
    }));
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return { ...actual, promises: { ...actual.promises, access: vi.fn(async () => { throw new Error('ENOENT'); }) } };
    });

    const { dispatchTranscribe } = await import('./jobQueueWorker');
    await dispatchTranscribe({ id: 8, entryId: 'gone', attempts: 0 } as never);

    expect(markJobFailed).toHaveBeenCalledWith(8);
    expect(scheduleJobRetry).not.toHaveBeenCalled();
    // The journal UI reads the entry's action_log, not container stdout — a
    // silently swallowed "why did this never transcribe?" is unanswerable
    // for the user otherwise.
    expect(appendActionLog).toHaveBeenCalledWith('gone', expect.objectContaining({
      action: 'whisper_asr',
      details: expect.objectContaining({ status: 'error', reason: 'audio file missing' }),
    }));
  });

  it('persists the transcript and detected language, then re-enqueues analysis', async () => {
    const updateEntry = vi.fn();
    const enqueueJob = vi.fn();
    const markJobDone = vi.fn();
    vi.doMock('../utils/jobQueue', () => ({
      scheduleJobRetry: vi.fn(), markJobDone, markJobFailed: vi.fn(),
      enqueueJob, claimNextTranscribeJob: vi.fn(),
      claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    vi.doMock('./whisperClient', () => ({
      isWhisperReachable: vi.fn(async () => true),
      transcribeLocal: vi.fn(async () => ({
        text: 'ciao mondo', language: 'it', durationMs: 1234, status: 'ok',
      })),
    }));
    vi.doMock('../utils/db', () => ({
      updateEntry,
      appendActionLog: vi.fn(),
    }));
    vi.doMock('../utils/logger', () => ({
      createActionLog: vi.fn((action: string, details: Record<string, unknown>) => ({
        action, details, timestamp: 'test',
      })),
    }));
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return { ...actual, promises: { ...actual.promises, access: vi.fn(async () => undefined) } };
    });

    const { dispatchTranscribe } = await import('./jobQueueWorker');
    const job = {
      id: 9, entryId: 'e9', attempts: 0, sourceUrl: 'https://x', platform: 'other',
      chatId: 1, inputUser: null, priority: 0,
    } as never;
    await dispatchTranscribe(job);

    // Two separate updateEntry calls, not one with both dotted keys: the real
    // updateEntry rewrites each 'results.*' key into its own
    // `results = jsonb_set(...)` SET clause, and Postgres rejects an UPDATE
    // that assigns the same column twice.
    expect(updateEntry).toHaveBeenCalledWith('e9', { 'results.transcript': 'ciao mondo' });
    expect(updateEntry).toHaveBeenCalledWith('e9', { 'results.transcriptLanguage': 'it' });
    // reanalyze: true is set here and nowhere else — it is what tells the
    // route the media is already on disk and nothing may be fetched.
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      entryId: 'e9', kind: 'analyze', notify: false, reanalyze: true,
    }));
    expect(markJobDone).toHaveBeenCalledWith(9);
  });

  it('routes an unexpected failure (e.g. DB down) through handleFailure so the job is not stranded', async () => {
    const scheduleJobRetry = vi.fn();
    const markJobFailed = vi.fn();
    vi.doMock('../utils/jobQueue', () => ({
      scheduleJobRetry, markJobDone: vi.fn(), markJobFailed,
      enqueueJob: vi.fn(), claimNextTranscribeJob: vi.fn(),
      claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    vi.doMock('./whisperClient', () => ({
      isWhisperReachable: vi.fn(async () => true),
      transcribeLocal: vi.fn(async () => ({
        text: 'hi', language: 'en', durationMs: 5, status: 'ok',
      })),
    }));
    vi.doMock('../utils/db', () => ({
      updateEntry: vi.fn(),
      // Simulates the DB going away while recording the ASR result — the
      // scenario the outer catch in dispatchTranscribe exists for.
      appendActionLog: vi.fn(async () => { throw new Error('DB unreachable'); }),
    }));
    vi.doMock('../utils/logger', () => ({
      createActionLog: vi.fn((action: string, details: Record<string, unknown>) => ({
        action, details, timestamp: 'test',
      })),
    }));
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return { ...actual, promises: { ...actual.promises, access: vi.fn(async () => undefined) } };
    });

    const { dispatchTranscribe } = await import('./jobQueueWorker');
    const job = {
      id: 10, entryId: 'e10', attempts: 0, sourceUrl: 'https://x', platform: 'other',
      chatId: 1, inputUser: null, priority: 0,
    } as never;

    // If the outer catch only logged (as it did before this fix), the job
    // would be left at status='processing' with no retry scheduled —
    // recoverable only by requeueStuckJobs() at the next server boot.
    // Reaching scheduleJobRetry is evidence handleFailure ran instead.
    await dispatchTranscribe(job);

    expect(scheduleJobRetry).toHaveBeenCalledWith(10, 1, expect.any(Date));
    expect(markJobFailed).not.toHaveBeenCalled();
  });
});
