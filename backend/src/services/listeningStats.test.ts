import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/db', () => ({ query: queryMock }));

import { fillDays, getListeningStats, getRecentPlays, getSongPlayStats, isDay } from './listeningStats';

beforeEach(() => queryMock.mockReset());

describe('isDay', () => {
  it('accepts real calendar days only', () => {
    expect(isDay('2026-11-08')).toBe(true);
    for (const bad of ['2026-13-01', '2026-02-30x', '08/11/2026', '', null, 5, '2026-11-8']) expect(isDay(bad)).toBe(false);
  });
});

describe('fillDays (a chart has no holes)', () => {
  it('returns one row per calendar day, zeros included, in order', () => {
    const out = fillDays('2026-11-06', '2026-11-09', [{ day: '2026-11-07', plays: 3, listenedMs: 9000 }, { day: '2026-11-09', plays: 1, listenedMs: 500 }]);
    expect(out).toEqual([
      { day: '2026-11-06', plays: 0, listenedMs: 0 }, { day: '2026-11-07', plays: 3, listenedMs: 9000 },
      { day: '2026-11-08', plays: 0, listenedMs: 0 }, { day: '2026-11-09', plays: 1, listenedMs: 500 },
    ]);
  });
  it('a one-day period is one row; an inverted period is empty; it never explodes on a huge range', () => {
    expect(fillDays('2026-11-08', '2026-11-08', [])).toHaveLength(1);
    expect(fillDays('2026-11-09', '2026-11-08', [])).toEqual([]);
    expect(fillDays('1900-01-01', '2100-01-01', []).length).toBeLessThanOrEqual(3700);
  });
});

describe('getListeningStats', () => {
  // The nine queries run in this order inside Promise.all.
  const answers = () => [
    [{ plays: '17', skips: '2', listened_ms: '2118000', songs: '5', artists: '4', devices: '1' }],
    [{ day: '2026-11-07', plays: '4', listened_ms: '800000' }],
    [{ dow: 0, hour: 7, plays: '3' }, { dow: 4, hour: 23, plays: '2' }, { dow: 9, hour: 99, plays: '50' }],
    [{ song_key: 'a::b', plays: '9', listened_ms: '900000', last_at: '2026-11-07T07:05:00Z' }],
    [{ artist: 'a', plays: '9' }],
    [{ genre: 'Alternativa', plays: '4' }, { genre: 'Alternative', plays: '3' }, { genre: 'Jazz', plays: '5' }],
    [{ device: 'iPhone di Michele', plays: '15', listened_ms: '1' }, { device: '', plays: '2', listened_ms: '2' }],
    [{ origin: 'local', plays: '15', listened_ms: '1' }],
    [{ song_key: 'a::b' }, { song_key: 'c::d' }],
  ];

  it('shapes every aggregate (numbers from pg strings, merged genres, 7×24 heatmap, a name for an unnamed device)', async () => {
    for (const a of answers()) queryMock.mockResolvedValueOnce(a);
    const s = await getListeningStats({ userIds: ['mike'], from: '2026-11-07', to: '2026-11-08' });
    expect(s.totals).toEqual({ plays: 17, skips: 2, listenedMs: 2118000, songs: 5, artists: 4, devices: 1 });
    expect(s.perDay).toEqual([{ day: '2026-11-07', plays: 4, listenedMs: 800000 }, { day: '2026-11-08', plays: 0, listenedMs: 0 }]);
    expect(s.heatmap).toHaveLength(7);
    expect(s.heatmap.every((r) => r.length === 24)).toBe(true);
    expect(s.heatmap[0][7]).toBe(3);
    expect(s.heatmap[4][23]).toBe(2);
    expect(s.heatmap.flat().reduce((a, b) => a + b, 0)).toBe(5); // the impossible (dow 9, hour 99) cell is ignored
    expect(s.topGenres).toEqual([{ genre: 'Alternative', plays: 7 }, { genre: 'Jazz', plays: 5 }]); // Alternativa + Alternative merged
    expect(s.topSongs).toEqual([{ songKey: 'a::b', plays: 9, listenedMs: 900000, lastPlayedAt: '2026-11-07T07:05:00.000Z' }]);
    expect(s.perDevice.map((d) => d.device)).toEqual(['iPhone di Michele', 'sconosciuto']);
    expect(s.playedSongKeys).toEqual(['a::b', 'c::d']);
    expect(s.period).toEqual({ from: '2026-11-07', to: '2026-11-08' });
  });

  it('every query gets the same user/period/device filter; "all users" is null; the played-songs query ignores the period', async () => {
    for (const a of answers()) queryMock.mockResolvedValueOnce(a);
    await getListeningStats({ userIds: null, device: 'web', from: '2026-11-01', to: '2026-11-08' });
    const calls = queryMock.mock.calls as Array<[string, unknown[]]>;
    expect(calls).toHaveLength(9);
    for (const [, params] of calls.slice(0, 8)) expect(params).toEqual([null, '2026-11-01', '2026-11-08', 'web']);
    expect(calls[8][1]).toEqual([null]);
    expect(calls[5][0]).toMatch(/e\.user_id/); // the joined genres query uses the alias everywhere
    expect(calls[5][0]).not.toMatch(/[^.]\buser_id = ANY/);
  });
});

describe('getRecentPlays / getSongPlayStats', () => {
  it('maps recent plays, clamps the limit, scopes by user and device', async () => {
    queryMock.mockResolvedValue([{
      id: 'x', user_id: 'mike', device: 'web', song_key: 'a::b', started_at: '2026-11-08T06:12:03Z', local_started_at: '2026-11-08T07:12:03.000',
      listened_ms: 100, duration_ms: null, counted: true, completed: false, origin: 'web',
    }]);
    const out = await getRecentPlays({ userIds: ['mike'], device: 'web' }, 9999);
    expect(out[0]).toMatchObject({ songKey: 'a::b', localStartedAt: '2026-11-08T07:12:03.000', counted: true });
    expect((queryMock.mock.calls[0] as [string, unknown[]])[1]).toEqual([['mike'], 'web', 200]);
  });

  it('per-song numbers: plays and last time per song, nothing without keys', async () => {
    expect((await getSongPlayStats('mike', [])).size).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
    queryMock.mockResolvedValue([{ song_key: 'a::b', plays: 12, last_at: '2026-11-05T21:03:11Z' }, { song_key: 'c::d', plays: 0, last_at: null }]);
    const m = await getSongPlayStats('mike', ['a::b', 'c::d', 'e::f']);
    expect(m.get('a::b')).toEqual({ plays: 12, lastPlayedAt: '2026-11-05T21:03:11.000Z' });
    expect(m.get('c::d')).toEqual({ plays: 0, lastPlayedAt: null });
    expect(m.has('e::f')).toBe(false);
  });
});
