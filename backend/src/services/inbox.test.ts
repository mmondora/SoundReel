import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/db', () => ({ query: queryMock }));

import {
  DEFAULT_LIMIT,
  ERROR_CAP,
  INFO_TTL_MS,
  MAX_LIMIT,
  REMOVAL_MEMORY_MS,
  clampLimit,
  closeErrorsForLink,
  createInboxItem,
  deleteItem,
  listInbox,
  markAllRead,
  markRead,
  markReceivedSeen,
  sweepInbox,
  toWire,
  usersNotifiedAbout,
  unreadCount,
} from './inbox';

const NOW = new Date('2026-11-08T08:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1', user_id: 'mike', kind: 'share_result', level: 'info', title: 'T', body: 'B', entry_id: 'e1', url: 'u', link_key: 'k',
  data: { songs: 1 }, created_at: NOW, updated_at: NOW, read_at: null, expires_at: new Date(NOW.getTime() + INFO_TTL_MS), ...over,
});
const sql = (call: number): string => String(queryMock.mock.calls[call][0]);
const params = (call: number): unknown[] => queryMock.mock.calls[call][1] as unknown[];

beforeEach(() => queryMock.mockReset());

describe('the rules Michele set', () => {
  it('information lasts 3 days, errors never expire, the cap is 100 errors, removals are remembered for a week', () => {
    expect(INFO_TTL_MS).toBe(3 * 24 * 3600_000);
    expect(ERROR_CAP).toBe(100);
    expect(REMOVAL_MEMORY_MS).toBe(7 * 24 * 3600_000);
    expect(DEFAULT_LIMIT).toBe(100);
    expect(MAX_LIMIT).toBe(200);
  });
});

describe('clampLimit', () => {
  it.each([[undefined, 100], ['', 100], ['abc', 100], ['0', 100], ['-5', 100], ['1', 1], ['50', 50], ['200', 200], ['201', 200], ['9999', 200], [75, 75], [7.9, 7], [NaN, 100]])('%j → %i', (raw, expected) => {
    expect(clampLimit(raw)).toBe(expected);
  });
});

describe('createInboxItem', () => {
  it('information gets a 3-day expiry; an error gets none', async () => {
    queryMock.mockResolvedValue([row()]);
    await createInboxItem({ userId: 'mike', kind: 'share_result', title: 'T' }, NOW);
    expect(params(0)[12]).toEqual(new Date(NOW.getTime() + INFO_TTL_MS));
    queryMock.mockClear();
    queryMock.mockResolvedValue([row({ level: 'error', expires_at: null })]);
    await createInboxItem({ userId: 'mike', kind: 'share_result', level: 'error', title: 'T' }, NOW);
    expect(params(0)[12]).toBeNull();
  });

  it('an error enforces the cap on that user\'s errors, information does not', async () => {
    queryMock.mockResolvedValue([row()]);
    await createInboxItem({ userId: 'mike', kind: 'share_result', title: 'T' }, NOW);
    expect(queryMock).toHaveBeenCalledTimes(1);
    queryMock.mockClear();
    queryMock.mockResolvedValue([row({ level: 'error', expires_at: null })]);
    await createInboxItem({ userId: 'mike', kind: 'share_result', level: 'error', title: 'T' }, NOW);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(sql(1)).toMatch(/level = 'error'/);
    expect(sql(1)).toMatch(/OFFSET \$3/);
    expect(params(1)).toEqual(['mike', NOW, ERROR_CAP]);
  });

  it('read:true is stored as read; the entry page is the default url; title and body are bounded', async () => {
    queryMock.mockResolvedValue([row()]);
    await createInboxItem({ userId: 'mike', kind: 'share_result', title: 'x'.repeat(500), body: 'y'.repeat(2000), entryId: 'e1', read: true }, NOW);
    const p = params(0);
    expect((p[4] as string).length).toBe(200);
    expect((p[5] as string).length).toBe(600);
    expect(p[7]).toMatch(/\/\?entry=e1$/);
    expect(p[11]).toEqual(NOW);
    queryMock.mockClear();
    queryMock.mockResolvedValue([row()]);
    await createInboxItem({ userId: 'mike', kind: 'share_result', title: 'T' }, NOW);
    expect(params(0)[11]).toBeNull();
  });

  it('data is stored as JSON', async () => {
    queryMock.mockResolvedValue([row()]);
    await createInboxItem({ userId: 'mike', kind: 'share_result', title: 'T', data: { options: { playlistId: 'p1' } } }, NOW);
    expect(params(0)[9]).toBe('{"options":{"playlistId":"p1"}}');
  });
});

