import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { announceInboxItem, buildPushPayload, type AnnouncerDeps } from './inboxAnnouncer';

const item = { id: 'i1', userId: 'archi', title: 'Sara ha condiviso con te', body: 'Say it Ain\'t So\n1 canzone', entryId: 'e1' };
const dev = (token: string, environment: 'development' | 'production' = 'production') => ({ token, environment });

function deps(over: Partial<AnnouncerDeps> = {}): AnnouncerDeps & { sent: Array<[unknown, unknown]> } {
  const sent: Array<[unknown, unknown]> = [];
  return {
    sent,
    sender: () => async (target, payload) => { sent.push([target, payload]); return 'sent'; },
    devices: async () => [dev('aa'.repeat(16))],
    badge: async () => 3,
    forget: vi.fn(async () => undefined),
    ...over,
  };
}

describe('buildPushPayload', () => {
  it('is the contract: alert, sound, badge, thread, and the ids the app opens', () => {
    expect(buildPushPayload(item, 3)).toEqual({
      aps: { alert: { title: item.title, body: item.body }, sound: 'default', badge: 3, 'thread-id': 'inbox' },
      inboxId: 'i1',
      entryId: 'e1',
    });
  });

  it('leaves entryId out when the item has none', () => {
    expect(buildPushPayload({ ...item, entryId: null }, 0)).not.toHaveProperty('entryId');
  });
});

describe('announceInboxItem', () => {
  it('does nothing, quietly, while push is off (no key)', async () => {
    const d = deps({ sender: () => null, devices: vi.fn(async () => [dev('aa'.repeat(16))]) });
    await announceInboxItem(item, d);
    expect(d.devices).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(0);
  });

  it('does nothing for a user with no registered phone', async () => {
    const d = deps({ devices: async () => [], badge: vi.fn(async () => 1) });
    await announceInboxItem(item, d);
    expect(d.sent).toHaveLength(0);
    expect(d.badge).not.toHaveBeenCalled();
  });

  it('rings every phone of the user with the current badge', async () => {
    const d = deps({ devices: async () => [dev('aa'.repeat(16)), dev('bb'.repeat(16), 'development')] });
    await announceInboxItem(item, d);
    expect(d.sent.map(([t]) => (t as { token: string }).token)).toEqual(['aa'.repeat(16), 'bb'.repeat(16)]);
    expect((d.sent[0][1] as { aps: { badge: number } }).aps.badge).toBe(3);
  });

  it('forgets a token Apple says is dead and keeps ringing the others', async () => {
    const forget = vi.fn(async () => undefined);
    const sent: string[] = [];
    await announceInboxItem(item, deps({
      forget,
      devices: async () => [dev('dead'.padEnd(32, '0')), dev('good'.padEnd(32, '0'))],
      sender: () => async (target) => { sent.push(target.token); return target.token.startsWith('dead') ? 'invalid_token' : 'sent'; },
    }));
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith('dead'.padEnd(32, '0'));
    expect(sent).toHaveLength(2);
  });

  it('keeps a token after a plain failure', async () => {
    const forget = vi.fn(async () => undefined);
    await announceInboxItem(item, deps({ forget, sender: () => async () => 'failed' }));
    expect(forget).not.toHaveBeenCalled();
  });

  it('never throws, whatever breaks (the item is stored anyway)', async () => {
    await expect(announceInboxItem(item, deps({ devices: async () => { throw new Error('db down'); } }))).resolves.toBeUndefined();
    await expect(announceInboxItem(item, deps({ sender: () => { throw new Error('boom'); } }))).resolves.toBeUndefined();
    await expect(announceInboxItem(item, deps({ sender: () => async () => { throw new Error('socket'); } }))).resolves.toBeUndefined();
  });
});
