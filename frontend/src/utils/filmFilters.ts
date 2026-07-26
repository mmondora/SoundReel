import type { AggregatedFilm, FilmMetaRecord } from '../types';

export type WatchedFilter = 'all' | 'watched' | 'unwatched';
export type AvailabilityFilter = 'all' | 'free' | 'notfree';

export interface FilmFilterOptions {
  genres: string[];
  watched: WatchedFilter;
  availability: AvailabilityFilter;
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

export function filterFilms(films: AggregatedFilm[], opts: FilmFilterOptions): AggregatedFilm[] {
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
    return true;
  });
}

export function collectGenres(films: AggregatedFilm[]): string[] {
  const set = new Set<string>();
  for (const film of films) for (const g of film.meta?.genres ?? []) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}
