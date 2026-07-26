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
      streamingOptions: null, streamingCheckedAt: null, watchmodeTitleId: null,
      ...meta,
    },
  };
}

const FILMS = [
  film('a', { genres: ['Thriller'], watched: true, availability: { netflix: 'free' } }),
  film('b', { genres: ['Fantascienza', 'Thriller'], availability: { primeVideo: 'paid' } }),
  film('c', null),
];

const API_FILMS = [
  // No manual marks, API data with a free option -> free.
  film('d', { streamingOptions: [{ platform: 'RaiPlay', type: 'FREE', is_free: true, price: null, url: 'https://x' }] }),
  // No manual marks, API data with no free option -> notfree.
  film('e', { streamingOptions: [{ platform: 'Netflix', type: 'SUBSCRIPTION', is_free: false, price: null, url: 'https://x' }] }),
  // Manual mark present (paid) takes priority over an API "free" option -> notfree.
  film('f', {
    availability: { netflix: 'paid' },
    streamingOptions: [{ platform: 'RaiPlay', type: 'FREE', is_free: true, price: null, url: 'https://x' }],
  }),
  // Checked, nowhere available (empty array) -> no signal, matches only 'all'.
  film('g', { streamingOptions: [] }),
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

  it('falls back to API streamingOptions when no manual marks exist', () => {
    expect(filterFilms(API_FILMS, { genres: [], watched: 'all', availability: 'free' }).map((f) => f.filmKey)).toEqual(['d']);
    expect(filterFilms(API_FILMS, { genres: [], watched: 'all', availability: 'notfree' }).map((f) => f.filmKey)).toContain('e');
  });

  it('manual marks take priority over API data when both exist', () => {
    const out = filterFilms(API_FILMS, { genres: [], watched: 'all', availability: 'notfree' });
    expect(out.map((f) => f.filmKey)).toContain('f');
    expect(filterFilms(API_FILMS, { genres: [], watched: 'all', availability: 'free' }).map((f) => f.filmKey)).not.toContain('f');
  });

  it('checked-empty streamingOptions ([]) has no availability signal', () => {
    expect(filterFilms(API_FILMS, { genres: [], watched: 'all', availability: 'free' }).map((f) => f.filmKey)).not.toContain('g');
    expect(filterFilms(API_FILMS, { genres: [], watched: 'all', availability: 'notfree' }).map((f) => f.filmKey)).not.toContain('g');
    expect(filterFilms(API_FILMS, { genres: [], watched: 'all', availability: 'all' }).map((f) => f.filmKey)).toContain('g');
  });
});

describe('collectGenres', () => {
  it('unique sorted genre list', () => {
    expect(collectGenres(FILMS)).toEqual(['Fantascienza', 'Thriller']);
  });
});
