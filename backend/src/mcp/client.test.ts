import { describe, expect, it, vi } from 'vitest';
import { createSoundreelClient, SoundreelHttpError } from './client';

describe('createSoundreelClient', () => {
  it('lists recent summaries with view=summary', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ entries: [{ id: 'e1' }], total: 1, limit: 5, offset: 0 }),
    });
    const client = createSoundreelClient({
      baseUrl: 'http://127.0.0.1:8081',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.listRecent(5);
    expect(out.entries).toHaveLength(1);
    const called = String(fetchImpl.mock.calls[0][0]);
    expect(called).toContain('api/entries');
    expect(called).toContain('view=summary');
    expect(called).toContain('limit=5');
  });

  it('searches with q and limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ results: [], expandedTerms: [], total: 0 }),
    });
    const client = createSoundreelClient({
      baseUrl: 'http://soundreel:8080/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.search('tesla', 10);
    const called = String(fetchImpl.mock.calls[0][0]);
    expect(called).toContain('api/search');
    expect(called).toContain('q=tesla');
    expect(called).toContain('limit=10');
  });

  it('posts analyze with channel mcp', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, entryId: 'abc' }),
    });
    const client = createSoundreelClient({
      baseUrl: 'http://127.0.0.1:8081',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      analyzeTimeoutMs: 1000,
    });
    await client.analyzeUrl('https://instagram.com/reel/x');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        url: 'https://instagram.com/reel/x',
        channel: 'mcp',
        user: null,
      }),
    });
  });

  it('throws SoundreelHttpError on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'missing' }),
    });
    const client = createSoundreelClient({
      baseUrl: 'http://127.0.0.1:8081',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getEntry('nope')).rejects.toBeInstanceOf(SoundreelHttpError);
  });
});
