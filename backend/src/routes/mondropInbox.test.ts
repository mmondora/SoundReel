import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
// mondrop.ts (where requireMondrop lives) imports a lot that is irrelevant here
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), requestSongDownload: vi.fn(),
  setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(), ORDER_MONDROP: [], resolveEntryMediaAbs: vi.fn(), buildTracks: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarning: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/songStream', () => ({ serveSong: vi.fn() }));
vi.mock('../services/inbox', async (orig) => ({
  ...(await orig<typeof import('../services/inbox')>()),
  listInbox: vi.fn(),
  listReceived: vi.fn(),
  unreadCount: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  deleteItem: vi.fn(),
  markReceivedSeen: vi.fn(),
}));
vi.mock('../services/pushDevices', () => ({ registerPushDevice: vi.fn(), unregisterPushDevice: vi.fn() }));
vi.mock('../utils/db', () => ({ query: vi.fn(), pool: { query: vi.fn() } }));

import { registerMondropInboxRoutes } from './mondropInbox';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { deleteItem, listInbox, listReceived, markAllRead, markRead, markReceivedSeen, unreadCount, type InboxItem } from '../services/inbox';
import { registerPushDevice, unregisterPushDevice } from '../services/pushDevices';

const KEY = { 'x-soundreel-key': 'sr_test' };
const TOKEN = 'AB12'.repeat(16);

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1', userId: 'mike', kind: 'share_result', level: 'info', title: 'Salvato', body: '2 canzoni', entryId: 'e1',
  url: 'https://soundreel.casamon.dev/?entry=e1', linkKey: 'https://x/e1', data: { songs: 2 },
  createdAt: '2026-11-08T07:10:00.000Z', updatedAt: '2026-11-08T07:10:00.000Z', readAt: null, expiresAt: '2026-11-11T07:10:00.000Z', ...over,
});

function buildApp() {
  const app = Fastify();
  registerMondropInboxRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
  vi.mocked(listInbox).mockResolvedValue({ notifications: [item()], removedIds: [] });
  vi.mocked(listReceived).mockResolvedValue([]);
  vi.mocked(unreadCount).mockResolvedValue(1);
  vi.mocked(markRead).mockResolvedValue(true);
  vi.mocked(markAllRead).mockResolvedValue(3);
  vi.mocked(deleteItem).mockResolvedValue(true);
  vi.mocked(markReceivedSeen).mockResolvedValue(true);
});

