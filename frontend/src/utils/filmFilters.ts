import type { AggregatedFilm, FilmMetaRecord, StreamingUrls } from '../types';
import { matchService } from './streamingMatch';

export type WatchedFilter = 'all' | 'watched' | 'unwatched';
export type AvailabilityFilter = 'all' | 'free' | 'notfree';
/** SoundReel "shelf" lists — platforms the user wants to open and play. */
export type PlatformShelfFilter = 'all' | 'netflix' | 'primeVideo' | 'raiPlay';

export const PLATFORM_SHELF_KEYS: Array<Exclude<PlatformShelfFilter, 'all'>> = [
  'netflix',
  'primeVideo',
  'raiPlay',
];

export interface FilmFilterOptions {
  genres: string[];
  watched: WatchedFilter;
  availability: AvailabilityFilter;
  /** Case-insensitive containment search over title, director, cast, genres. Empty/omitted = no filtering. */
  text?: string;
  /** When set (not 'all'), keep films available / linked on that platform. */
  platform?: PlatformShelfFilter;
}

/**
 * Per-film free/not-free availability signal, combining manual marks (user
 * overrides) with API-fetched streamingOptions:
 * - Any manual mark exists -> manual-only decision: free if any mark is
 *   'free'; notfree if marks exist and none is 'free' (API data ignored).
 * - No manual marks, streamingOptions is a non-empty array -> free if any
 *   option.is_free; notfree if the array is non-empty and none is free.
 * - No manual marks and streamingOptions is null (never checked) or `[]`
 *   (checked, available nowhere) -> no signal at all; matches only 'all'.
 *   `[]` deliberately does NOT count as notfree: "nowhere" isn't the same
 *   claim as "checked and confirmed not free somewhere".
 */
function availabilitySignal(meta: FilmMetaRecord | null | undefined): { free: boolean; notfree: boolean } {
  const manualStatuses = Object.values(meta?.availability ?? {});
  if (manualStatuses.length > 0) {
    const hasFree = manualStatuses.includes('free');
    return { free: hasFree, notfree: !hasFree };
  }

  const options = meta?.streamingOptions;
  if (options && options.length > 0) {
    const hasFree = options.some((o) => o.is_free);
    return { free: hasFree, notfree: !hasFree };
  }

  return { free: false, notfree: false };
}

/**
 * Best play/open URL for a platform shelf: prefer API deep link from
 * streamingOptions, else fall back to the search streamingUrls entry.
 */
export function platformPlayUrl(
  film: AggregatedFilm,
  platform: Exclude<PlatformShelfFilter, 'all'>
): string | null {
  const options = film.meta?.streamingOptions;
  if (options && options.length > 0) {
    const hit = options.find((o) => matchService(o.platform) === platform && !!o.url);
    if (hit?.url) return hit.url;
  }
  const searchUrl = film.streamingUrls?.[platform as keyof StreamingUrls];
  return searchUrl || null;
}

/** True when the film has a usable link (deep or search) for the shelf platform. */
export function filmOnPlatform(
  film: AggregatedFilm,
  platform: Exclude<PlatformShelfFilter, 'all'>
): boolean {
  return platformPlayUrl(film, platform) != null;
}

export function filterFilms(films: AggregatedFilm[], opts: FilmFilterOptions): AggregatedFilm[] {
  const query = opts.text?.trim().toLowerCase() ?? '';
  const platform = opts.platform ?? 'all';
  return films.filter((film) => {
    if (opts.genres.length > 0) {
      const genres = film.meta?.genres ?? [];
      if (!opts.genres.some((g) => genres.includes(g))) return false;
    }
    if (opts.watched !== 'all') {
      const watched = film.meta?.watched ?? false;
      if (opts.watched === 'watched' && !watched) return false;
      if (opts.watched === 'unwatched' && watched) return false;
    }
    if (opts.availability !== 'all') {
      const { free, notfree } = availabilitySignal(film.meta);
      if (opts.availability === 'free' && !free) return false;
      if (opts.availability === 'notfree' && !notfree) return false;
    }
    if (platform !== 'all' && !filmOnPlatform(film, platform)) return false;
    if (query) {
      const haystack = [
        film.title,
        film.director,
        ...(film.meta?.cast ?? []),
        ...(film.meta?.genres ?? []),
      ];
      if (!haystack.some((field) => field != null && field.toLowerCase().includes(query))) return false;
    }
    return true;
  });
}

export function collectGenres(films: AggregatedFilm[]): string[] {
  const set = new Set<string>();
  for (const film of films) for (const g of film.meta?.genres ?? []) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export type FilmSortMode = 'date' | 'mentions' | 'director';

function latestMentionTime(film: AggregatedFilm): number {
  return film.mentions[0] ? new Date(film.mentions[0].createdAt).getTime() : 0;
}

/**
 * Sort modes: 'date' = most recent mention first (default); 'mentions' =
 * mention count desc, ties by most recent mention; 'director' = director
 * alphabetical (films without a director last), ties by most recent mention.
 */
export function sortFilms(films: AggregatedFilm[], mode: FilmSortMode): AggregatedFilm[] {
  const byDate = (a: AggregatedFilm, b: AggregatedFilm) => latestMentionTime(b) - latestMentionTime(a);
  const sorted = [...films];
  if (mode === 'mentions') {
    sorted.sort((a, b) => b.mentions.length - a.mentions.length || byDate(a, b));
  } else if (mode === 'director') {
    sorted.sort((a, b) => {
      if (a.director == null && b.director == null) return byDate(a, b);
      if (a.director == null) return 1;
      if (b.director == null) return -1;
      return a.director.localeCompare(b.director) || byDate(a, b);
    });
  } else {
    sorted.sort(byDate);
  }
  return sorted;
}
