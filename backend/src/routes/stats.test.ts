import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getListeningStats: vi.fn(),
  getRecentPlays: vi.fn(),
  recordPlayEvents: vi.fn(),
  getUserSongs: vi.fn(),
  logActivity: vi.fn(),
}));
vi.mock('../services/listeningStats', async (orig) => ({ ...(await orig<typeof import('../services/listeningStats')>()), getListeningStats: m.getListeningStats, getRecentPlays: m.getRecentPlays }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: m.recordPlayEvents }));
vi.mock('../services/userSongs', () => ({ getUserSongs: m.getUserSongs }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: m.logActivity }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { registerStatsRoutes } from './stats';

const USER = { 'remote-user': 'sara' };
const ADMIN = { 'remote-user': 'mike', 'remote-groups': 'admins,family' };
const app = () => {
  const a = Fastify();
  registerStatsRoutes(a);
  return a;
};
const stats = (over: Record<string, unknown> = {}) => ({
  period: { from: '2026-10-10', to: '2026-11-08' }, totals: { plays: 3, skips: 1, listenedMs: 9, songs: 2, artists: 2, devices: 1 }, perDay: [], heatmap: [],
  topSongs: [{ songKey: 'bishop briggs::white flag', plays: 3, listenedMs: 9, lastPlayedAt: null }, { songKey: 'ghost::gone', plays: 1, listenedMs: 1, lastPlayedAt: null }],
  topArtists: [{ artist: 'bishop briggs', plays: 3 }, { artist: 'unknown artist', plays: 1 }], topGenres: [], perDevice: [], perOrigin: [],
  playedSongKeys: ['bishop briggs::white flag', 'ghost::gone'], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.getListeningStats.mockResolvedValue(stats());
  m.getUserSongs.mockResolvedValue(new Map([
    ['bishop briggs::white flag', { songKey: 'bishop briggs::white flag', title: 'White Flag', artist: 'Bishop Briggs' }],
    ['never::heard', { songKey: 'never::heard', title: 'Heard', artist: 'Never' }],
  ]));
});

describe('GET /api/stats/listening — who sees what (D4)', () => {
  it('needs a signed-in user', async () => {
    expect((await app().inject({ method: 'GET', url: '/api/stats/listening' })).statusCode).toBe(401);
  });

  it('a normal user sees only themselves: the filter is their id, never anybody else', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/stats/listening?from=2026-10-10&to=2026-11-08', headers: USER });
    expect(res.statusCode).toBe(200);
    expect(m.getListeningStats).toHaveBeenCalledWith({ userIds: ['sara'], device: null, from: '2026-10-10', to: '2026-11-08' });
    expect(res.json()).toMatchObject({ scope: 'me', users: ['sara'] });
  });

  it('…and is refused (403) when asking for everybody or for another user', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/api/stats/listening?scope=all', headers: USER })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/stats/listening?user=mike', headers: USER })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/stats/listening/recent?scope=all', headers: USER })).statusCode).toBe(403);
    expect(m.getListeningStats).not.toHaveBeenCalled();
    expect(m.getRecentPlays).not.toHaveBeenCalled();
  });

  it('the admin can look at everybody, at one user, or at one device', async () => {
    const a = app();
    await a.inject({ method: 'GET', url: '/api/stats/listening?scope=all&from=2026-10-10&to=2026-11-08', headers: ADMIN });
    expect(m.getListeningStats.mock.calls[0][0]).toMatchObject({ userIds: null });
    const one = await a.inject({ method: 'GET', url: '/api/stats/listening?user=sara&device=iPhone%20di%20Michele&from=2026-10-10&to=2026-11-08', headers: ADMIN });
    expect(m.getListeningStats.mock.calls[1][0]).toMatchObject({ userIds: ['sara'], device: 'iPhone di Michele' });
    expect(one.json()).toMatchObject({ scope: 'user', users: ['sara'] });
    expect((await a.inject({ method: 'GET', url: '/api/stats/listening?user=stranger', headers: ADMIN })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/api/stats/listening?scope=all', headers: ADMIN })).json()).toMatchObject({ scope: 'all', users: ['mike', 'archi', 'sara'] });
  });

  it('asking for yourself by name is the normal case, not an escalation', async () => {
    expect((await app().inject({ method: 'GET', url: '/api/stats/listening?user=sara', headers: USER })).statusCode).toBe(200);
  });
});

