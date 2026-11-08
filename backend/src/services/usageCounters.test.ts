import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/db', () => ({ query: queryMock }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import {
  classifyDevice,
  clampDays,
  countUsage,
  flushUsage,
  pendingUsageKeys,
  readUsage,
  resetUsageBufferForTests,
  routeGroup,
  startUsageCounters,
  summarizeUsage,
  usageKeyFor,
  type UsageKey,
} from './usageCounters';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

beforeEach(() => {
  queryMock.mockReset();
  resetUsageBufferForTests();
});

describe('classifyDevice (the user-agent is read, then forgotten)', () => {
  it.each([
    [IPHONE, 'mobile-web'],
    [ANDROID, 'mobile-web'],
    [IPAD, 'mobile-web'],
    [MAC, 'desktop-web'],
    ['Mondrop/7 CFNetwork/1494.0.7 Darwin/23.4.0', 'app'],
    ['MondropShare/1.6.0 CFNetwork/1494.0.7 Darwin/23.4.0', 'app'],
    ['curl/8.5.0', 'automation'],
    ['python-requests/2.31.0', 'automation'],
    ['node', 'automation'],
    ['undici', 'automation'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'automation'],
    ['UptimeRobot/2.0', 'automation'],
    ['', 'other'],
    [undefined, 'other'],
    ['SomethingElse/1.0', 'other'],
  ])('%s → %s', (ua, expected) => {
    expect(classifyDevice(ua as string | undefined)).toBe(expected);
  });
});

describe('routeGroup', () => {
  it.each([
    ['/api/entries', 'entries'],
    ['/api/entries/:id', 'entries'],
    ['/api/entries/:id/share', 'entries'],
    ['/api/entries/:id/media', 'media'],
    ['/api/search', 'search'],
    ['/api/library/search', 'search'],
    ['/api/playlists/:id/songs', 'playlists'],
    ['/api/mondrop/playlists', 'playlists'],
    ['/api/mondrop/library', 'songs'],
    ['/api/songs/:key/file', 'songs'],
    ['/api/mondrop/songs/:songKey/file', 'songs'],
    ['/api/share', 'share'],
    ['/api/analyze', 'analyze'],
    ['/api/mondrop/inbox', 'inbox'],
    ['/api/mondrop/inbox/:id/read', 'inbox'],
    ['/api/mondrop/received/:entryId/seen', 'inbox'],
    ['/api/mondrop/push/devices', 'inbox'],
    ['/api/mondrop/plays', 'stats'],
    ['/api/stats', 'stats'],
    ['/api/software', 'software'],
    ['/api/films', 'films'],
    ['/api/notes', 'notes'],
    ['/api/config/music-folders', 'settings'],
    ['/api/admin/usage', 'settings'],
    ['/api/me', 'settings'],
    ['/api/something-new', 'other'],
  ])('%s → %s', (pattern, group) => {
    expect(routeGroup(pattern)).toBe(group);
  });

  it('is null for what is not an API call (pages, files, health, no route at all)', () => {
    for (const p of ['/health', '/assets/index-abc.js', '/', '/telegram/webhook', undefined, '']) expect(routeGroup(p as string | undefined)).toBeNull();
  });
});

const req = (over: { ip?: string; ua?: string; headers?: Record<string, string>; url?: string | undefined; query?: Record<string, unknown> } = {}): FastifyRequest =>
  ({
    ip: over.ip ?? '203.0.113.9',
    headers: { 'user-agent': over.ua ?? IPHONE, ...(over.headers ?? {}) },
    routeOptions: { url: 'url' in over ? over.url : '/api/entries/:id' },
    query: over.query ?? {},
  }) as unknown as FastifyRequest;

describe('usageKeyFor', () => {
  const NOW = new Date('2026-11-08T08:00:00Z');

  it('counts an API call by day, user, kind of device, network and group', () => {
    expect(usageKeyFor(req({ headers: { 'remote-user': 'mike', 'cf-ray': 'abc' } }), NOW)).toEqual({
      day: '2026-11-08', user: 'mike', device: 'mobile-web', network: 'external', group: 'entries',
    });
  });

  it('a request that did not come through Cloudflare is the home network', () => {
    expect(usageKeyFor(req({ headers: { 'remote-user': 'sara' } }), NOW)?.network).toBe('internal');
  });

  it('the user is the Authelia one, else the app\'s own hint, else anonymous', () => {
    expect(usageKeyFor(req({ headers: { 'remote-user': 'archi' } }), NOW)?.user).toBe('archi');
    expect(usageKeyFor(req({ headers: { 'x-soundreel-user': 'sara' } }), NOW)?.user).toBe('sara');
    expect(usageKeyFor(req({ query: { user: 'mike' } }), NOW)?.user).toBe('mike');
    expect(usageKeyFor(req({}), NOW)?.user).toBe('anonymous');
    expect(usageKeyFor(req({ headers: { 'remote-user': 'stranger' } }), NOW)?.user).toBe('anonymous');
  });

  it('does not count the server calling itself (the job worker posts to /api/analyze on loopback)', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(usageKeyFor(req({ ip, url: '/api/analyze' }), NOW)).toBeNull();
  });

  it('does not count what is not an API call', () => {
    expect(usageKeyFor(req({ url: '/health' }), NOW)).toBeNull();
    expect(usageKeyFor(req({ url: undefined }), NOW)).toBeNull();
  });

  it('keeps nothing that could identify a person or a page: no IP, no user-agent, no path, no query', () => {
    const key = usageKeyFor(req({ ip: '203.0.113.9', ua: MAC, query: { q: 'secret search' }, headers: { 'remote-user': 'mike' } }), NOW) as UsageKey;
    const flat = JSON.stringify(key);
    expect(flat).not.toContain('203.0.113.9');
    expect(flat).not.toContain('Mozilla');
    expect(flat).not.toContain('secret');
    expect(Object.keys(key).sort()).toEqual(['day', 'device', 'group', 'network', 'user']);
  });
});

