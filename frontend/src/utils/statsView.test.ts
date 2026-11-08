import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATS_FILTERS,
  buildStatsQuery,
  fillDays,
  formatClock,
  formatListened,
  heatLevel,
  heatmapPeak,
  isEmptyStats,
  localDay,
  normalizeRecent,
  normalizeStats,
  periodRange,
  statsScopeOptions,
} from './statsView';
import type { StatsFilters } from './statsView';

const ADMIN = { user: 'mike', isAdmin: true };
const USER = { user: 'sara', isAdmin: false };
const NOW = new Date(2026, 10, 8, 21, 30); // 8 Nov 2026, local

describe('periodRange', () => {
  it('N days = today and the N-1 days before it, on the local calendar', () => {
    expect(periodRange(7, NOW)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(periodRange(30, NOW)).toEqual({ from: '2026-10-10', to: '2026-11-08' });
    expect(periodRange(365, NOW)).toEqual({ from: '2025-11-09', to: '2026-11-08' });
  });

  it('crosses month and year ends', () => {
    expect(periodRange(7, new Date(2026, 0, 3))).toEqual({ from: '2025-12-28', to: '2026-01-03' });
  });

  it('"all" has no bounds', () => {
    expect(periodRange('all', NOW)).toEqual({});
  });

  it('localDay uses the local date, not UTC', () => {
    expect(localDay(new Date(2026, 5, 1, 0, 30))).toBe('2026-06-01');
  });
});

describe('statsScopeOptions + buildStatsQuery: who may ask for what', () => {
  const asksEverything: StatsFilters = { period: 7, scope: 'all', user: 'archi', device: 'iPhone di Michele' };

  it('an admin may pick the scope, a user and a device', () => {
    expect(statsScopeOptions(ADMIN)).toEqual(['me', 'all']);
    expect(buildStatsQuery(asksEverything, ADMIN, NOW, 'Europe/Rome')).toEqual({
      scope: 'all', from: '2026-11-02', to: '2026-11-08', user: 'archi', device: 'iPhone di Michele', tz: 'Europe/Rome',
    });
  });

  it('an admin on "me" sends no user filter (it would be meaningless) but may filter a device', () => {
    expect(buildStatsQuery({ ...asksEverything, scope: 'me' }, ADMIN, NOW)).toEqual({
      scope: 'me', from: '2026-11-02', to: '2026-11-08', device: 'iPhone di Michele',
    });
  });

  it('a non-admin is pinned to their own numbers, whatever the filter state holds', () => {
    expect(statsScopeOptions(USER)).toEqual(['me']);
    expect(statsScopeOptions(null)).toEqual(['me']);
    for (const viewer of [USER, null]) {
      const q = buildStatsQuery(asksEverything, viewer, NOW, 'Europe/Rome');
      expect(q.scope).toBe('me');
      expect(q).not.toHaveProperty('user');
      expect(q).not.toHaveProperty('device');
      expect(JSON.stringify(q)).not.toContain('all');
    }
  });

  it('default filters: me, last 30 days, nobody in particular', () => {
    expect(DEFAULT_STATS_FILTERS).toEqual({ period: 30, scope: 'me', user: '', device: '' });
    expect(buildStatsQuery(DEFAULT_STATS_FILTERS, ADMIN, NOW)).toEqual({ scope: 'me', from: '2026-10-10', to: '2026-11-08' });
  });

  it('"all time" sends no dates', () => {
    expect(buildStatsQuery({ ...DEFAULT_STATS_FILTERS, period: 'all' }, USER, NOW)).toEqual({ scope: 'me' });
  });
});

describe('normalizeStats', () => {
  const payload = {
    totals: { plays: 120, skips: 30, listenedMs: 36_000_000, songs: 80, artists: 41, devices: 3 },
    perDay: [
      { day: '2026-11-03', plays: 4, listenedMs: 900_000 },
      { day: '2026-11-01', plays: 9, listenedMs: 2_000_000 },
    ],
    heatmap: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 0 && h === 7 ? 12 : 0))),
    topSongs: [{ songKey: 'bishop briggs::white flag', title: 'White Flag', artist: 'Bishop Briggs', plays: 9 }],
    topArtists: [{ artist: 'Bishop Briggs', plays: 15 }],
    topGenres: [{ genre: 'Rock', plays: 40 }],
    perDevice: [{ device: 'iPhone di Michele', plays: 70, listenedMs: 1000 }],
    perOrigin: [{ origin: 'web', plays: 50 }],
    neverPlayed: 512,
    period: { from: '2026-10-10', to: '2026-11-08' },
  };

  it('reads the contract payload', () => {
    const s = normalizeStats(payload);
    expect(s.totals).toEqual({ plays: 120, skips: 30, listenedMs: 36_000_000, songs: 80, artists: 41, devices: 3 });
    expect(s.perDay.map((d) => d.day)).toEqual(['2026-11-01', '2026-11-03']); // sorted
    expect(s.heatmap[0][7]).toBe(12);
    expect(s.topSongs[0]).toMatchObject({ key: 'bishop briggs::white flag', label: 'White Flag', sublabel: 'Bishop Briggs', plays: 9 });
    expect(s.topArtists[0]).toMatchObject({ label: 'Bishop Briggs', plays: 15 });
    expect(s.topGenres[0]).toMatchObject({ label: 'Rock', plays: 40 });
    expect(s.perDevice[0]).toMatchObject({ label: 'iPhone di Michele', plays: 70, listenedMs: 1000 });
    expect(s.perOrigin[0]).toMatchObject({ label: 'web', plays: 50, listenedMs: null });
    expect(s.neverPlayed).toBe(512);
    expect(s.period).toEqual({ from: '2026-10-10', to: '2026-11-08' });
  });

  it('accepts the obvious aliases of the total fields', () => {
    const s = normalizeStats({ totals: { countedPlays: 5, skipped: 2, distinctSongs: 3, distinctArtists: 2, devices: ['a', 'b'] } });
    expect(s.totals).toMatchObject({ plays: 5, skips: 2, songs: 3, artists: 2, devices: 2 });
  });

  it('never throws: garbage becomes zeros and empty lists', () => {
    for (const raw of [null, undefined, 5, 'x', [], {}, { totals: 3, perDay: 'x', heatmap: {} }]) {
      const s = normalizeStats(raw);
      expect(s.totals.plays).toBe(0);
      expect(s.perDay).toEqual([]);
      expect(s.heatmap).toHaveLength(7);
      expect(s.heatmap.every((row) => row.length === 24 && row.every((v) => v === 0))).toBe(true);
      expect(s.topSongs).toEqual([]);
      expect(isEmptyStats(s)).toBe(true);
    }
  });

  it('numbers sent as strings are read; non-numbers are zero', () => {
    const s = normalizeStats({ totals: { plays: '7', skips: 'many' } });
    expect(s.totals.plays).toBe(7);
    expect(s.totals.skips).toBe(0);
  });

  it('a heatmap can also arrive as a list of cells (0-based or ISO weekdays)', () => {
    const zeroBased = normalizeStats({ heatmap: [{ weekday: 0, hour: 8, plays: 3 }, { weekday: 6, hour: 23, plays: 1 }] });
    expect(zeroBased.heatmap[0][8]).toBe(3);
    expect(zeroBased.heatmap[6][23]).toBe(1);
    const iso = normalizeStats({ heatmap: [{ dow: 1, hour: 8, count: 3 }, { dow: 7, hour: 0, count: 2 }] });
    expect(iso.heatmap[0][8]).toBe(3);
    expect(iso.heatmap[6][0]).toBe(2);
  });

  it('a short heatmap is padded to 7 × 24', () => {
    const s = normalizeStats({ heatmap: [[1, 2, 3]] });
    expect(s.heatmap).toHaveLength(7);
    expect(s.heatmap[0].slice(0, 4)).toEqual([1, 2, 3, 0]);
    expect(s.heatmap[0]).toHaveLength(24);
  });

  it('isEmptyStats is false as soon as there is a play or a skip', () => {
    expect(isEmptyStats(normalizeStats({ totals: { plays: 1 } }))).toBe(false);
    expect(isEmptyStats(normalizeStats({ totals: { skips: 1 } }))).toBe(false);
    expect(isEmptyStats(normalizeStats({ perDay: [{ day: '2026-11-01', plays: 2 }] }))).toBe(false);
  });
});

