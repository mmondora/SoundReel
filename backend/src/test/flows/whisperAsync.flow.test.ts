import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHarness, installHarness, resetHarness, type Harness } from '../harness';

const WHISPER = 'http://whisper.test:9000';

describe('flusso whisper asincrono', () => {
  let h: Harness;

  beforeEach(() => {
    vi.resetModules();
    h = createHarness();
    vi.stubEnv('WHISPER_URL', WHISPER);
    vi.stubEnv('MEDIA_ROOT', '/data/media');
  });

  afterEach(() => {
    // resetModules() (above) clears the instantiated-module cache but not
    // vi.doMock's registered factories, which live for the worker process's
    // whole run, not per file — leaving these registered would let a later
    // test file that dynamically imports the same module inherit this test's
    // (by-then-stale) fakes instead of its own. See resetHarness's doc for how
    // this was confirmed (`vitest run --no-isolate` reproduces cross-file
    // bleed without it).
    resetHarness();
    vi.doUnmock('../../utils/jobQueue');
    vi.unstubAllEnvs();
  });

  it('con whisper spento rimanda senza consumare tentativi', async () => {
    h.whisperUp = false;
    h.addEntry('e1');
    h.audioPresent.add('e1');
    const job = h.addJob({ entryId: 'e1', kind: 'transcribe', attempts: 2 });

    const scheduled: Array<{ attempts: number; when: Date }> = [];
    vi.doMock('../../utils/jobQueue', () => ({
      scheduleJobRetry: vi.fn(async (_id: number, attempts: number, when: Date) => {
        scheduled.push({ attempts, when });
      }),
      markJobDone: vi.fn(), markJobFailed: vi.fn(), enqueueJob: vi.fn(),
      claimNextTranscribeJob: vi.fn(), claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    installHarness(h);

    const { dispatchTranscribe, TRANSCRIBE_RETRY_MS } = await import('../../services/jobQueueWorker');
    await dispatchTranscribe(job as never);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].attempts).toBe(2);
    expect(scheduled[0].when.getTime()).toBeGreaterThan(Date.now() + TRANSCRIBE_RETRY_MS - 5_000);
    expect(h.calls.whisperTranscribe).toHaveLength(0);
    expect(h.calls.analyze).toHaveLength(0);
  });

  it('con whisper acceso trascrive e accoda una seconda passata silenziosa', async () => {
    h.whisperUp = true;
    h.addEntry('e2');
    h.audioPresent.add('e2');
    const job = h.addJob({ entryId: 'e2', kind: 'transcribe' });

    const enqueued: Array<Record<string, unknown>> = [];
    vi.doMock('../../utils/jobQueue', () => ({
      scheduleJobRetry: vi.fn(), markJobDone: vi.fn(), markJobFailed: vi.fn(),
      enqueueJob: vi.fn(async (j: Record<string, unknown>) => { enqueued.push(j); return 99; }),
      claimNextTranscribeJob: vi.fn(), claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    installHarness(h);

    const { dispatchTranscribe } = await import('../../services/jobQueueWorker');
    await dispatchTranscribe(job as never);

    expect(h.entries.get('e2')?.results.transcript).toBe('testo trascritto');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].kind).toBe('analyze');
    expect(enqueued[0].notify).toBe(false);
  });

  it('senza audio sul disco fallisce senza riprovare', async () => {
    h.whisperUp = true;
    h.addEntry('e3');
    const job = h.addJob({ entryId: 'e3', kind: 'transcribe' });

    const failed: number[] = [];
    const retried: number[] = [];
    vi.doMock('../../utils/jobQueue', () => ({
      scheduleJobRetry: vi.fn(async (id: number) => { retried.push(id); }),
      markJobDone: vi.fn(), markJobFailed: vi.fn(async (id: number) => { failed.push(id); }),
      enqueueJob: vi.fn(),
      claimNextTranscribeJob: vi.fn(), claimNextInstagramJob: vi.fn(), claimNextOtherJob: vi.fn(),
    }));
    installHarness(h);

    const { dispatchTranscribe } = await import('../../services/jobQueueWorker');
    await dispatchTranscribe(job as never);

    expect(failed).toEqual([job.id]);
    expect(retried).toEqual([]);
    const log = h.entries.get('e3')?.actionLog ?? [];
    expect(log.some((l) => l.action === 'whisper_asr' && l.details.reason === 'audio file missing')).toBe(true);
  });

  it('la seconda passata fonde e non perde canzoni gia trovate', async () => {
    const { mergeEntryResults } = await import('../../services/entryMerge');
    const existing = {
      songs: [{ title: 'Roma', artist: 'Baustelle', album: null }],
      films: [], notes: [], links: [], tags: [], summary: 'riassunto originale',
    };
    const incoming = {
      songs: [], films: [], notes: [], links: [], tags: [],
      summary: 'riassunto nuovo', transcript: 'testo',
    };
    const out = mergeEntryResults(existing as never, incoming as never);

    expect(out.songs).toHaveLength(1);
    expect(out.summary).toBe('riassunto originale');
    expect(out.transcript).toBe('testo');
  });
});
