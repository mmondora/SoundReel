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
vi.mock('./autoPlaylistWiring', () => ({ onEntryAnalyzed: vi.fn().mockResolvedValue(null) }));
vi.mock('./collectionsWiring', () => ({ onEntryAnalyzedForCollections: vi.fn().mockResolvedValue(undefined) }));

import { createInitialWorkerState, tick } from './jobQueueWorker';
import { claimNextInstagramJob, claimNextOtherJob, markJobDone, type JobQueueRow } from '../utils/jobQueue';
import { onEntryAnalyzedForCollections } from './collectionsWiring';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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

describe('a post gets its vector, places and venues for the collections (ADR-0022): the worker only says «this entry is analysed»', () => {
  it('a good analysis asks for the inputs of the collections of that entry, once, after the job is done', async () => {
    const order: string[] = [];
    vi.mocked(markJobDone).mockImplementation(async () => { order.push('done'); });
    vi.mocked(onEntryAnalyzedForCollections).mockImplementation((async () => { order.push('collections'); }) as never);
    await run(JOB, () => ok({ success: true, entryId: 'e1', entry: { results: {} } }));
    expect(onEntryAnalyzedForCollections).toHaveBeenCalledTimes(1);
    expect(onEntryAnalyzedForCollections).toHaveBeenCalledWith('e1');
    expect(order).toEqual(['done', 'collections']);
  });

  it('an analysis that failed asks for nothing', async () => {
    await run(JOB, () => ok({ success: false, entryId: 'e1', error: 'page_pipeline_failed' }));
    expect(onEntryAnalyzedForCollections).not.toHaveBeenCalled();
  });

  it('an AI answer that will be retried asks for nothing yet', async () => {
    await run(JOB, () => ok({ success: true, entryId: 'e1', aiRetryable: true, entry: { results: {} } }));
    expect(onEntryAnalyzedForCollections).not.toHaveBeenCalled();
  });

  it('the worker does not WAIT for the vector or the places: a model that never answers does not hold the job, nor the Instagram slot', async () => {
    vi.mocked(onEntryAnalyzedForCollections).mockImplementation((() => new Promise(() => undefined)) as never);
    const state = createInitialWorkerState();
    vi.mocked(claimNextInstagramJob).mockResolvedValue(JOB);
    vi.mocked(claimNextOtherJob).mockResolvedValue(null);
    vi.mocked(fetch).mockImplementation((async () => ok({ success: true, entryId: 'e1', entry: { results: {} } })) as never);
    await tick(state);
    await flush();
    expect(markJobDone).toHaveBeenCalledWith(7);
    expect(onEntryAnalyzedForCollections).toHaveBeenCalledTimes(1);
    // the slot is free again: the next post is not held back by a reading that is still on its way
    expect(state.igBusy).toBe(false);
  });
});