describe('isolation: every read and change is bound to the user it was given', () => {
  it('each statement names the user (an id of another user can only be "not found")', async () => {
    queryMock.mockResolvedValue([]);
    await markRead('archi', 'i1', NOW);
    await deleteItem('archi', 'i1', NOW);
    await markAllRead('archi', NOW);
    await markReceivedSeen('archi', 'e1', NOW);
    await closeErrorsForLink('archi', 'k', NOW);
    await listInbox('archi', {}, NOW);
    await unreadCount('archi', NOW);
    for (let i = 0; i < queryMock.mock.calls.length; i += 1) {
      const text = sql(i);
      if (/sweep|DELETE FROM share_intents/.test(text)) continue;
      expect(text, `statement ${i}`).toMatch(/user_id = \$|shared_with = \$/);
      expect(params(i), `statement ${i}`).toContain('archi');
    }
  });

  it('an unknown item is refused without writing anything', async () => {
    queryMock.mockResolvedValueOnce([]);
    expect(await markRead('archi', 'nope', NOW)).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
    queryMock.mockClear();
    queryMock.mockResolvedValueOnce([]);
    expect(await deleteItem('archi', 'nope', NOW)).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('seen and read are one act', () => {
  it('reading a "shared with you" notice also sees the share', async () => {
    queryMock
      .mockResolvedValueOnce([{ kind: 'share_received', entry_id: 'e1', read_at: null }]) // the lookup
      .mockResolvedValueOnce([]) // mark read
      .mockResolvedValueOnce([{ entry_id: 'e1' }]) // entry_shares.seen_at
      .mockResolvedValueOnce([]); // sibling notices
    expect(await markRead('archi', 'i1', NOW)).toBe(true);
    expect(sql(2)).toMatch(/UPDATE entry_shares SET seen_at/);
  });

  it('reading an ordinary result does not touch the shares', async () => {
    queryMock.mockResolvedValueOnce([{ kind: 'share_result', entry_id: 'e1', read_at: null }]).mockResolvedValueOnce([]);
    await markRead('mike', 'i1', NOW);
    expect(queryMock.mock.calls.some((c) => /entry_shares/.test(String(c[0])))).toBe(false);
  });

  it('an already read item is not written again (other devices are not woken for nothing)', async () => {
    queryMock.mockResolvedValueOnce([{ kind: 'share_result', entry_id: null, read_at: NOW }]);
    expect(await markRead('mike', 'i1', NOW)).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('seeing a share reads the notices that announced it', async () => {
    queryMock.mockResolvedValueOnce([{ entry_id: 'e1' }]).mockResolvedValueOnce([]);
    expect(await markReceivedSeen('archi', 'e1', NOW)).toBe(true);
    expect(sql(1)).toMatch(/UPDATE inbox_items SET read_at/);
    expect(sql(1)).toMatch(/kind = 'share_received'/);
  });

  it('a share that was not shared with this user is not found', async () => {
    queryMock.mockResolvedValueOnce([]);
    expect(await markReceivedSeen('archi', 'e1', NOW)).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('what the badge counts', () => {
  it('one query, where a received share counts once and an expired notice does not count', async () => {
    queryMock.mockResolvedValue([{ unread: 4 }]);
    expect(await unreadCount('archi', NOW)).toBe(4);
    const text = sql(0);
    expect(text).toMatch(/NOT EXISTS/); // a share with an unread notice is not counted twice
    expect(text).toMatch(/expires_at IS NULL OR expires_at > \$2/);
    expect(text).toMatch(/seen_at IS NULL/);
  });

  it('is 0 when there is no row', async () => {
    queryMock.mockResolvedValue([]);
    expect(await unreadCount('archi', NOW)).toBe(0);
  });

  it('read-all returns the number that was waiting and then reads everything and sees every share', async () => {
    queryMock.mockResolvedValueOnce([{ unread: 5 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await markAllRead('archi', NOW)).toBe(5);
    expect(sql(1)).toMatch(/UPDATE inbox_items SET read_at/);
    expect(sql(2)).toMatch(/UPDATE entry_shares SET seen_at/);
  });
});

describe('listInbox', () => {
  it('hides expired and removed items and asks for no removals without `since`', async () => {
    queryMock.mockResolvedValue([row()]);
    const page = await listInbox('mike', {}, NOW);
    expect(sql(0)).toMatch(/removed_at IS NULL/);
    expect(sql(0)).toMatch(/expires_at IS NULL OR expires_at > \$2/);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(page.removedIds).toEqual([]);
  });

  it('with `since` it reads 2 s earlier (a row committed a moment late is never missed) and asks what was removed', async () => {
    queryMock.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ id: 'gone' }]);
    const since = new Date('2026-11-08T07:00:00Z');
    const page = await listInbox('mike', { since, limit: 20 }, NOW);
    expect(params(0)[2]).toEqual(new Date(since.getTime() - 2000));
    expect(params(0)[3]).toBe(20);
    expect(params(1)[1]).toEqual(new Date(since.getTime() - 2000));
    expect(page.removedIds).toEqual(['gone']);
  });

  it('maps rows to items and to the wire format the app reads', async () => {
    queryMock.mockResolvedValue([row({ level: 'error', expires_at: null, read_at: NOW })]);
    const page = await listInbox('mike', {}, NOW);
    expect(page.notifications[0]).toMatchObject({ id: 'i1', level: 'error', expiresAt: null, readAt: NOW.toISOString(), linkKey: 'k' });
    const wire = toWire(page.notifications[0]);
    expect(Object.keys(wire).sort()).toEqual(['body', 'createdAt', 'data', 'entryId', 'expiresAt', 'id', 'kind', 'level', 'readAt', 'title', 'url']);
  });
});

describe('sweepInbox', () => {
  it('removes expired information softly, forgets old removals, drops finished intents — and says how many', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]).mockResolvedValueOnce([{ id: 'c' }]).mockResolvedValueOnce([]);
    expect(await sweepInbox(NOW)).toEqual({ expired: 2, purged: 1, intentsPurged: 0 });
    expect(sql(0)).toMatch(/expires_at IS NOT NULL AND expires_at <= \$1/); // errors have no expiry: never swept
    expect(sql(0)).toMatch(/SET removed_at/); // soft: a device that was away is still told
    expect(params(1)[0]).toEqual(new Date(NOW.getTime() - REMOVAL_MEMORY_MS));
    expect(sql(2)).toMatch(/share_intents/);
  });
});

describe('usersNotifiedAbout', () => {
  it('asks for the share_received notices of this entry among these users, whatever their state', async () => {
    queryMock.mockResolvedValue([{ user_id: 'archi' }]);
    expect(await usersNotifiedAbout('e1', ['archi', 'sara'])).toEqual(['archi']);
    const text = sql(0);
    expect(text).toMatch(/kind = 'share_received' AND entry_id = \$1 AND user_id = ANY\(\$2::text\[\]\)/);
    expect(text).not.toMatch(/removed_at/); // a notice that was read, deleted or expired still counts as "told"
    expect(params(0)).toEqual(['e1', ['archi', 'sara']]);
  });

  it('asks nothing for nobody', async () => {
    expect(await usersNotifiedAbout('e1', [])).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