describe('GET /api/stats/listening — period and shaping', () => {
  it('defaults to the last 30 days ending today (the end shifted so a device east of UTC still has its "today")', async () => {
    await app().inject({ method: 'GET', url: '/api/stats/listening', headers: USER });
    const f = m.getListeningStats.mock.calls[0][0] as { from: string; to: string };
    const span = (Date.parse(`${f.to}T00:00:00Z`) - Date.parse(`${f.from}T00:00:00Z`)) / 86_400_000;
    expect(span).toBe(29);
    expect(Date.parse(`${f.to}T00:00:00Z`)).toBeGreaterThanOrEqual(Date.now() - 86_400_000);
    expect(Date.parse(`${f.to}T00:00:00Z`)).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000);
  });

  it.each([['from=2026-13-01'], ['to=yesterday'], ['from=2026-11-08&to=2026-10-01'], ['from=2000-01-01&to=2026-11-08']])(
    'rejects the period %s',
    async (qs) => {
      const res = await app().inject({ method: 'GET', url: `/api/stats/listening?${qs}`, headers: USER });
      expect([res.statusCode, res.json()]).toEqual([400, { error: 'invalid_period' }]);
    },
  );

  it('puts names on the numbers (songs and artists as the journal spells them), counts the never-played ones, hides the internal list', async () => {
    const out = (await app().inject({ method: 'GET', url: '/api/stats/listening?from=2026-10-10&to=2026-11-08', headers: USER })).json();
    expect(out.topSongs[0]).toMatchObject({ songKey: 'bishop briggs::white flag', title: 'White Flag', artist: 'Bishop Briggs', plays: 3 });
    expect(out.topSongs[1]).toMatchObject({ title: 'gone – ghost', artist: '' }); // not in the journal any more: a readable fallback
    expect(out.topArtists[0].artist).toBe('Bishop Briggs');
    expect(out.neverPlayed).toBe(1); // "never::heard" is visible but has no counted play; "white flag" has
    expect(out.librarySongs).toBe(2);
    expect(out.playedSongKeys).toBeUndefined();
  });

  it('500 when the aggregation fails', async () => {
    m.getListeningStats.mockRejectedValue(new Error('db down'));
    expect((await app().inject({ method: 'GET', url: '/api/stats/listening', headers: USER })).statusCode).toBe(500);
  });
});

describe('GET /api/stats/listening/recent', () => {
  it('returns the latest plays with names, clamps the limit, applies the same permissions', async () => {
    m.getRecentPlays.mockResolvedValue([{ id: 'x', userId: 'sara', device: 'web', songKey: 'bishop briggs::white flag', startedAt: 't', localStartedAt: 'l', listenedMs: 1, durationMs: null, counted: true, completed: false, origin: 'web' }]);
    const res = await app().inject({ method: 'GET', url: '/api/stats/listening/recent?limit=9999&device=web', headers: USER });
    expect(res.json().plays[0]).toMatchObject({ title: 'White Flag', artist: 'Bishop Briggs', origin: 'web' });
    expect(m.getRecentPlays).toHaveBeenCalledWith({ userIds: ['sara'], device: 'web' }, 200);
  });
});

describe('POST /api/plays (the web player reports its sessions)', () => {
  it('needs a signed-in user; stores for that user with device "web"; logs one summary when something new arrived', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/api/plays', payload: { events: [] } })).statusCode).toBe(401);
    m.recordPlayEvents.mockResolvedValue({ ok: true, counted: 2, result: { accepted: 3, duplicates: 0, rejected: [] } });
    const res = await a.inject({ method: 'POST', url: '/api/plays', headers: USER, payload: { events: [{}] } });
    expect(res.json()).toEqual({ accepted: 3, duplicates: 0, rejected: [] });
    expect(m.recordPlayEvents.mock.calls[0].slice(0, 2)).toEqual(['sara', 'web']);
    expect(m.logActivity).toHaveBeenCalledWith('device', 'plays', 'sara (web) ha inviato 3 ascolti (2 contati)', { user: 'sara', device: 'web', channel: 'web' }, expect.objectContaining({ accepted: 3, counted: 2 }));
  });

  it('a batch with nothing new is silent; limits keep their status', async () => {
    const a = app();
    m.recordPlayEvents.mockResolvedValueOnce({ ok: true, counted: 0, result: { accepted: 0, duplicates: 2, rejected: [] } });
    await a.inject({ method: 'POST', url: '/api/plays', headers: USER, payload: { events: [{}] } });
    expect(m.logActivity).not.toHaveBeenCalled();
    m.recordPlayEvents.mockResolvedValueOnce({ ok: false, status: 413, error: 'too_many_events' });
    expect((await a.inject({ method: 'POST', url: '/api/plays', headers: USER, payload: { events: [] } })).statusCode).toBe(413);
  });
});