describe('normalizeRecent', () => {
  it('accepts a list or a wrapper and fills the song from its key when the title is missing', () => {
    const list = normalizeRecent([
      { id: 'a', songKey: 'bishop briggs::white flag', user: 'mike', device: 'web', startedAt: '2026-11-08T06:12:03Z', listenedMs: 183000, counted: true },
      { title: 'X', artist: 'Y', startedAt: '2026-11-08T07:00:00Z', listenedMs: 4000, counted: false, origin: 'local' },
    ]);
    expect(list[0]).toMatchObject({ id: 'a', title: 'white flag', artist: 'bishop briggs', user: 'mike', device: 'web', counted: true, listenedMs: 183000 });
    expect(list[1]).toMatchObject({ title: 'X', artist: 'Y', counted: false, origin: 'local' });
    expect(normalizeRecent({ plays: [{ songKey: 'a::b' }] })).toHaveLength(1);
    expect(normalizeRecent({ recent: [{ songKey: 'a::b' }] })).toHaveLength(1);
    expect(normalizeRecent(null)).toEqual([]);
  });
});

describe('chart helpers', () => {
  it('fillDays adds a zero bar for every day without listening', () => {
    const filled = fillDays([
      { day: '2026-02-27', plays: 2, listenedMs: 10 },
      { day: '2026-03-02', plays: 1, listenedMs: 5 },
    ]);
    expect(filled.map((d) => [d.day, d.plays])).toEqual([['2026-02-27', 2], ['2026-02-28', 0], ['2026-03-01', 0], ['2026-03-02', 1]]);
    expect(fillDays([])).toEqual([]);
    expect(fillDays([{ day: '2026-01-01', plays: 1, listenedMs: 1 }])).toHaveLength(1);
  });

  it('fillDays is bounded', () => {
    expect(fillDays([{ day: '2020-01-01', plays: 1, listenedMs: 1 }, { day: '2026-01-01', plays: 1, listenedMs: 1 }], 400)).toHaveLength(400);
  });

  it('heatmapPeak finds the busiest cell, or null when empty', () => {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    expect(heatmapPeak(grid)).toBeNull();
    grid[2][19] = 5;
    grid[4][8] = 9;
    expect(heatmapPeak(grid)).toEqual({ weekday: 4, hour: 8, plays: 9 });
  });

  it('heatLevel: empty = 0, anything else at least faintly visible, max = 1', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 1000)).toBe(0.12);
    expect(heatLevel(5, 10)).toBe(0.5);
    expect(heatLevel(10, 10)).toBe(1);
    expect(heatLevel(3, 0)).toBe(0);
  });

  it('formatListened / formatClock', () => {
    expect(formatListened(0)).toBe('0 s');
    expect(formatListened(42_000)).toBe('42 s');
    expect(formatListened(17 * 60_000)).toBe('17 min');
    expect(formatListened(5 * 3_600_000 + 12 * 60_000)).toBe('5 h 12 min');
    expect(formatListened(2 * 3_600_000)).toBe('2 h');
    expect(formatClock(183_000)).toBe('3:03');
    expect(formatClock(4_000)).toBe('0:04');
  });
});