describe('counting and flushing', () => {
  const key = (over: Partial<UsageKey> = {}): UsageKey => ({ day: '2026-11-08', user: 'mike', device: 'mobile-web', network: 'external', group: 'entries', ...over });

  it('adds up in memory and writes one multi-row upsert that adds to what is stored', async () => {
    countUsage(key());
    countUsage(key());
    countUsage(key({ group: 'search' }));
    expect(pendingUsageKeys()).toBe(2);
    queryMock.mockResolvedValue([]);
    expect(await flushUsage()).toBe(2);
    const [text, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(text).toMatch(/ON CONFLICT \(day, user_id, device_class, network, route_group\)\s+DO UPDATE SET calls = usage_counters\.calls \+ EXCLUDED\.calls/);
    expect(params).toEqual(['2026-11-08', 'mike', 'mobile-web', 'external', 'entries', 2, '2026-11-08', 'mike', 'mobile-web', 'external', 'search', 1]);
    expect(pendingUsageKeys()).toBe(0);
  });

  it('writes nothing when there is nothing', async () => {
    expect(await flushUsage()).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('a failed write keeps the counts for the next minute instead of losing them', async () => {
    countUsage(key(), 5);
    queryMock.mockRejectedValueOnce(new Error('db down'));
    expect(await flushUsage()).toBe(0);
    expect(pendingUsageKeys()).toBe(1);
    queryMock.mockResolvedValue([]);
    countUsage(key(), 1);
    await flushUsage();
    expect((queryMock.mock.calls[1][1] as unknown[])[5]).toBe(6);
  });

  it('a stuck database cannot grow memory without end', () => {
    for (let i = 0; i < 6000; i += 1) countUsage(key({ day: `2026-01-${String(i)}` }));
    expect(pendingUsageKeys()).toBe(5000);
    countUsage(key({ day: '2026-01-0' })); // an existing key still counts
  });

  it('writes in chunks, so a large day never exceeds the parameter limit', async () => {
    for (let i = 0; i < 400; i += 1) countUsage(key({ day: `2026-02-${String(i)}` }));
    queryMock.mockResolvedValue([]);
    expect(await flushUsage()).toBe(400);
    expect(queryMock.mock.calls.length).toBe(3); // 150 + 150 + 100
  });
});

describe('the report', () => {
  const rows = [
    { day: '2026-11-08', user_id: 'mike', device_class: 'mobile-web', network: 'external', route_group: 'entries', calls: 40 },
    { day: '2026-11-08', user_id: 'mike', device_class: 'mobile-web', network: 'external', route_group: 'search', calls: 70 },
    { day: '2026-11-08', user_id: 'sara', device_class: 'desktop-web', network: 'internal', route_group: 'playlists', calls: 25 },
    { day: '2026-11-07', user_id: 'mike', device_class: 'app', network: 'external', route_group: 'inbox', calls: 5 },
  ];

  it('rolls up by device, user, network and day, and ranks what is done from each kind of device', () => {
    const r = summarizeUsage(rows, 14, '2026-10-26');
    expect(r.total).toBe(140);
    expect(r.byDevice).toEqual({ 'mobile-web': 110, 'desktop-web': 25, app: 5 });
    expect(r.byUser).toEqual({ mike: 115, sara: 25 });
    expect(r.byNetwork).toEqual({ external: 115, internal: 25 });
    expect(r.byDeviceAndGroup['mobile-web']).toEqual([{ group: 'search', calls: 70 }, { group: 'entries', calls: 40 }]);
    expect(r.byDay).toEqual([
      { day: '2026-11-08', calls: 135, mobileWeb: 110, desktopWeb: 25, app: 0 },
      { day: '2026-11-07', calls: 5, mobileWeb: 0, desktopWeb: 0, app: 5 },
    ]);
  });

  it('clamps the window to 1..90 days, default 14', () => {
    expect([clampDays(undefined), clampDays('7'), clampDays('0'), clampDays('500'), clampDays('x'), clampDays(30)]).toEqual([14, 7, 14, 90, 14, 30]);
  });

  it('flushes first so the answer is current, then reads the last N days', async () => {
    countUsage({ day: '2026-11-08', user: 'mike', device: 'app', network: 'internal', group: 'inbox' });
    queryMock.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    const r = await readUsage('14', new Date('2026-11-08T12:00:00Z'));
    expect(String(queryMock.mock.calls[0][0])).toMatch(/INSERT INTO usage_counters/);
    expect(queryMock.mock.calls[1][1]).toEqual(['2026-10-26']);
    expect(r.days).toBe(14);
    expect(r.total).toBe(140);
  });
});

describe('startUsageCounters', () => {
  it('counts each API response through an onResponse hook and never lets counting touch a response', async () => {
    const hooks: Array<(req: FastifyRequest) => Promise<void>> = [];
    const app = { addHook: (name: string, fn: (req: FastifyRequest) => Promise<void>) => { if (name === 'onResponse') hooks.push(fn); } } as unknown as FastifyInstance;
    const stop = startUsageCounters(app, 1_000_000);
    await hooks[0](req({ headers: { 'remote-user': 'mike' } }));
    expect(pendingUsageKeys()).toBe(1);
    await expect(hooks[0]({ headers: null } as unknown as FastifyRequest)).resolves.toBeUndefined();
    queryMock.mockResolvedValue([]);
    stop();
  });
});
