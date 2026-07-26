import { describe, it, expect } from 'vitest';
import { mergePatch } from './FilmsPage';
import type { FilmMetaRecord } from '../types';

function meta(partial: Partial<FilmMetaRecord>): FilmMetaRecord {
  return {
    filmKey: 'film:1',
    tmdbId: 42,
    genres: ['Drama'],
    overview: 'An overview',
    cast: ['Actor A'],
    tmdbScore: 7.5,
    watched: false,
    rating: null,
    score: null,
    availability: {},
    ...partial,
  };
}

describe('mergePatch', () => {
  it('creates a default meta record when meta is null', () => {
    const result = mergePatch(null, 'film:new', { watched: true });
    expect(result).toEqual({
      filmKey: 'film:new',
      tmdbId: null,
      genres: [],
      overview: null,
      cast: [],
      tmdbScore: null,
      watched: true,
      rating: null,
      score: null,
      availability: {},
    });
  });

  it('forces watched true when rating is set to a non-null value', () => {
    const result = mergePatch(meta({ watched: false, rating: null }), 'film:1', { rating: 'fresh' });
    expect(result.rating).toBe('fresh');
    expect(result.watched).toBe(true);
  });

  it('forces watched true when score is set to a non-null value', () => {
    const result = mergePatch(meta({ watched: false }), 'film:1', { score: 87 });
    expect(result.score).toBe(87);
    expect(result.watched).toBe(true);
  });

  it('deletes an availability key when patched with null and sets others normally', () => {
    const base = meta({ availability: { netflix: 'free', primeVideo: 'paid' } });
    const result = mergePatch(base, 'film:1', { availability: { netflix: null, raiPlay: 'absent' } });
    expect(result.availability).toEqual({ primeVideo: 'paid', raiPlay: 'absent' });
  });

  it('clears the rating without forcing watched back to false', () => {
    const base = meta({ watched: true, rating: 'fresh' });
    const result = mergePatch(base, 'film:1', { rating: null });
    expect(result.rating).toBeNull();
    expect(result.watched).toBe(true);
  });

  it('does not mutate the source meta object', () => {
    const base = meta({ availability: { netflix: 'free' }, rating: 'fresh' });
    mergePatch(base, 'film:1', { availability: { netflix: null }, rating: 'rotten' });
    expect(base.availability).toEqual({ netflix: 'free' });
    expect(base.rating).toBe('fresh');
  });
});

// Note: applyPatch's per-filmKey sequence guard (out-of-order PATCH response
// protection) is not covered here. Exercising it needs a full component
// render — MemoryRouter + LanguageProvider + mocked fetchFilms/patchFilmMeta
// with controllable (deferred) promise resolution to force a
// slow-first/fast-second response ordering — which is infra this suite
// doesn't otherwise use (no existing *.test.tsx / React Testing Library
// render in the codebase, only plain function-level tests). Given the size
// of that harness relative to the fix, it's skipped per the reviewer's
// stated fallback; mergePatch — the pure, easily-testable half of the
// optimistic-update logic — is fully covered above.
