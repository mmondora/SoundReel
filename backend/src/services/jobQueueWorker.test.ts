import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/jobQueue', () => ({
  claimNextInstagramJob: vi.fn(),
  claimNextOtherJob: vi.fn(),
  claimNextReanalyzeJob: vi.fn(),
  claimNextTranscribeJob: vi.fn(),
  enqueueJob: vi.fn(),
  markJobDone: vi.fn(),
  markJobFailed: vi.fn(),
  scheduleJobRetry: vi.fn(),
  scheduleAiRetry: vi.fn(),
}));

vi.mock('./ollamaClient', () => ({
  releaseModel: vi.fn().mockResolvedValue({ released: true }),
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
  computeAuthBackoffMs,
  isAuthFailure,
  AI_RETRY_MAX_ATTEMPTS,
  tick,
  createInitialWorkerState,
} from './jobQueueWorker';
import {
  claimNextInstagramJob,
  claimNextOtherJob,
  claimNextReanalyzeJob,
  claimNextTranscribeJob,
  markJobDone,
  markJobFailed,
  scheduleJobRetry,
  scheduleAiRetry,
  type JobQueueRow,
} from '../utils/jobQueue';
import { releaseModel } from './ollamaClient';
import { sendTelegramMessage, formatAnalysisError } from '../routes/telegram';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const IG_JOB: JobQueueRow = {
  id: 1, entryId: 'e1', sourceUrl: 'https://instagram.com/reel/x', platform: 'instagram',
  chatId: 42, inputUser: '@mike', status: 'processing', attempts: 0,
  nextAttemptAt: '', createdAt: '', updatedAt: '', notify: true,
  kind: 'analyze', priority: 0, reanalyze: false, skipAi: false,
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

  // The route used to find the entry by re-normalising this URL. 183 of the
  // 882 stored source_urls predate the current normaliser and do not survive
  // that round trip, so their second pass 404'd after the transcript had
  // already been written. The job knows the id; send it.
  it('carries the entry id so the route never re-derives it from the URL', async () => {
    expect((await analyzeBody({ ...IG_JOB, reanalyze: true })).entryId).toBe('e1');
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

  it('defers without burning an attempt when the router answers 503', async () => {
    const scheduleJobRetry = vi.fn();
    const markJobFailed = vi.fn();
    const appendActionLog = vi.fn();
    vi.doMock('../utils/jobQueue', () => ({
      scheduleJobRetry, markJobDone: vi.fn(), markJobFailed,
      enqueueJob: vi.fn(), claimNextTranscribeJob: vi.fn(),
      claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    vi.doMock('./whisperClient', () => ({
      isWhisperReachable: vi.fn(async () => true),
      transcribeLocal: vi.fn(async () => ({
        text: null, language: null, durationMs: 12, status: 'error',
        reason: 'HTTP 503', httpStatus: 503,
      })),
    }));
    vi.doMock('../utils/db', () => ({ updateEntry: vi.fn(), appendActionLog }));
    vi.doMock('../utils/logger', () => ({
      createActionLog: vi.fn((action: string, details: Record<string, unknown>) => ({
        action, details, timestamp: 'test',
      })),
    }));
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return { ...actual, promises: { ...actual.promises, access: vi.fn(async () => undefined) } };
    });

    const { dispatchTranscribe, TRANSCRIBE_RETRY_MS } = await import('./jobQueueWorker');
    // attempts: 1 — one short of markJobFailed under OTHER_BACKOFF_MS, which
    // is a single 60s retry. Routed through handleFailure this 503 would end
    // the job permanently and lose the transcript.
    const job = {
      id: 11, entryId: 'e11', attempts: 1, sourceUrl: 'https://x', platform: 'other',
      chatId: 1, inputUser: null, priority: 0,
    } as never;
    await dispatchTranscribe(job);

    expect(markJobFailed).not.toHaveBeenCalled();
    expect(scheduleJobRetry).toHaveBeenCalledTimes(1);
    // attempts unchanged: no capacity right now is not a failure of this audio
    expect(scheduleJobRetry.mock.calls[0][1]).toBe(1);
    const when = scheduleJobRetry.mock.calls[0][2] as Date;
    expect(when.getTime()).toBeGreaterThan(Date.now() + TRANSCRIBE_RETRY_MS - 5_000);
    // The 503 is still on the record — a silent slip is unexplainable later.
    expect(appendActionLog).toHaveBeenCalledWith('e11', expect.objectContaining({
      action: 'whisper_asr',
      details: expect.objectContaining({ status: 'error', reason: 'HTTP 503' }),
    }));
  });

  it('still fails the job on a non-503 whisper error', async () => {
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
        text: null, language: null, durationMs: 12, status: 'error',
        reason: 'HTTP 500', httpStatus: 500,
      })),
    }));
    vi.doMock('../utils/db', () => ({ updateEntry: vi.fn(), appendActionLog: vi.fn() }));
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
      id: 12, entryId: 'e12', attempts: 1, sourceUrl: 'https://x', platform: 'other',
      chatId: 1, inputUser: null, priority: 0,
    } as never;
    await dispatchTranscribe(job);

    // Unchanged behaviour: a service that answered and then failed for any
    // other reason is a real failure, and the backoff table ends it.
    expect(markJobFailed).toHaveBeenCalledWith(12);
    expect(scheduleJobRetry).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Instagram session expiry
//
// The bug these pin: the analyze route used to answer a failed Instagram
// download with HTTP 200 and `success: false`, so the worker saw `res.ok`,
// called markJobDone(), sent the "renew the session" warning — and never
// touched the job again. The user got one message and then permanent silence,
// even after re-seeding the session hours later.
// ---------------------------------------------------------------------------
describe('isAuthFailure', () => {
  it.each([
    'both iphone_api and graphql failed: challenge_required',
    'login required; seed session via `instaloader -l <user>`',
    'login_required',
    'checkpoint_required',
    'HTTP 403',
    '401 Unauthorized',
  ])('%s → auth failure', (err) => {
    expect(isAuthFailure(err)).toBe(true);
  });

  it.each([
    'timeout',
    'not found',
    'ECONNREFUSED',
    'INSTALOADER_URL not set',
    // A bare number inside a longer token must not read as a status code.
    'download failed for shortcode DC401xyz',
  ])('%s → ordinary failure', (err) => {
    expect(isAuthFailure(err)).toBe(false);
  });
});

describe('computeAuthBackoffMs', () => {
  it('first attempt waits 30 minutes, not 60 seconds', () => {
    expect(computeAuthBackoffMs(1)).toBe(30 * 60_000);
  });
  it('escalates to 2h then 6h', () => {
    expect(computeAuthBackoffMs(2)).toBe(2 * 3_600_000);
    expect(computeAuthBackoffMs(3)).toBe(6 * 3_600_000);
  });
  // A session renewed on day three must still find the job alive; the ordinary
  // Instagram table is exhausted eleven minutes in.
  it('settles into a daily knock past the escalation', () => {
    expect(computeAuthBackoffMs(4)).toBe(24 * 3_600_000);
    expect(computeAuthBackoffMs(10)).toBe(24 * 3_600_000);
  });
  it('gives up after ten attempts (~8 days)', () => {
    expect(computeAuthBackoffMs(11)).toBeNull();
  });
});

describe('auth failures through the queue', () => {
  const AUTH_ERROR = 'both iphone_api and graphql failed: challenge_required';

  function analyzeReplies(status: number, body: Record<string, unknown>): void {
    vi.mocked(fetch).mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as never);
  }

  async function runIgJob(job: Partial<JobQueueRow>): Promise<void> {
    vi.mocked(claimNextInstagramJob).mockResolvedValue({ ...IG_JOB, ...job } as JobQueueRow);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    await tick(createInitialWorkerState());
    await flush();
    await flush();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.mocked(claimNextTranscribeJob).mockResolvedValue(null);
  });

  it('a 502 naming challenge_required is a failure, not a completed job', async () => {
    analyzeReplies(502, { success: false, entryId: 'e1', error: AUTH_ERROR });
    await runIgJob({});

    expect(markJobDone).not.toHaveBeenCalled();
    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 1, expect.any(Date));
  });

  it('waits 30 minutes before the first auth retry', async () => {
    analyzeReplies(502, { success: false, entryId: 'e1', error: AUTH_ERROR });
    await runIgJob({});

    const when = vi.mocked(scheduleJobRetry).mock.calls[0][2] as Date;
    expect(when.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
  });

  it('tells the user once, on the first auth failure', async () => {
    analyzeReplies(502, { success: false, entryId: 'e1', error: AUTH_ERROR });
    await runIgJob({ attempts: 0 });

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(formatAnalysisError).toHaveBeenCalledWith(
      expect.objectContaining({ error: AUTH_ERROR, entryId: 'e1' }),
      { willRetry: true }
    );
  });

  // Retries are hours apart; repeating "renew the session" every few hours is
  // noise. The next thing the user hears is the entry going through.
  it('stays silent on the retries that follow', async () => {
    analyzeReplies(502, { success: false, entryId: 'e1', error: AUTH_ERROR });
    await runIgJob({ attempts: 2 });

    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 3, expect.any(Date));
  });

  it('survives far past the 3-attempt ceiling that kills an ordinary failure', async () => {
    analyzeReplies(502, { success: false, entryId: 'e1', error: AUTH_ERROR });
    await runIgJob({ attempts: 6 });

    expect(markJobFailed).not.toHaveBeenCalled();
    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 7, expect.any(Date));
  });

  it('gives up once the auth attempts are exhausted', async () => {
    analyzeReplies(502, { success: false, entryId: 'e1', error: AUTH_ERROR });
    await runIgJob({ attempts: 10 });

    expect(markJobFailed).toHaveBeenCalledWith(1);
    expect(scheduleJobRetry).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalled();
  });

  // An expired session must not stretch every unrelated failure to 30 minutes.
  it('leaves an ordinary download failure on the short backoff', async () => {
    analyzeReplies(502, { success: false, entryId: 'e1', error: 'timeout' });
    await runIgJob({});

    const when = vi.mocked(scheduleJobRetry).mock.calls[0][2] as Date;
    expect(when.getTime()).toBeLessThan(Date.now() + 120_000);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  // The message the user actually waits for: the run that finally works.
  it('sends the result when a later retry succeeds', async () => {
    analyzeReplies(200, {
      success: true,
      entryId: 'e1',
      entry: { results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null } },
    });
    await runIgJob({ attempts: 4 });

    expect(markJobDone).toHaveBeenCalledWith(1);
    expect(sendTelegramMessage).toHaveBeenCalledWith(42, 'ok-text', expect.any(String));
  });

  // A Telegram outage must not cost the job its retry: the row would stay at
  // status='processing' until the next server boot.
  it('still schedules the retry when the warning cannot be delivered', async () => {
    analyzeReplies(502, { success: false, entryId: 'e1', error: AUTH_ERROR });
    vi.mocked(sendTelegramMessage).mockRejectedValue(new Error('ETELEGRAM'));
    await runIgJob({});

    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 1, expect.any(Date));
  });
});

