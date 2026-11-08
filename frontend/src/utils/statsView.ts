/**
 * Listening statistics dashboard: query building (with the admin-scope rules), tolerant normalisation of the
 * backend payload, and the small calculations the charts need. Contract: docs/mondrop-stats.md §5.
 *
 * Who sees what (D4): everybody sees THEIR OWN numbers (`scope=me`); only an admin may ask for everybody
 * (`scope=all`) and filter by user / device. `buildStatsQuery` enforces it even if the UI state says otherwise.
 */
import type { ListeningDay, ListeningRank, ListeningStats, RecentPlay } from '../types';
import type { StatsQuery } from '../services/api';

export const PERIODS = [7, 30, 90, 365, 'all'] as const;
export type StatsPeriod = (typeof PERIODS)[number];

export interface StatsViewer {
  user: string;
  isAdmin: boolean;
}

export interface StatsFilters {
  period: StatsPeriod;
  scope: 'me' | 'all';
  /** Admin only, with scope "all": one user; '' = everybody. */
  user: string;
  /** Admin only: one device; '' = all of them. */
  device: string;
}

export const DEFAULT_STATS_FILTERS: StatsFilters = { period: 30, scope: 'me', user: '', device: '' };

/** Scopes the viewer may ask for. */
export function statsScopeOptions(viewer: StatsViewer | null): Array<'me' | 'all'> {
  return viewer?.isAdmin ? ['me', 'all'] : ['me'];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** YYYY-MM-DD of the LOCAL calendar day (not UTC): "today" is what the user sees on their clock. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day range of a period ending today (inclusive). "all" has no bounds. */
export function periodRange(period: StatsPeriod, now: Date): { from?: string; to?: string } {
  if (period === 'all') return {};
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (period - 1));
  return { from: localDay(start), to: localDay(now) };
}

/**
 * The request to send. Non-admins (and an unknown viewer) are pinned to `scope=me` with no user/device filter,
 * whatever the filter state holds.
 */
export function buildStatsQuery(
  filters: StatsFilters,
  viewer: StatsViewer | null,
  now: Date,
  tz?: string,
): StatsQuery {
  const admin = viewer?.isAdmin === true;
  const scope: 'me' | 'all' = admin && filters.scope === 'all' ? 'all' : 'me';
  const query: StatsQuery = { scope, ...periodRange(filters.period, now) };
  if (admin && scope === 'all' && filters.user) query.user = filters.user;
  if (admin && filters.device) query.device = filters.device;
  if (tz) query.tz = tz;
  return query;
}

// ---------------------------------------------------------------------------
// Tolerant normalisation. The contract names the sections (totals, perDay, heatmap, topSongs, topArtists,
// topGenres, perDevice, perOrigin, neverPlayed, period) but not every inner field, so each reader accepts the
// obvious aliases and falls back to zero/empty instead of failing the whole page.
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function pickNum(obj: Record<string, unknown>, keys: readonly string[]): number {
  for (const k of keys) if (k in obj) return num(obj[k]);
  return 0;
}

function pickStr(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const s = str(obj[k]);
    if (s !== null) return s;
  }
  return null;
}

function listOf(raw: unknown, ...wrappers: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObject(raw)) for (const w of wrappers) if (Array.isArray(raw[w])) return raw[w] as unknown[];
  return [];
}

function readRanks(
  raw: unknown,
  opts: { key: string[]; label: string[]; sub?: string[]; plays?: string[] },
): ListeningRank[] {
  return listOf(raw).filter(isObject).map((item, i) => {
    const label = pickStr(item, opts.label) ?? '—';
    return {
      key: pickStr(item, opts.key) ?? `${label}#${i}`,
      label,
      sublabel: opts.sub ? pickStr(item, opts.sub) : null,
      plays: pickNum(item, opts.plays ?? ['plays', 'count', 'counted']),
      listenedMs: 'listenedMs' in item ? num(item.listenedMs) : null,
    };
  });
}

function readHeatmap(raw: unknown): number[][] {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  if (!Array.isArray(raw)) return grid;
  if (raw.every((row) => Array.isArray(row))) {
    for (let d = 0; d < 7; d += 1) {
      const row = raw[d] as unknown[] | undefined;
      for (let h = 0; h < 24; h += 1) grid[d][h] = num(row?.[h]);
    }
    return grid;
  }
  // [{ weekday|dow|day, hour, plays|count|value }] — weekday 0-6 (Monday = 0) or ISO 1-7
  const cells = raw.filter(isObject);
  const dayOf = (c: Record<string, unknown>): number => pickNum(c, ['weekday', 'dow', 'day', 'wd']);
  const iso = cells.some((c) => dayOf(c) === 7);
  for (const c of cells) {
    const d = dayOf(c) - (iso ? 1 : 0);
    const h = pickNum(c, ['hour', 'h']);
    if (d >= 0 && d < 7 && h >= 0 && h < 24) grid[d][h] = pickNum(c, ['plays', 'count', 'value', 'n']);
  }
  return grid;
}

