/**
 * How the site is used, to decide the phone UX with facts (spec 2026-11-08-web-mobile-ux-design.md, M8; the Traefik
 * access log has no user-agent, so it cannot tell a phone from a desktop).
 *
 * AGGREGATED counters only: per day, user, kind of device, network and route group, a number of calls. The
 * user-agent is read to pick the kind of device and then forgotten; the IP, the path and the query string are never
 * stored. Counting happens in memory and is flushed to `usage_counters` every minute, so a request never waits for it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query } from '../utils/db';
import { logWarning } from '../utils/logger';
import { classifyNetwork } from '../utils/network';
import { ANONYMOUS_USER, normalizeFamilyUser } from '../utils/requestUser';

export type DeviceClass = 'mobile-web' | 'desktop-web' | 'app' | 'automation' | 'other';
export type RouteGroup =
  | 'entries' | 'search' | 'playlists' | 'songs' | 'share' | 'analyze' | 'inbox' | 'stats' | 'software'
  | 'films' | 'notes' | 'settings' | 'media' | 'other';

/** The Mondrop app (and its Share extension) identify themselves by name; scripts and monitors by their tool. */
export function classifyDevice(userAgent: string | undefined): DeviceClass {
  const ua = (userAgent ?? '').trim();
  if (!ua) return 'other';
  if (/mondrop/i.test(ua)) return 'app';
  if (/curl\/|wget|python-requests|python-urllib|aiohttp|node-fetch|undici|axios|okhttp|go-http-client|httpie|postman|insomnia|headlesschrome|bot\b|spider|crawler|monitor|uptime|^node$/i.test(ua)) {
    return 'automation';
  }
  if (/mozilla\//i.test(ua)) return /iphone|ipod|ipad|android|mobile/i.test(ua) ? 'mobile-web' : 'desktop-web';
  return 'other';
}

const GROUPS: Array<[RegExp, RouteGroup]> = [
  [/^\/api\/mondrop\/(inbox|received|push)\b/, 'inbox'],
  [/^\/api\/mondrop\/(plays|device-events)\b/, 'stats'],
  [/^\/api\/mondrop\/playlists\b/, 'playlists'],
  [/^\/api\/mondrop\/(songs|library|net)\b/, 'songs'],
  [/^\/api\/entries\/:?[\w-]*\/?media\b/, 'media'],
  [/^\/api\/media\b/, 'media'],
  [/^\/api\/entries\b/, 'entries'],
  [/^\/api\/(search|library)\b/, 'search'],
  [/^\/api\/playlists\b/, 'playlists'],
  [/^\/api\/songs\b/, 'songs'],
  [/^\/api\/share\b/, 'share'],
  [/^\/api\/analyze\b/, 'analyze'],
  [/^\/api\/stats\b/, 'stats'],
  [/^\/api\/software\b/, 'software'],
  [/^\/api\/films\b/, 'films'],
  [/^\/api\/notes\b/, 'notes'],
  [/^\/api\/(config|prompts|admin|logs|me)\b/, 'settings'],
];

/** The group of a route pattern (`/api/entries/:id`), or `null` for what is not an API call (pages, files, health). */
export function routeGroup(pattern: string | undefined): RouteGroup | null {
  if (!pattern || !pattern.startsWith('/api/')) return null;
  for (const [re, group] of GROUPS) if (re.test(pattern)) return group;
  return 'other';
}

const isLoopback = (ip: string | undefined): boolean => !ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

/** Who is calling, as far as an unauthenticated read can tell: the Authelia user, else the app's own hint. */
function userOf(req: FastifyRequest): string {
  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const q = (req.query as { user?: unknown } | undefined)?.user;
  return (
    normalizeFamilyUser(header('remote-user')) ??
    normalizeFamilyUser(header('x-soundreel-user')) ??
    normalizeFamilyUser(typeof q === 'string' ? q : undefined) ??
    ANONYMOUS_USER
  );
}

export interface UsageKey {
  day: string;
  user: string;
  device: DeviceClass;
  network: 'internal' | 'external';
  group: RouteGroup;
}

const keyOf = (k: UsageKey): string => [k.day, k.user, k.device, k.network, k.group].join('|');
const MAX_BUFFER_KEYS = 5000;
const CHUNK = 150;

const buffer = new Map<string, number>();

/** What one request counts as, or `null` when it is not counted (not an API call, or the server calling itself). */
export function usageKeyFor(req: FastifyRequest, now: Date = new Date()): UsageKey | null {
  // The job worker calls /api/analyze on loopback: that is the server talking to itself, not a use of the site.
  if (isLoopback(req.ip)) return null;
  const group = routeGroup(req.routeOptions?.url);
  if (!group) return null;
  const ua = req.headers['user-agent'];
  return {
    day: now.toISOString().slice(0, 10),
    user: userOf(req),
    device: classifyDevice(Array.isArray(ua) ? ua[0] : ua),
    network: classifyNetwork(req.headers).network,
    group,
  };
}

export function countUsage(key: UsageKey, calls = 1): void {
  const k = keyOf(key);
  if (!buffer.has(k) && buffer.size >= MAX_BUFFER_KEYS) return; // a stuck database must not grow memory without end
  buffer.set(k, (buffer.get(k) ?? 0) + calls);
}

export const pendingUsageKeys = (): number => buffer.size;

/** Writes the buffered counts. On failure they stay in the buffer for the next minute. */
export async function flushUsage(): Promise<number> {
  if (buffer.size === 0) return 0;
  const taken = [...buffer.entries()];
  buffer.clear();
  let written = 0;
  try {
    for (let i = 0; i < taken.length; i += CHUNK) {
      const chunk = taken.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const rows = chunk.map(([k, calls], idx) => {
        const [day, user, device, network, group] = k.split('|');
        params.push(day, user, device, network, group, calls);
        const o = idx * 6;
        return `($${o + 1}::date, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}::int)`;
      });
      await query(
        `INSERT INTO usage_counters (day, user_id, device_class, network, route_group, calls)
         VALUES ${rows.join(', ')}
         ON CONFLICT (day, user_id, device_class, network, route_group)
         DO UPDATE SET calls = usage_counters.calls + EXCLUDED.calls`,
        params,
      );
      written += chunk.length;
    }
  } catch (err) {
    for (const [k, calls] of taken.slice(written)) buffer.set(k, (buffer.get(k) ?? 0) + calls);
    logWarning('usage counters not flushed (kept for the next try)', { error: err instanceof Error ? err.message : String(err) });
  }
  return written;
}

/** Counts every API response and flushes once a minute. Returns the function that stops it (flushing a last time). */
export function startUsageCounters(app: FastifyInstance, intervalMs = 60_000): () => void {
  app.addHook('onResponse', async (req) => {
    try {
      const key = usageKeyFor(req);
      if (key) countUsage(key);
    } catch {
      /* counting must never touch a response */
    }
  });
  const timer = setInterval(() => void flushUsage(), intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    void flushUsage();
  };
}

// ---------------------------------------------------------------------------
// Reading (admin)
// ---------------------------------------------------------------------------

export interface UsageReport {
  days: number;
  since: string;
  total: number;
  /** Calls per kind of device. */
  byDevice: Record<string, number>;
  /** For each kind of device, the route groups, most used first: what people do from a phone. */
  byDeviceAndGroup: Record<string, Array<{ group: string; calls: number }>>;
  byUser: Record<string, number>;
  byNetwork: Record<string, number>;
  byDay: Array<{ day: string; calls: number; mobileWeb: number; desktopWeb: number; app: number }>;
}

interface UsageRow {
  day: string;
  user_id: string;
  device_class: string;
  network: string;
  route_group: string;
  calls: number;
}

export const clampDays = (raw: unknown): number => {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 90) : 14;
};

