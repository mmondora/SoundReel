import { describe, expect, it } from 'vitest';
import { decadeLabel, decadeOf, isPlausibleYear, maxReleaseYear, parseReleaseYear } from './releaseYear';

const NOW = new Date('2026-11-08T10:00:00Z');

describe('parseReleaseYear', () => {
  it('reads the year of a Deezer album date', () => {
    expect(parseReleaseYear('2001-03-13', NOW)).toBe(2001);
  });

  it('reads the year of an iTunes date-time', () => {
    expect(parseReleaseYear('2011-02-14T08:00:00Z', NOW)).toBe(2011);
    expect(parseReleaseYear('1984-10-01T07:00:00+02:00', NOW)).toBe(1984);
    expect(parseReleaseYear('1999-12-31 23:59:59', NOW)).toBe(1999);
  });

  it('accepts incomplete dates: a bare year, a year and a month', () => {
    expect(parseReleaseYear('1987', NOW)).toBe(1987);
    expect(parseReleaseYear('1987-6', NOW)).toBe(1987);
    expect(parseReleaseYear('1987-06', NOW)).toBe(1987);
    expect(parseReleaseYear(' 1987-06-05 ', NOW)).toBe(1987);
  });

  it('discards what a provider writes when it does not know the date', () => {
    expect(parseReleaseYear('0000-00-00', NOW)).toBeNull();
    expect(parseReleaseYear('', NOW)).toBeNull();
    expect(parseReleaseYear('   ', NOW)).toBeNull();
  });

  it('discards absurd values', () => {
    expect(parseReleaseYear('1066-01-01', NOW)).toBeNull();
    expect(parseReleaseYear('1899-12-31', NOW)).toBeNull();
    expect(parseReleaseYear('2099-01-01', NOW)).toBeNull();
    expect(parseReleaseYear('9999-12-31', NOW)).toBeNull();
  });

  it('keeps next year (announced releases) but not the one after', () => {
    expect(maxReleaseYear(NOW)).toBe(2027);
    expect(parseReleaseYear('2027-03-01', NOW)).toBe(2027);
    expect(parseReleaseYear('2028-03-01', NOW)).toBeNull();
  });

  it('is not fooled by things that merely start with digits', () => {
    expect(parseReleaseYear('19990', NOW)).toBeNull();
    expect(parseReleaseYear('2001abc', NOW)).toBeNull();
    expect(parseReleaseYear('12-03-2001', NOW)).toBeNull();
    expect(parseReleaseYear('March 2001', NOW)).toBeNull();
  });

  it('accepts a plausible number and nothing else of other types', () => {
    expect(parseReleaseYear(1994, NOW)).toBe(1994);
    expect(parseReleaseYear(94, NOW)).toBeNull();
    expect(parseReleaseYear(1994.5, NOW)).toBeNull();
    expect(parseReleaseYear(null, NOW)).toBeNull();
    expect(parseReleaseYear(undefined, NOW)).toBeNull();
    expect(parseReleaseYear({ year: 1994 }, NOW)).toBeNull();
  });
});

describe('isPlausibleYear', () => {
  it('has inclusive bounds', () => {
    expect(isPlausibleYear(1900, NOW)).toBe(true);
    expect(isPlausibleYear(1899, NOW)).toBe(false);
    expect(isPlausibleYear(2027, NOW)).toBe(true);
    expect(isPlausibleYear(2028, NOW)).toBe(false);
  });
});

describe('decadeOf / decadeLabel', () => {
  it('derives the decade from the year', () => {
    expect(decadeOf(1980)).toBe(1980);
    expect(decadeOf(1987)).toBe(1980);
    expect(decadeOf(1989)).toBe(1980);
    expect(decadeOf(1990)).toBe(1990);
    expect(decadeOf(2003)).toBe(2000);
  });

  it('says it the way Michele does: "Anni 80"', () => {
    expect(decadeLabel(1980)).toBe('Anni 80');
    expect(decadeLabel(1950)).toBe('Anni 50');
    expect(decadeLabel(1990)).toBe('Anni 90');
    expect(decadeLabel(2000)).toBe('Anni 2000');
    expect(decadeLabel(2010)).toBe('Anni 2010');
    expect(decadeLabel(2020)).toBe('Anni 2020');
    expect(decadeLabel(1910)).toBe('Anni 1910');
  });
});
