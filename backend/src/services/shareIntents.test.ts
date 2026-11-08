import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/db', () => ({ query: queryMock }));

import { finishIntent, pendingIntentsForEntry, stuckIntents, upsertPendingIntent } from './shareIntents';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'x1', entry_id: 'e1', user_id: 'mike', source_url: 'https://x/a', playlist_id: 'p1', share_with: ['archi'], notify_with: ['archi'], comment: '#t', status: 'pending', ...over,
});

beforeEach(() => queryMock.mockReset());

describe('upsertPendingIntent', () => {
  it('is one open intent per entry and sender: the same link twice merges, a later playlist wins, recipients add up', async () => {
    queryMock.mockResolvedValue([row()]);
    const intent = await upsertPendingIntent({ entryId: 'e1', userId: 'mike', sourceUrl: 'https://x/a', playlistId: 'p1', shareWith: ['archi'], notifyWith: ['archi'], comment: '#t' });
    const text = String(queryMock.mock.calls[0][0]);
    expect(text).toMatch(/ON CONFLICT \(entry_id, user_id\) WHERE status = 'pending' DO UPDATE/);
    expect(text).toMatch(/COALESCE\(EXCLUDED\.playlist_id, share_intents\.playlist_id\)/);
    expect(text).toMatch(/share_intents\.share_with \|\| EXCLUDED\.share_with/);
    expect(text).toMatch(/share_intents\.notify_with \|\| EXCLUDED\.notify_with/);
    expect(intent).toEqual({ id: 'x1', entryId: 'e1', userId: 'mike', sourceUrl: 'https://x/a', playlistId: 'p1', shareWith: ['archi'], notifyWith: ['archi'], comment: '#t', status: 'pending' });
  });

  it('defaults: no playlist, nobody to tell, no comment', async () => {
    queryMock.mockResolvedValue([row({ playlist_id: null, share_with: null, notify_with: null, comment: null })]);
    await upsertPendingIntent({ entryId: 'e1', userId: 'mike', sourceUrl: 'https://x/a' });
    const p = queryMock.mock.calls[0][1] as unknown[];
    expect(p.slice(4)).toEqual([null, [], [], null]);
  });

  it('a row with null arrays reads as empty lists', async () => {
    queryMock.mockResolvedValue([row({ share_with: null, notify_with: null })]);
    const intent = await upsertPendingIntent({ entryId: 'e1', userId: 'mike', sourceUrl: 'u' });
    expect(intent.shareWith).toEqual([]);
    expect(intent.notifyWith).toEqual([]);
  });
});

describe('pendingIntentsForEntry', () => {
  it('lists only the open ones, oldest first', async () => {
    queryMock.mockResolvedValue([row(), row({ id: 'x2', user_id: 'archi' })]);
    const list = await pendingIntentsForEntry('e1');
    expect(String(queryMock.mock.calls[0][0])).toMatch(/status = 'pending' ORDER BY created_at/);
    expect(list.map((i) => i.id)).toEqual(['x1', 'x2']);
  });
});

describe('finishIntent', () => {
  it('closes an open intent exactly once: the second caller gets false and must stay silent', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'x1' }]).mockResolvedValueOnce([]);
    expect(await finishIntent('x1', 'done', { songs: 1 })).toBe(true);
    expect(await finishIntent('x1', 'done', { songs: 1 })).toBe(false);
    expect(String(queryMock.mock.calls[0][0])).toMatch(/WHERE id = \$1 AND status = 'pending'/);
    expect(queryMock.mock.calls[0][1]).toEqual(['x1', 'done', '{"songs":1}']);
  });
});

describe('stuckIntents', () => {
  it('asks for open intents past the age whose entry has no job queued or processing', async () => {
    queryMock.mockResolvedValue([row()]);
    const since = new Date('2026-11-08T08:00:00Z');
    const list = await stuckIntents(since);
    const text = String(queryMock.mock.calls[0][0]);
    expect(text).toMatch(/i\.status = 'pending' AND i\.created_at < \$1/);
    expect(text).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM job_queue j WHERE j\.entry_id = i\.entry_id AND j\.status IN \('queued', 'processing'\)/);
    expect(queryMock.mock.calls[0][1]).toEqual([since, 50]);
    expect(list).toHaveLength(1);
  });
});