export function summarizeUsage(rows: UsageRow[], days: number, since: string): UsageReport {
  const add = (m: Record<string, number>, k: string, n: number): void => {
    m[k] = (m[k] ?? 0) + n;
  };
  const report: UsageReport = { days, since, total: 0, byDevice: {}, byDeviceAndGroup: {}, byUser: {}, byNetwork: {}, byDay: [] };
  const groups = new Map<string, Map<string, number>>();
  const perDay = new Map<string, { day: string; calls: number; mobileWeb: number; desktopWeb: number; app: number }>();
  for (const r of rows) {
    report.total += r.calls;
    add(report.byDevice, r.device_class, r.calls);
    add(report.byUser, r.user_id, r.calls);
    add(report.byNetwork, r.network, r.calls);
    const g = groups.get(r.device_class) ?? new Map<string, number>();
    g.set(r.route_group, (g.get(r.route_group) ?? 0) + r.calls);
    groups.set(r.device_class, g);
    const d = perDay.get(r.day) ?? { day: r.day, calls: 0, mobileWeb: 0, desktopWeb: 0, app: 0 };
    d.calls += r.calls;
    if (r.device_class === 'mobile-web') d.mobileWeb += r.calls;
    if (r.device_class === 'desktop-web') d.desktopWeb += r.calls;
    if (r.device_class === 'app') d.app += r.calls;
    perDay.set(r.day, d);
  }
  for (const [device, g] of groups) {
    report.byDeviceAndGroup[device] = [...g.entries()].map(([group, calls]) => ({ group, calls })).sort((a, b) => b.calls - a.calls);
  }
  report.byDay = [...perDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  return report;
}

/** What `GET /api/admin/usage?days=14` returns: the last N days, flushed first so the answer is current. */
export async function readUsage(daysRaw: unknown, now: Date = new Date()): Promise<UsageReport> {
  await flushUsage();
  const days = clampDays(daysRaw);
  const since = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await query<UsageRow>(
    `SELECT day::text AS day, user_id, device_class, network, route_group, calls
       FROM usage_counters WHERE day >= $1::date ORDER BY day DESC`,
    [since],
  );
  return summarizeUsage(rows, days, since);
}

/** Tests only. */
export function resetUsageBufferForTests(): void {
  buffer.clear();
}
