import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogs } from './api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi.fn(async (_input: string) => new Response('[]', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return () => new URL(String(fetchMock.mock.calls[0][0]), 'http://x').searchParams;
}

describe('getLogs', () => {
  it('sends the category (comma separated), level, entry id and limit', async () => {
    const params = stubFetch();
    await getLogs({ category: 'playlist,sync,download,device', level: 'error', entryId: 'abc', limit: 200 });
    expect(Object.fromEntries(params())).toEqual({ category: 'playlist,sync,download,device', level: 'error', entryId: 'abc', limit: '200' });
  });

  it('sends nothing for what is not set ("all" level included)', async () => {
    const params = stubFetch();
    await getLogs({ level: 'all' });
    expect([...params().keys()]).toEqual([]);
  });
});
