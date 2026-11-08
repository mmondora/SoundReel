/**
 * Console helpers for the activity lines (docs/superpowers/specs/2026-11-07-listening-stats-dynamic-playlists-design.md §4).
 * The backend writes them in the existing `logs` table with category `playlist` / `sync` / `download` / `device` and,
 * in the line's data, `action` and `actor = { user, device, channel }`.
 */

export const ACTIVITY_CATEGORIES = ['playlist', 'sync', 'download', 'device'] as const;

/** The first option of the "function" select: every activity category at once. */
export const ACTIVITY_FILTER = '@activity';

/**
 * What to send as `category` for the selected function. The function of a log line IS its category, so the server
 * can filter instead of the client picking through only the latest 200 lines of every kind. Nothing is sent for
 * "all" and for the placeholder "unknown" (lines without a category).
 */
export function categoryParamFor(functionFilter: string): string | undefined {
  if (functionFilter === 'all' || functionFilter === 'unknown') return undefined;
  if (functionFilter === ACTIVITY_FILTER) return ACTIVITY_CATEGORIES.join(',');
  return functionFilter;
}

/** Client-side check, kept as a safety net (an old backend ignores `category`). */
export function matchesFunction(logFunction: string, functionFilter: string): boolean {
  if (functionFilter === 'all') return true;
  if (functionFilter === ACTIVITY_FILTER) return (ACTIVITY_CATEGORIES as readonly string[]).includes(logFunction);
  return logFunction === functionFilter;
}

/**
 * The functions offered by the select. With a server-side filter a fetch only contains the selected category,
 * so the list must accumulate what was ever seen (and always offer the activity categories).
 */
export function mergeFunctions(previous: ReadonlySet<string>, fetched: readonly string[]): string[] {
  return [...new Set([...ACTIVITY_CATEGORIES, ...previous, ...fetched])].sort((a, b) => a.localeCompare(b));
}

export interface LogActor {
  user: string;
  device: string | null;
  channel: string | null;
}

export function readActor(data: Record<string, unknown> | null | undefined): LogActor | null {
  const raw = data?.actor;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const user = typeof a.user === 'string' ? a.user.trim() : '';
  if (!user) return null;
  const device = typeof a.device === 'string' && a.device.trim() ? a.device.trim() : null;
  const channel = typeof a.channel === 'string' && a.channel.trim() ? a.channel.trim() : null;
  return { user, device, channel };
}

/** "mike · iPhone di Michele", or just "mike" on the web. */
export function actorLabel(actor: LogActor): string {
  return actor.device ? `${actor.user} · ${actor.device}` : actor.user;
}