export function normalizeStats(raw: unknown): ListeningStats {
  const root = isObject(raw) ? raw : {};
  const t = isObject(root.totals) ? root.totals : {};
  const period = isObject(root.period) ? root.period : {};
  const devicesRaw = t.devices;
  return {
    totals: {
      plays: pickNum(t, ['plays', 'countedPlays', 'counted']),
      skips: pickNum(t, ['skips', 'skipped']),
      listenedMs: pickNum(t, ['listenedMs', 'listened']),
      songs: pickNum(t, ['songs', 'distinctSongs', 'uniqueSongs']),
      artists: pickNum(t, ['artists', 'distinctArtists', 'uniqueArtists']),
      devices: Array.isArray(devicesRaw) ? devicesRaw.length : pickNum(t, ['devices', 'distinctDevices', 'uniqueDevices']),
    },
    perDay: listOf(root.perDay)
      .filter(isObject)
      .map((d): ListeningDay => ({ day: pickStr(d, ['day', 'date']) ?? '', plays: pickNum(d, ['plays', 'count']), listenedMs: pickNum(d, ['listenedMs']) }))
      .filter((d) => d.day !== '')
      .sort((a, b) => a.day.localeCompare(b.day)),
    heatmap: readHeatmap(root.heatmap),
    topSongs: readRanks(root.topSongs, { key: ['songKey', 'key'], label: ['title', 'name'], sub: ['artist'] }),
    topArtists: readRanks(root.topArtists, { key: ['artist', 'key', 'name'], label: ['artist', 'name'] }),
    topGenres: readRanks(root.topGenres, { key: ['genre', 'key', 'name'], label: ['genre', 'name'] }),
    perDevice: readRanks(root.perDevice, { key: ['device', 'key', 'name'], label: ['device', 'name', 'label'] }),
    perOrigin: readRanks(root.perOrigin, { key: ['origin', 'key', 'name'], label: ['origin', 'name', 'label'] }),
    neverPlayed: pickNum(root, ['neverPlayed', 'never_played']),
    period: { from: pickStr(period, ['from']) , to: pickStr(period, ['to']) },
  };
}

export function normalizeRecent(raw: unknown): RecentPlay[] {
  return listOf(raw, 'plays', 'recent', 'items')
    .filter(isObject)
    .map((r, i): RecentPlay => {
      const songKey = pickStr(r, ['songKey', 'key']) ?? '';
      const [fallbackArtist, ...rest] = songKey.split('::');
      return {
        id: pickStr(r, ['id']) ?? `recent-${i}`,
        songKey,
        title: pickStr(r, ['title']) ?? (rest.join('::') || songKey || '—'),
        artist: pickStr(r, ['artist']) ?? (rest.length > 0 ? fallbackArtist : ''),
        user: pickStr(r, ['user', 'userId']),
        device: pickStr(r, ['device']),
        origin: pickStr(r, ['origin']),
        startedAt: pickStr(r, ['startedAt', 'at', 'ts']) ?? '',
        listenedMs: pickNum(r, ['listenedMs']),
        counted: typeof r.counted === 'boolean' ? r.counted : null,
      };
    });
}

/** No events at all yet (a fresh install, or a period without listening). */
export function isEmptyStats(stats: ListeningStats): boolean {
  return stats.totals.plays === 0 && stats.totals.skips === 0 && stats.perDay.every((d) => d.plays === 0);
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

/** Every calendar day between the first and the last returned day (a day without listening is a zero bar). */
export function fillDays(perDay: readonly ListeningDay[], maxDays = 400): ListeningDay[] {
  if (perDay.length === 0) return [];
  const byDay = new Map(perDay.map((d) => [d.day, d]));
  const [y0, m0, d0] = perDay[0].day.split('-').map(Number);
  const last = perDay[perDay.length - 1].day;
  const out: ListeningDay[] = [];
  for (let i = 0; i < maxDays; i += 1) {
    const date = new Date(Date.UTC(y0, m0 - 1, d0 + i));
    const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    out.push(byDay.get(day) ?? { day, plays: 0, listenedMs: 0 });
    if (day >= last) break;
  }
  return out;
}

export function maxOf(values: readonly number[]): number {
  return values.reduce((m, v) => (v > m ? v : m), 0);
}

export interface HeatmapPeak {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  hour: number;
  plays: number;
}

export function heatmapPeak(grid: readonly (readonly number[])[]): HeatmapPeak | null {
  let best: HeatmapPeak | null = null;
  grid.forEach((row, weekday) => row.forEach((plays, hour) => {
    if (plays > 0 && (best === null || plays > best.plays)) best = { weekday, hour, plays };
  }));
  return best;
}

/** 0 → 0 … 1 for the colour scale; a non-empty cell is always at least faintly visible. */
export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(0.12, Math.min(1, value / max));
}

/** "42 s", "17 min", "5 h 12 min" (the same in Italian and English). */
export function formatListened(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** m:ss for one play. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
