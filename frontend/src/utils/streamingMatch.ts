import type { StreamingUrls } from '../types';

// Explicit per-service alias lists (not short UI labels). Matching a
// real-world platform name is a data concern; keep in sync with FilmCard badges.
const SERVICE_ALIASES: Record<keyof StreamingUrls, string[]> = {
  netflix: ['netflix'],
  primeVideo: ['prime video', 'amazon prime', 'prime', 'amazon'],
  raiPlay: ['raiplay', 'rai play'],
  now: ['now tv', 'now'],
  disneyPlus: ['disney plus', 'disney+', 'disney'],
  appleTv: ['apple tv', 'appletv', 'itunes'],
};

const ALIAS_ENTRIES: Array<{ key: keyof StreamingUrls; alias: string }> = (
  Object.entries(SERVICE_ALIASES) as Array<[keyof StreamingUrls, string[]]>
)
  .flatMap(([key, aliases]) => aliases.map((alias) => ({ key, alias })))
  .sort((a, b) => b.alias.length - a.alias.length);

function aliasMatches(lower: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(lower);
}

/**
 * Best-effort match between an API platform name (e.g. "Amazon Prime Video")
 * and one of our known services.
 */
export function matchService(platform: string): keyof StreamingUrls | undefined {
  const lower = platform.toLowerCase();
  return ALIAS_ENTRIES.find(({ alias }) => aliasMatches(lower, alias))?.key;
}
