import { describe, it, expect } from 'vitest';
import { resolveFilmYear } from './analyze';
import { filmKey } from '../services/filmMeta';

describe('resolveFilmYear', () => {
  it('falls back to the TMDb release year when the extractor found no year', () => {
    expect(resolveFilmYear(null, '1995-12-15')).toBe('1995');
  });

  it('prefers the extractor year over the TMDb release year when both are present', () => {
    expect(resolveFilmYear('1994', '1995-12-15')).toBe('1994');
  });

  it('is null when neither source has a year', () => {
    expect(resolveFilmYear(null, null)).toBeNull();
    expect(resolveFilmYear(undefined, undefined)).toBeNull();
  });

  it('regression: produces the same filmKey the persisted Film.year would use, so the film_meta upsert and the GET /api/films join land on the same key', () => {
    // Bug: upsertFilmEnrichment was keyed with the PRE-fallback extractor year
    // (null here) while the persisted Film.year used the POST-fallback TMDb
    // year ('1995'), so the enrichment row was written under 'heat::' while
    // GET /api/films looked it up under 'heat::1995' — the join silently
    // never matched. Both call sites now compute the year once via
    // resolveFilmYear and reuse it for both the persisted Film and the
    // upsertFilmEnrichment filmKey.
    const finalYear = resolveFilmYear(null, '1995-12-15');
    expect(filmKey('Heat', finalYear)).toBe('heat::1995');
  });
});
