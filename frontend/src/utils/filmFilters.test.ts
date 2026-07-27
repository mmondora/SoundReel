import { describe, it, expect } from 'vitest';
import { filterFilms, collectGenres, sortFilms } from './filmFilters';
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

function filmWith(overrides: Partial<AggregatedFilm> & { filmKey: string }): AggregatedFilm {
  return {
    filmKey: overrides.filmKey,
    title: overrides.title ?? overrides.filmKey,
    director: overrides.director ?? null,
    year: null,
    imdbUrl: null,
    posterUrl: null,
    streamingUrls: null,
    mentions: [],
    meta: overrides.meta ?? null,
  };
}

const TEXT_FILMS = [
  filmWith({
    filmKey: 'matrix',
    title: 'The Matrix',
    director: 'Lana Wachowski',
    meta: {
      filmKey: 'matrix', tmdbId: null, overview: null, tmdbScore: null,
      watched: false, rating: null, score: null, availability: {},
      streamingOptions: null, streamingCheckedAt: null, watchmodeTitleId: null,
      cast: ['Keanu Reeves', 'Laurence Fishburne'],
      genres: ['Fantascienza', 'Azione'],
    },
  }),
  filmWith({
    filmKey: 'amelie',
    title: 'Amélie',
    director: 'Jean-Pierre Jeunet',
    meta: {
      filmKey: 'amelie', tmdbId: null, overview: null, tmdbScore: null,
      watched: false, rating: null, score: null, availability: {},
      streamingOptions: null, streamingCheckedAt: null, watchmodeTitleId: null,
      cast: ['Audrey Tautou'],
      genres: ['Commedia'],
    },
  }),
];

describe('filterFilms text search', () => {
  it('empty text matches everything', () => {
    expect(filterFilms(TEXT_FILMS, { genres: [], watched: 'all', availability: 'all', text: '' })).toHaveLength(2);
  });

  it('matches title case-insensitively', () => {
    const out = filterFilms(TEXT_FILMS, { genres: [], watched: 'all', availability: 'all', text: 'matrix' });
    expect(out.map((f) => f.filmKey)).toEqual(['matrix']);
  });

  it('matches director', () => {
    const out = filterFilms(TEXT_FILMS, { genres: [], watched: 'all', availability: 'all', text: 'Jeunet' });
    expect(out.map((f) => f.filmKey)).toEqual(['amelie']);
  });

  it('matches cast', () => {
    const out = filterFilms(TEXT_FILMS, { genres: [], watched: 'all', availability: 'all', text: 'tautou' });
    expect(out.map((f) => f.filmKey)).toEqual(['amelie']);
  });

  it('matches genres', () => {
    const out = filterFilms(TEXT_FILMS, { genres: [], watched: 'all', availability: 'all', text: 'commedia' });
    expect(out.map((f) => f.filmKey)).toEqual(['amelie']);
  });

  it('no match returns empty', () => {
    expect(filterFilms(TEXT_FILMS, { genres: [], watched: 'all', availability: 'all', text: 'nonexistent' })).toHaveLength(0);
  });

  it('combines with other filters (AND)', () => {
    const out = filterFilms(TEXT_FILMS, { genres: ['Commedia'], watched: 'all', availability: 'all', text: 'matrix' });
    expect(out).toHaveLength(0);
  });
});

describe('sortFilms', () => {
  const mk = (key: string, dates: string[], director: string | null): AggregatedFilm => ({
    filmKey: key, title: key, director, year: null, imdbUrl: null, posterUrl: null,
    streamingUrls: null, mentions: dates.map((d, i) => ({ entryId: `e${i}`, createdAt: d })), meta: null,
  });
  const older = mk('older', ['2026-01-01T00:00:00Z'], 'Zed Zulu');
  const newest = mk('newest', ['2026-07-01T00:00:00Z'], null);
  const popular = mk('popular', ['2026-03-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-15T00:00:00Z'], 'Anna Alpha');

  it('date: most recent mention first', () => {
    expect(sortFilms([older, popular, newest], 'date').map((f) => f.filmKey)).toEqual(['newest', 'popular', 'older']);
  });
  it('mentions: count desc, ties by date', () => {
    expect(sortFilms([older, newest, popular], 'mentions').map((f) => f.filmKey)).toEqual(['popular', 'newest', 'older']);
  });
  it('director: alphabetical, missing director last', () => {
    expect(sortFilms([older, newest, popular], 'director').map((f) => f.filmKey)).toEqual(['popular', 'older', 'newest']);
  });
  it('does not mutate the input array', () => {
    const input = [older, newest];
    sortFilms(input, 'date');
    expect(input.map((f) => f.filmKey)).toEqual(['older', 'newest']);
  });
});