// ---------------------------------------------------------------------------
// Batched AI pass
//
// ollama keeps a single model resident (MAX_LOADED_MODELS=1, KEEP_ALIVE=90s)
// and every analysis uses two — moondream on the frames, then qwen on the
// text. A repair batch spaced by tens of minutes (the spacing exists so
// Instagram does not challenge the account) therefore means one GPU wake-up
// and two model swaps per job: the queue teardown that hangs this APU.
//
// So the download pass makes no ollama call at all, and the analysis runs
// afterwards in one hot, strictly serial batch.
// ---------------------------------------------------------------------------
describe('deferred AI pass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, entryId: 'e1', entry: {} }),
    }));
    vi.mocked(claimNextInstagramJob).mockResolvedValue(null);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(claimNextReanalyzeJob).mockResolvedValue(null);
    vi.mocked(claimNextTranscribeJob).mockResolvedValue(null);
  });

  async function analyzeBodyFor(job: JobQueueRow): Promise<Record<string, unknown>> {
    vi.mocked(claimNextInstagramJob).mockResolvedValue(job);
    await tick(createInitialWorkerState());
    await flush();
    const call = vi.mocked(fetch).mock.calls[0];
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  }

  it('an ordinary job analyses inline', async () => {
    expect((await analyzeBodyFor(IG_JOB)).skipAi).toBe(false);
  });

  it('a download-only job tells the route to make no ollama call', async () => {
    expect((await analyzeBodyFor({ ...IG_JOB, skipAi: true })).skipAi).toBe(true);
  });

  // Silence and "skip the analysis" are unrelated properties — conflating them
  // is the mistake already made once with `reanalyze` (see migration 010).
  it('does not infer the skip from a silent repair job', async () => {
    expect((await analyzeBodyFor({ ...IG_JOB, notify: false })).skipAi).toBe(false);
  });

  it('runs one re-analysis at a time', async () => {
    const running = { ...IG_JOB, id: 9, reanalyze: true };
    vi.mocked(claimNextReanalyzeJob).mockResolvedValue(running as JobQueueRow);
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {})); // never settles

    const state = createInitialWorkerState();
    await tick(state);
    expect(state.reanalyzeBusy).toBe(true);

    // A second tick while the first is still in flight must not claim another:
    // two concurrent passes would swap the model in and out between calls.
    await tick(state);
    expect(claimNextReanalyzeJob).toHaveBeenCalledTimes(1);
  });

  // No jitter window either: the gap is what lets ollama unload the model.
  it('takes the next one immediately, with no cooling-off window', async () => {
    vi.mocked(claimNextReanalyzeJob).mockResolvedValue({ ...IG_JOB, id: 9, reanalyze: true } as JobQueueRow);

    const state = createInitialWorkerState();
    await tick(state);
    await flush();

    expect(state.reanalyzeBusy).toBe(false);
    expect(state.igNextAllowedAt).toBe(0);
  });

  it('leaves the lane free when there is nothing to re-analyse', async () => {
    const state = createInitialWorkerState();
    await tick(state);
    expect(state.reanalyzeBusy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Entry occupata
//
// Il 2026-09-15 tre job su cinque sono finiti `failed` su entry che intanto si
// completavano da sole. La catena: il default di undici (headersTimeout 300s)
// chiudeva la fetch dopo cinque minuti mentre la passata dentro il server ne
// stava macinando dodici (vision per slide, con ollama lento); il worker
// leggeva "fetch failed", riprovava, e il retry sbatteva sul lucchetto della
// *propria* passata ancora viva. Tre 409 di fila, tentativi esauriti, job
// morto — mentre l'analisi vera arrivava in fondo benissimo.
// ---------------------------------------------------------------------------
describe('entry occupata (409)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(claimNextReanalyzeJob).mockResolvedValue(null);
    vi.mocked(claimNextTranscribeJob).mockResolvedValue(null);
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, entryId: 'e1', error: 'analisi già in corso su questa entry' }),
    } as never);
  });

  async function runIgJob(job: Partial<JobQueueRow> = {}): Promise<void> {
    vi.mocked(claimNextInstagramJob).mockResolvedValue({ ...IG_JOB, ...job } as JobQueueRow);
    await tick(createInitialWorkerState());
    await flush();
    await flush();
  }

  it('non consuma un tentativo: non è un fallimento di questo job', async () => {
    await runIgJob({ attempts: 2 });
    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 2, expect.any(Date));
  });

  it('ribussa dopo qualche minuto, non dopo un minuto', async () => {
    await runIgJob();
    const when = vi.mocked(scheduleJobRetry).mock.calls[0][2] as Date;
    expect(when.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  // Il punto della regressione: con i tentativi esauriti il job moriva, e
  // nessuno rimetteva in coda l'entry.
  it('non muore nemmeno con i tentativi già esauriti', async () => {
    await runIgJob({ attempts: 9 });
    expect(markJobFailed).not.toHaveBeenCalled();
    expect(scheduleJobRetry).toHaveBeenCalled();
  });

  it('non manda nessun messaggio: non c\'è niente da raccontare', async () => {
    await runIgJob();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('non chiude il job come riuscito', async () => {
    await runIgJob();
    expect(markJobDone).not.toHaveBeenCalled();
  });

  // Un 409 è l'unico status che non conta: gli altri restano fallimenti veri.
  it('un 502 continua a bruciare un tentativo', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false, status: 502,
      json: async () => ({ success: false, entryId: 'e1', error: 'timeout' }),
    } as never);
    await runIgJob({ attempts: 1 });
    expect(scheduleJobRetry).toHaveBeenCalledWith(1, 2, expect.any(Date));
  });
});