describe('every inbox route needs the Mondrop key', () => {
  it.each([
    ['GET', '/api/mondrop/inbox'],
    ['POST', '/api/mondrop/inbox/read-all'],
    ['POST', '/api/mondrop/inbox/i1/read'],
    ['DELETE', '/api/mondrop/inbox/i1'],
    ['POST', '/api/mondrop/received/e1/seen'],
    ['POST', '/api/mondrop/push/devices'],
    ['DELETE', '/api/mondrop/push/devices'],
  ])('%s %s → 401 without a valid key', async (method, url) => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const res = await buildApp().inject({ method: method as 'GET', url });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/mondrop/inbox', () => {
  it('answers the contract: notifications as the app reads them, received, removedIds, unread, serverTime', async () => {
    vi.mocked(listReceived).mockResolvedValue([{ entryId: 'e9', from: 'sara', sharedAt: '2026-11-08T06:00:00.000Z', title: 'Say it Ain\'t So', kind: 'spotify', counts: { songs: 1, films: 0, notes: 0, software: 0 }, seen: false, url: 'u' }]);
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox', headers: KEY });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.notifications).toEqual([{
      id: 'i1', kind: 'share_result', level: 'info', title: 'Salvato', body: '2 canzoni', entryId: 'e1',
      url: 'https://soundreel.casamon.dev/?entry=e1', createdAt: '2026-11-08T07:10:00.000Z', readAt: null,
      expiresAt: '2026-11-11T07:10:00.000Z', data: { songs: 2 },
    }]);
    expect(body.notifications[0]).not.toHaveProperty('userId');
    expect(body.notifications[0]).not.toHaveProperty('linkKey');
    expect(body.received).toHaveLength(1);
    expect(body.removedIds).toEqual([]);
    expect(body.unread).toBe(1);
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
  });

  it('reads the mail of the key\'s user only, and takes serverTime BEFORE reading', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'sara', device: 'iPhone di Sara' } });
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox?user=mike', headers: { ...KEY, 'x-soundreel-user': 'mike' } });
    const now = vi.mocked(listInbox).mock.calls[0][2] as Date;
    expect(vi.mocked(listInbox).mock.calls[0][0]).toBe('sara');
    expect(vi.mocked(listReceived).mock.calls[0][0]).toBe('sara');
    expect(vi.mocked(unreadCount).mock.calls[0][0]).toBe('sara');
    expect(res.json().serverTime).toBe(now.toISOString());
    expect(vi.mocked(unreadCount).mock.calls[0][1]).toBe(now);
  });

  it('a legacy key (no owner) takes the user from the header, else anonymous', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: null });
    await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox', headers: { ...KEY, 'x-soundreel-user': 'archi' } });
    expect(vi.mocked(listInbox).mock.calls[0][0]).toBe('archi');
    await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox', headers: KEY });
    expect(vi.mocked(listInbox).mock.calls[1][0]).toBe('anonymous');
  });

  it('passes `since` as a date and the default limit of 100', async () => {
    await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox?since=2026-11-08T07:00:00Z', headers: KEY });
    const opts = vi.mocked(listInbox).mock.calls[0][1] as { since: Date; limit: number };
    expect(opts.since.toISOString()).toBe('2026-11-08T07:00:00.000Z');
    expect(opts.limit).toBe(100);
  });

  it('clamps the limit to 200 and refuses what is not a positive number', async () => {
    await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox?limit=500', headers: KEY });
    expect((vi.mocked(listInbox).mock.calls[0][1] as { limit: number }).limit).toBe(200);
    expect(vi.mocked(listReceived).mock.calls[0][1]).toBe(200);
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      const res = await buildApp().inject({ method: 'GET', url: `/api/mondrop/inbox?limit=${bad}`, headers: KEY });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_query', field: 'limit' });
    }
  });

  it('refuses a `since` that is not a date', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox?since=yesterday', headers: KEY });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_query', field: 'since' });
    expect(listInbox).not.toHaveBeenCalled();
  });

  it('tells a second device what disappeared', async () => {
    vi.mocked(listInbox).mockResolvedValue({ notifications: [], removedIds: ['gone1', 'gone2'] });
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox?since=2026-11-08T07:00:00Z', headers: KEY });
    expect(res.json().removedIds).toEqual(['gone1', 'gone2']);
  });

  it('a failure is a plain 500, no details', async () => {
    vi.mocked(listInbox).mockRejectedValue(new Error('relation "inbox_items" does not exist'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/mondrop/inbox', headers: KEY });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('inbox_items');
  });
});

