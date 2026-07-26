import type { AggregatedFilm } from '../types';

export type WatchedFilter = 'all' | 'watched' | 'unwatched';
export type AvailabilityFilter = 'all' | 'free' | 'notfree';

export interface FilmFilterOptions {
  genres: string[];
  watched: WatchedFilter;
  availability: AvailabilityFilter;
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
      const statuses = Object.values(film.meta?.availability ?? {});
      const hasFree = statuses.includes('free');
      if (opts.availability === 'free' && !hasFree) return false;
      if (opts.availability === 'notfree' && (hasFree || statuses.length === 0)) return false;
    }
    return true;
  });
}

export function collectGenres(films: AggregatedFilm[]): string[] {
  const set = new Set<string>();
  for (const film of films) for (const g of film.meta?.genres ?? []) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}