describe('trasporto verso /api/analyze', () => {
  // La causa a monte: cinque minuti di headersTimeout su una pipeline che ne
  // dura venti. Il tetto lo decide la pipeline, non il trasporto.
  it('non impone un tetto di tempo alla risposta', async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, entryId: 'e1', entry: {} }),
    }));
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(claimNextReanalyzeJob).mockResolvedValue(null);
    vi.mocked(claimNextTranscribeJob).mockResolvedValue(null);
    vi.mocked(claimNextInstagramJob).mockResolvedValue(IG_JOB);

    await tick(createInitialWorkerState());
    await flush();

    const init = vi.mocked(fetch).mock.calls[0][1] as { dispatcher?: { [k: string]: unknown } };
    expect(init.dispatcher).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// spec-060: l'analisi AI fallita non chiude il job
//
// Il 15 settembre 49 entry su 81 sono uscite completate e vuote: l'estrazione
// era andata bene, le chiamate a ollama morivano in timeout, e il job si
// chiudeva `done`. Nessuno le riprendeva più.
// ---------------------------------------------------------------------------
describe('ripassata AI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(claimNextReanalyzeJob).mockResolvedValue(null);
    vi.mocked(claimNextTranscribeJob).mockResolvedValue(null);
  });

  function rispondi(body: Record<string, unknown>) {
    vi.mocked(fetch).mockResolvedValue({
      ok: true, status: 200, json: async () => body,
    } as never);
  }

  async function runIgJob(job: Partial<JobQueueRow> = {}): Promise<void> {
    vi.mocked(claimNextInstagramJob).mockResolvedValue({ ...IG_JOB, ...job } as JobQueueRow);
    await tick(createInitialWorkerState());
    await flush();
    await flush();
  }

  it('non chiude il job quando l\'AI è da ripassare', async () => {
    rispondi({ success: true, entryId: 'e1', entry: {}, aiRetryable: true });
    await runIgJob();
    expect(markJobDone).not.toHaveBeenCalled();
    expect(scheduleAiRetry).toHaveBeenCalledWith(1, 1, expect.any(Date));
  });

  // Ritentare l'intero job rifarebbe il download: su Instagram è esattamente
  // ciò che non si deve fare. La seconda passata lavora sui media già a terra.
  it('riaccoda come seconda passata, non come nuovo download', async () => {
    rispondi({ success: true, entryId: 'e1', entry: {}, aiRetryable: true });
    await runIgJob();
    expect(scheduleJobRetry).not.toHaveBeenCalled();
    const quando = vi.mocked(scheduleAiRetry).mock.calls[0][2] as Date;
    expect(quando.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('a un certo punto si arrende e chiude', async () => {
    rispondi({ success: true, entryId: 'e1', entry: {}, aiRetryable: true });
    await runIgJob({ attempts: AI_RETRY_MAX_ATTEMPTS });
    expect(scheduleAiRetry).not.toHaveBeenCalled();
    expect(markJobDone).toHaveBeenCalledWith(1);
  });

  // Un'analisi riuscita che non ha trovato nulla è un risultato, non un guasto.
  it('un job senza il flag si chiude normalmente', async () => {
    rispondi({ success: true, entryId: 'e1', entry: {} });
    await runIgJob();
    expect(markJobDone).toHaveBeenCalledWith(1);
    expect(scheduleAiRetry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// spec-060 (MAY): «ho finito con questo modello»
// ---------------------------------------------------------------------------
describe('release a fine passata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, entryId: 'e1', entry: {} }),
    }));
    vi.mocked(claimNextInstagramJob).mockResolvedValue(null);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(claimNextTranscribeJob).mockResolvedValue(null);
    vi.mocked(claimNextReanalyzeJob).mockResolvedValue(null);
  });

  it('non dice niente al router se non ha lavorato', async () => {
    await tick(createInitialWorkerState());
    await flush();
    expect(releaseModel).not.toHaveBeenCalled();
  });

  // Dopo il blocco, non dopo la singola richiesta: scaricare e ricaricare a
  // ogni chiamata è il ciclo che la corsia seriale esiste per evitare.
  it('non lo dice mentre il batch sta ancora girando', async () => {
    vi.mocked(claimNextReanalyzeJob).mockResolvedValue({ ...IG_JOB, reanalyze: true } as JobQueueRow);
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const state = createInitialWorkerState();
    await tick(state);
    await flush();
    expect(releaseModel).not.toHaveBeenCalled();
    expect(state.reanalyzeSinceIdle).toBe(1);
  });

  it('lo dice quando la corsia si svuota dopo aver lavorato', async () => {
    const state = createInitialWorkerState();
    state.reanalyzeSinceIdle = 7;
    await tick(state);
    await flush();
    expect(releaseModel).toHaveBeenCalledTimes(1);
    expect(state.reanalyzeSinceIdle).toBe(0);
  });

  it('non lo ripete a ogni giro a vuoto', async () => {
    const state = createInitialWorkerState();
    state.reanalyzeSinceIdle = 3;
    await tick(state);
    await flush();
    await tick(state);
    await flush();
    expect(releaseModel).toHaveBeenCalledTimes(1);
  });
});
