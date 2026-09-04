import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
const withClientMock = vi.fn();

vi.mock('./db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  withClient: (...args: unknown[]) => withClientMock(...args),
}));

/**
 * Position of a column in the INSERT list, i.e. the index of its parameter.
 *
 * Reads the whole `INSERT INTO job_queue (...)` list rather than matching up
 * to a named column: pinning the tail made every test that used it fail the
 * day a column was appended after it.
 */
function columnIndex(sql: string, column: string): number {
  const list = sql.match(/INSERT INTO job_queue \(([^)]*)\)/)?.[1] ?? '';
  return list.split(',').map((c) => c.trim()).indexOf(column);
}

describe('enqueueJob', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue([{ id: 1 }]);
  });

  it('defaults to an analyze job at priority 0', async () => {
    const { enqueueJob } = await import('./jobQueue');
    await enqueueJob({
      entryId: 'e1', sourceUrl: 'https://x/1', platform: 'other',
      chatId: 42, inputUser: null,
    });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params).toContain('analyze');
    expect(params).toContain(0);
  });

  it('carries an explicit kind and priority', async () => {
    const { enqueueJob } = await import('./jobQueue');
    await enqueueJob({
      entryId: 'e2', sourceUrl: 'https://x/2', platform: 'other',
      chatId: 42, inputUser: null, kind: 'transcribe', priority: 10,
    });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params).toContain('transcribe');
    expect(params).toContain(10);
  });

  // A repair run (requeueErrors) enqueues a silent analyze job and nothing
  // else. It must come out with reanalyze = false, or it skips the very
  // download it exists to retry.
  it('leaves reanalyze false for a silent repair', async () => {
    const { enqueueJob } = await import('./jobQueue');
    await enqueueJob({
      entryId: 'e3', sourceUrl: 'https://x/3', platform: 'instagram',
      chatId: 42, inputUser: null, notify: false,
    });
    const sql = queryMock.mock.calls[0][0] as string;
    const params = queryMock.mock.calls[0][1] as unknown[];
    const at = columnIndex(sql, 'reanalyze');
    expect(at).toBeGreaterThan(-1);
    expect(params[at as number]).toBe(false);
  });

  it('sets reanalyze when the caller asks for it', async () => {
    const { enqueueJob } = await import('./jobQueue');
    await enqueueJob({
      entryId: 'e4', sourceUrl: 'https://x/4', platform: 'instagram',
      chatId: 42, inputUser: null, notify: false, reanalyze: true,
    });
    expect(queryMock.mock.calls[0][1] as unknown[]).toContain(true);
  });
});

// ---------------------------------------------------------------------------
// Lane split
//
// A re-analysis reaches no external service — it works from media already on
// disk — so the rate limiting that shapes the Instagram and "other" lanes buys
// it nothing. What it does hit is ollama, which keeps one model resident, so
// it needs a lane of its own that runs strictly one at a time.
// ---------------------------------------------------------------------------
describe('claim lanes', () => {
  beforeEach(() => {
    vi.resetModules();
    withClientMock.mockReset();
    withClientMock.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) })
    );
  });

  async function clauseOf(lane: 'instagram' | 'other' | 'reanalyze' | 'transcribe'): Promise<string> {
    const q = vi.fn().mockResolvedValue({ rows: [] });
    withClientMock.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({ query: q }));
    const mod = await import('./jobQueue');
    const claim = {
      instagram: mod.claimNextInstagramJob,
      other: mod.claimNextOtherJob,
      reanalyze: mod.claimNextReanalyzeJob,
      transcribe: mod.claimNextTranscribeJob,
    }[lane];
    await claim();
    return q.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('the Instagram lane leaves re-analyses alone', async () => {
    const sql = await clauseOf('instagram');
    expect(sql).toContain("platform = 'instagram'");
    expect(sql).toContain('NOT reanalyze');
  });

  it('the other-platform lane leaves them alone too', async () => {
    expect(await clauseOf('other')).toContain('NOT reanalyze');
  });

  // Without this the three lanes overlap and a re-analysis runs in whichever
  // claims it first — up to three at once in the "other" lane.
  it('re-analyses have a lane of their own', async () => {
    const sql = await clauseOf('reanalyze');
    expect(sql).toMatch(/kind = 'analyze' AND reanalyze/);
    expect(sql).not.toContain('NOT reanalyze');
  });
});

describe('skipAi', () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue([{ id: 1 }]);
  });

  it('defaults to analysing inline', async () => {
    const { enqueueJob } = await import('./jobQueue');
    await enqueueJob({
      entryId: 'e1', sourceUrl: 'https://x/1', platform: 'instagram',
      chatId: 42, inputUser: null,
    });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('skip_ai');
    expect(params[params.length - 1]).toBe(false);
  });

  it('carries the download-only flag when the caller sets it', async () => {
    const { enqueueJob } = await import('./jobQueue');
    await enqueueJob({
      entryId: 'e1', sourceUrl: 'https://x/1', platform: 'instagram',
      chatId: 42, inputUser: null, skipAi: true,
    });
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[params.length - 1]).toBe(true);
  });
});
