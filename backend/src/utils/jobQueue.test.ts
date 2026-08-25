import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
const withClientMock = vi.fn();

vi.mock('./db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  withClient: (...args: unknown[]) => withClientMock(...args),
}));

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
    const at = sql.match(/\(([^)]*reanalyze)\)/)?.[1].split(',').map((c) => c.trim()).indexOf('reanalyze');
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
