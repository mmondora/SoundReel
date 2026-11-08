/**
 * The release year of a song, as the music providers report it (ADR-0013): Deezer's album `release_date`
 * ("2001-03-13", and "0000-00-00" when it does not know) and iTunes' `releaseDate` ("2001-03-13T08:00:00Z").
 * Only a plausible year is kept; the decade is derived from it, never stored.
 */
export const MIN_RELEASE_YEAR = 1900;

/** The highest year accepted: next year, because releases are announced ahead of time. */
export function maxReleaseYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

export function isPlausibleYear(year: number, now: Date = new Date()): boolean {
  return Number.isInteger(year) && year >= MIN_RELEASE_YEAR && year <= maxReleaseYear(now);
}

const DATE_LIKE = /^\s*(\d{4})(?:-\d{1,2}(?:-\d{1,2})?)?(?:[T ].*)?\s*$/;

/** "2001", "2001-03", "2001-03-13" or an ISO date-time give 2001; anything else, or an implausible year, gives null. */
export function parseReleaseYear(value: unknown, now: Date = new Date()): number | null {
  if (typeof value === 'number') return isPlausibleYear(value, now) ? value : null;
  if (typeof value !== 'string') return null;
  const m = DATE_LIKE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  return isPlausibleYear(year, now) ? year : null;
}

/** 1987 gives 1980. */
export const decadeOf = (year: number): number => Math.floor(year / 10) * 10;

/** The way people say it in Italian: 1980 is "Anni 80", 2010 is "Anni 2010" (and 1910 stays "Anni 1910"). */
export function decadeLabel(decade: number): string {
  return decade >= 1920 && decade < 2000 ? `Anni ${decade % 100}` : `Anni ${decade}`;
}
