import { describe, it, expect } from 'vitest';
import { filterFilms, collectGenres } from './filmFilters';
import type { AggregatedFilm } from '../types';

function film(key: string, meta: Partial<NonNullable<AggregatedFilm['meta']>> | null): AggregatedFilm {
  return {
    filmKey: key, title: key, director: null, year: null, imdbUrl: null,
    posterUrl: null, streamingUrls: null, mentions: [],
    meta: meta === null ? null : {
      filmKey: key, tmdbId: null, genres: [], overview: null, cast: [],
      tmdbScore: null, watched: false, rating: null, score: null, availability: {},
      ...meta,
    },
  };
}

const FILMS = [
  film('a', { genres: ['Thriller'], watched: true, availability: { netflix: 'free' } }),
  film('b', { genres: ['Fantascienza', 'Thriller'], availability: { primeVideo: 'paid' } }),
  film('c', null),
];

describe('filterFilms', () => {
  it('no filters returns everything', () => {
    expect(filterFilms(FILMS, { genres: [], watched: 'all', availability: 'all' })).toHaveLength(3);
  });
  it('genre filter is OR across selected genres', () => {
    const out = filterFilms(FILMS, { genres: ['Fantascienza'], watched: 'all', availability: 'all' });
    expect(out.map((f) => f.filmKey)).toEqual(['b']);
  });
  it('watched / unwatched split; missing meta counts as unwatched', () => {
    expect(filterFilms(FILMS, { genres: [], watched: 'watched', availability: 'all' }).map((f) => f.filmKey)).toEqual(['a']);
    expect(filterFilms(FILMS, { genres: [], watched: 'unwatched', availability: 'all' }).map((f) => f.filmKey)).toEqual(['b', 'c']);
  });
  it('availability free = at least one service marked free', () => {
    expect(filterFilms(FILMS, { genres: [], watched: 'all', availability: 'free' }).map((f) => f.filmKey)).toEqual(['a']);
  });
  it('availability notfree = has marks but none free', () => {
    expect(filterFilms(FILMS, { genres: [], watched: 'all', availability: 'notfree' }).map((f) => f.filmKey)).toEqual(['b']);
  });
});

describe('collectGenres', () => {
  it('unique sorted genre list', () => {
    expect(collectGenres(FILMS)).toEqual(['Fantascienza', 'Thriller']);
  });
});