describe('changing the mail', () => {
  it('POST read, DELETE and seen act on the key\'s user only', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'archi', device: 'd' } });
    await buildApp().inject({ method: 'POST', url: '/api/mondrop/inbox/i1/read', headers: KEY });
    await buildApp().inject({ method: 'DELETE', url: '/api/mondrop/inbox/i1', headers: KEY });
    await buildApp().inject({ method: 'POST', url: '/api/mondrop/received/e1/seen', headers: KEY });
    expect(markRead).toHaveBeenCalledWith('archi', 'i1');
    expect(deleteItem).toHaveBeenCalledWith('archi', 'i1');
    expect(markReceivedSeen).toHaveBeenCalledWith('archi', 'e1');
  });

  it('answers ok when it worked and 404 when the item is not the user\'s (or is gone)', async () => {
    const ok = await buildApp().inject({ method: 'POST', url: '/api/mondrop/inbox/i1/read', headers: KEY });
    expect(ok.json()).toEqual({ ok: true });
    vi.mocked(markRead).mockResolvedValue(false);
    vi.mocked(deleteItem).mockResolvedValue(false);
    vi.mocked(markReceivedSeen).mockResolvedValue(false);
    for (const [method, url] of [['POST', '/api/mondrop/inbox/other/read'], ['DELETE', '/api/mondrop/inbox/other'], ['POST', '/api/mondrop/received/other/seen']]) {
      const res = await buildApp().inject({ method: method as 'POST', url, headers: KEY });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('an id that cannot be ours is not found without asking the database', async () => {
    const res = await buildApp().inject({ method: 'DELETE', url: `/api/mondrop/inbox/${'x'.repeat(101)}`, headers: KEY });
    expect(res.statusCode).toBe(404);
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('read-all says how many things were waiting, and is not mistaken for an id', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/api/mondrop/inbox/read-all', headers: KEY });
    expect(res.json()).toEqual({ ok: true, marked: 3 });
    expect(markAllRead).toHaveBeenCalledWith('mike');
    expect(markRead).not.toHaveBeenCalled();
  });

  it('failures are plain 500s', async () => {
    vi.mocked(markRead).mockRejectedValue(new Error('boom'));
    vi.mocked(deleteItem).mockRejectedValue(new Error('boom'));
    vi.mocked(markAllRead).mockRejectedValue(new Error('boom'));
    vi.mocked(markReceivedSeen).mockRejectedValue(new Error('boom'));
    for (const [method, url] of [['POST', '/api/mondrop/inbox/i1/read'], ['DELETE', '/api/mondrop/inbox/i1'], ['POST', '/api/mondrop/inbox/read-all'], ['POST', '/api/mondrop/received/e1/seen']]) {
      expect((await buildApp().inject({ method: method as 'POST', url, headers: KEY })).statusCode, url).toBe(500);
    }
  });
});

describe('the phone to ring', () => {
  const post = (payload: unknown) => buildApp().inject({ method: 'POST', url: '/api/mondrop/push/devices', headers: KEY, payload: payload as never });

  it('registers a token for the key\'s user, lowercased, with the device label', async () => {
    const res = await post({ token: TOKEN, environment: 'development' });
    expect(res.json()).toEqual({ ok: true });
    expect(registerPushDevice).toHaveBeenCalledWith({ token: TOKEN.toLowerCase(), userId: 'mike', environment: 'development', device: 'iPhone di Michele' });
  });

  it('refuses a token that is not hex and an unknown environment', async () => {
    expect((await post({ token: 'not a token', environment: 'production' })).json()).toEqual({ error: 'invalid_body', field: 'token' });
    expect((await post({ token: TOKEN, environment: 'staging' })).json()).toEqual({ error: 'invalid_body', field: 'environment' });
    expect((await post({})).statusCode).toBe(400);
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it('removes a token (the app sends it in the body), or from the query', async () => {
    const body = await buildApp().inject({ method: 'DELETE', url: '/api/mondrop/push/devices', headers: { ...KEY, 'content-type': 'application/json' }, payload: JSON.stringify({ token: TOKEN }) });
    expect(body.json()).toEqual({ ok: true });
    expect(unregisterPushDevice).toHaveBeenCalledWith('mike', TOKEN.toLowerCase());
    await buildApp().inject({ method: 'DELETE', url: `/api/mondrop/push/devices?token=${TOKEN}`, headers: KEY });
    expect(unregisterPushDevice).toHaveBeenCalledTimes(2);
  });

  it('forgetting a token that is not his is not an error', async () => {
    vi.mocked(unregisterPushDevice).mockResolvedValue(false);
    const res = await buildApp().inject({ method: 'DELETE', url: `/api/mondrop/push/devices?token=${TOKEN}`, headers: KEY });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to forget something that is not a token', async () => {
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/mondrop/push/devices', headers: KEY });
    expect(res.statusCode).toBe(400);
  });
});
