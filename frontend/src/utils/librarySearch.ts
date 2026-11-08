/**
 * Library search over three places (spec 2026-11-07-library-search-music-folders-design.md): the journal songs,
 * the whole media server, the local music folders. The server searches and ranks; what lives here is what the page
 * needs around it — when to search, how to read the counts, how to group and format a hit.
 */
import type {
  LibraryHit,
  LibraryHitScope,
  LibraryScope,
  LibrarySearchCounts,
  LibrarySearchResponse,
} from '../types';
import type { ApiErrorInfo } from './apiError';

/** Shorter than this the server answers 400 `query_too_short`, so the page does not even ask. */
export const MIN_QUERY_LENGTH = 2;
/** Results per scope asked of the server (its own cap). */
export const SEARCH_LIMIT = 100;
export const SEARCH_DEBOUNCE_MS = 300;

/** The order of the selector: the journal first (what the page always showed), then the two new places, then all. */
export const SCOPE_OPTIONS: readonly LibraryScope[] = ['songs', 'media', 'local', 'all'];
/** The order results are grouped in. */
export const HIT_SCOPES: readonly LibraryHitScope[] = ['songs', 'media', 'local'];

/** The text as the server sees it: trimmed, inner spaces collapsed. */
export const normalizeQuery = (text: string): string => text.trim().replace(/\s+/g, ' ');

export const canSearch = (text: string): boolean => normalizeQuery(text).length >= MIN_QUERY_LENGTH;

/** Matches in one scope; "all" is the sum of the three. */
export function scopeCount(counts: LibrarySearchCounts, scope: LibraryScope): number {
  return scope === 'all' ? counts.songs + counts.media + counts.local : counts[scope];
}

export interface HitGroup {
  scope: LibraryHitScope;
  hits: LibraryHit[];
  /** Matches in this scope before the limit (may be more than `hits.length`). */
  total: number;
}

/**
 * The hits of the chosen scope, grouped per place in a fixed order. The page always asks the server for every
 * scope (it only counts the scopes it searched), so choosing a scope is a filter on what is already there.
 */
export function groupHits(response: LibrarySearchResponse, scope: LibraryScope): HitGroup[] {
  const scopes = scope === 'all' ? HIT_SCOPES : [scope];
  return scopes
    .map((s): HitGroup => {
      const hits = response.results.filter((h) => h.scope === s);
      return { scope: s, hits, total: Math.max(response.counts[s], hits.length) };
    })
    .filter((g) => g.hits.length > 0);
}

/** The other scopes that have matches (for "not in the library, but found elsewhere"). */
export function elsewhere(counts: LibrarySearchCounts, exclude: LibraryScope): Array<{ scope: LibraryHitScope; count: number }> {
  return HIT_SCOPES
    .filter((s) => s !== exclude && counts[s] > 0)
    .map((s) => ({ scope: s, count: counts[s] }));
}

/** "5,1 MB" (decimal comma in Italian); empty when the size is unknown. */
export function formatBytes(bytes: number | null | undefined, locale = 'it-IT'): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  const text = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return `${text} ${units[unit]}`;
}

export type SearchFailure = 'tooShort' | 'scope' | 'forbidden' | 'network' | 'server';

/** What to tell the user about a failed search. */
export function searchFailure(info: ApiErrorInfo): SearchFailure {
  if (info.code === 'query_too_short') return 'tooShort';
  if (info.code === 'invalid_scope') return 'scope';
  if (info.code === 'forbidden' || info.status === 401 || info.status === 403) return 'forbidden';
  if (info.code === 'network') return 'network';
  return 'server';
}
