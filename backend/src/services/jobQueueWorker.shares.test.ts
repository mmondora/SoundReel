import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./ollamaClient', () => ({ releaseModel: vi.fn().mockResolvedValue({ released: true }) }));
vi.mock('../routes/telegram', () => ({
  sendTelegramMessage: vi.fn(),
  formatAnalysisError: vi.fn().mockReturnValue('error-text'),
  formatTelegramResponse: vi.fn().mockResolvedValue('ok-text'),
}));
vi.mock('./debugLogger', () => ({
  Logger: class {
    startTimer = vi.fn(); debug = vi.fn(); info = vi.fn(); warn = vi.fn(); error = vi.fn(); endTimer = vi.fn();
  },
}));
vi.mock('./shareFlow', () => ({
  onAnalysisFinished: vi.fn().mockResolvedValue(undefined),
  onAnalysisRetrying: vi.fn().mockResolvedValue(undefined),
}));

import { AI_RETRY_MAX_ATTEMPTS, createInitialWorkerState, tick } from './jobQueueWorker';
import { claimNextInstagramJob, claimNextOtherJob, markJobDone, markJobFailed, scheduleAiRetry, scheduleJobRetry, type JobQueueRow } from '../utils/jobQueue';
import { onAnalysisFinished, onAnalysisRetrying } from './shareFlow';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// A Mondrop share is silent on Telegram (notify=false, chat 0): the inbox is its channel.
const JOB: JobQueueRow = {
  id: 7, entryId: 'e1', sourceUrl: 'https://www.instagram.com/reel/x', platform: 'instagram',
  chatId: 0, inputUser: 'mike', status: 'processing', attempts: 0,
  nextAttemptAt: '', createdAt: '', updatedAt: '', notify: false,
  kind: 'analyze', priority: 0, reanalyze: false, skipAi: false,
};

async function run(job: JobQueueRow, answer: () => Promise<unknown> | unknown): Promise<void> {
  vi.mocked(claimNextInstagramJob).mockResolvedValue(job);
  vi.mocked(claimNextOtherJob).mockResolvedValue(null);
  vi.mocked(fetch).mockImplementation((async () => answer()) as never);
  await tick(createInitialWorkerState());
  await flush();
}

const ok = (body: Record<string, unknown>, status = 200) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('the worker completes the Mondrop shares waiting on an entry', () => {
  it('a good analysis completes them', async () => {
    await run(JOB, () => ok({ success: true, entryId: 'e1', entry: { results: {} } }));
    expect(markJobDone).toHaveBeenCalledWith(7);
    expect(onAnalysisFinished).toHaveBeenCalledWith('e1', { ok: true });
  });

  it('only after the job is marked done, and even when Telegram has nothing to say', async () => {
    const order: string[] = [];
    vi.mocked(markJobDone).mockImplementation(async () => { order.push('done'); });
    vi.mocked(onAnalysisFinished).mockImplementation(async () => { order.push('shares'); });
    await run(JOB, () => ok({ success: true, entryId: 'e1', entry: { results: {} } }));
    expect(order).toEqual(['done', 'shares']);
  });

  it('an analysis that answered success:false becomes an error for the sender', async () => {
    await run(JOB, () => ok({ success: false, entryId: 'e1', error: 'page_pipeline_failed' }));
    expect(onAnalysisFinished).toHaveBeenCalledWith('e1', { ok: false, reason: 'analysis_failed' });
  });

  it('...and one naming an expired Instagram session says so', async () => {
    await run(JOB, () => ok({ success: false, entryId: 'e1', error: 'challenge_required' }));
    expect(onAnalysisFinished).toHaveBeenCalledWith('e1', { ok: false, reason: 'instagram_session' });
  });

  it('an AI that never gave a readable answer (retries exhausted) fails the share instead of leaving it empty', async () => {
    await run({ ...JOB, attempts: AI_RETRY_MAX_ATTEMPTS }, () => ok({ success: true, entryId: 'e1', aiRetryable: true, entry: { results: {} } }));
    expect(markJobDone).toHaveBeenCalledWith(7);
    expect(onAnalysisFinished).toHaveBeenCalledWith('e1', { ok: false, reason: 'ai_output_unusable' });
  });

  it('an AI answer that will be retried does not complete or fail anything yet', async () => {
    await run(JOB, () => ok({ success: true, entryId: 'e1', aiRetryable: true, entry: { results: {} } }));
    expect(scheduleAiRetry).toHaveBeenCalled();
    expect(markJobDone).not.toHaveBeenCalled();
    expect(onAnalysisFinished).not.toHaveBeenCalled();
  });

  it('a share-flow failure never turns a finished job into a failed one', async () => {
    vi.mocked(onAnalysisFinished).mockRejectedValueOnce(new Error('inbox down'));
    await run(JOB, () => ok({ success: true, entryId: 'e1', entry: { results: {} } }));
    expect(markJobDone).toHaveBeenCalledWith(7);
    expect(markJobFailed).not.toHaveBeenCalled();
    expect(scheduleJobRetry).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('a job that gives up fails the share, with the reason', async () => {
    await run({ ...JOB, attempts: 3 }, () => { throw new Error('ECONNREFUSED'); });
    expect(markJobFailed).toHaveBeenCalledWith(7);
    expect(onAnalysisFinished).toHaveBeenCalledWith('e1', { ok: false, reason: 'analysis_failed' });
  });

  it('...an expired Instagram session as such', async () => {
    await run({ ...JOB, attempts: 10 }, () => ok({ success: false, error: 'challenge_required' }, 502));
    expect(markJobFailed).toHaveBeenCalledWith(7);
    expect(onAnalysisFinished).toHaveBeenCalledWith('e1', { ok: false, reason: 'instagram_session' });
  });

  it('an ordinary failure with retries left tells nobody', async () => {
    await run(JOB, () => { throw new Error('ECONNREFUSED'); });
    expect(scheduleJobRetry).toHaveBeenCalled();
    expect(onAnalysisFinished).not.toHaveBeenCalled();
    expect(onAnalysisRetrying).not.toHaveBeenCalled();
  });

  it('the first expired-session failure tells the sender once, even with Telegram off (the server keeps trying)', async () => {
    await run(JOB, () => ok({ success: false, error: 'challenge_required' }, 502));
    expect(scheduleJobRetry).toHaveBeenCalled();
    expect(onAnalysisRetrying).toHaveBeenCalledWith('e1', 'instagram_session');
    expect(onAnalysisFinished).not.toHaveBeenCalled();
  });

  it('the later expired-session retries stay quiet: one notice is enough', async () => {
    await run({ ...JOB, attempts: 1 }, () => ok({ success: false, error: 'challenge_required' }, 502));
    expect(scheduleJobRetry).toHaveBeenCalled();
    expect(onAnalysisRetrying).not.toHaveBeenCalled();
  });
});
