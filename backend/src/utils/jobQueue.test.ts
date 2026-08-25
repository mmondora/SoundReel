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
});
