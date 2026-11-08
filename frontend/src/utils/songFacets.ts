/**
 * The primitives of choosing what to play (spec 2026-11-08-player-selection-and-filters-design.md X4/X5): text
 * normalisation, decades, the one genre per song, and the per-song values every filter and facet reads. The rules
 * mirror the backend (`utils/searchText.ts`, `utils/releaseYear.ts`, `services/libraryFacets.ts`) so the web, the
 * Playlist manager and Mondrop's library endpoint all say the same thing about the same song.
 *
 * Pure functions only. `utils/managerSongs.ts` builds the filters and the facet counts on top of them, and it is the
 * ONE engine the Playlist manager, the Songs page and the player share.
 */
import type { AggregatedSong } from '../types';
import { canonicalGenre } from './genres';

/** The decade filter value for songs whose year no provider knows. */
export const NO_YEAR = 'none';
export const NO_YEAR_LABEL = 'Senza anno';
export type DecadeValue = number | typeof NO_YEAR;

// ---------------------------------------------------------------------------
// Text: no case, no accents, every run of non-letters/digits is one space, the ORDER of the words does not matter
// ---------------------------------------------------------------------------

export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(query: string): string[] {
  return normalizeSearch(query).split(' ').filter(Boolean);
}

/** Every word of the query appears somewhere in the (already normalised) text. */
export function matchesAll(normalizedText: string, tokens: readonly string[]): boolean {
  for (const t of tokens) if (!normalizedText.includes(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Decades
// ---------------------------------------------------------------------------

/** 1987 gives 1980; 1989 is the eighties, 1990 the nineties. */
export const decadeOf = (year: number): number => Math.floor(year / 10) * 10;

/** The way people say it in Italian: 1980 is "Anni 80", 2010 is "Anni 2010" (and 1910 stays "Anni 1910"). */
export function decadeLabel(decade: number): string {
  return decade >= 1920 && decade < 2000 ? `Anni ${decade % 100}` : `Anni ${decade}`;
}

/** "1980s" for the English interface; the Italian one says "Anni 80". */
export function decadeLabelFor(decade: number, language: 'it' | 'en'): string {
  return language === 'en' ? `${decade}s` : decadeLabel(decade);
}

// ---------------------------------------------------------------------------
// What a song says about itself
// ---------------------------------------------------------------------------

const tidy = (s: string | null | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ');

/** The provider's album name when there is one (so one album is spelt one way), else the mention's. */
export function albumOf(song: Pick<AggregatedSong, 'album' | 'meta'>): string | null {
  return tidy(song.meta?.album) || tidy(song.album) || null;
}

export const artistOf = (song: Pick<AggregatedSong, 'artist'>): string | null => tidy(song.artist) || null;

/** The release year when it is a plausible number; null otherwise ("Senza anno"). */
export function yearOf(song: Pick<AggregatedSong, 'meta'>): number | null {
  const y = song.meta?.releaseYear;
  return typeof y === 'number' && Number.isFinite(y) && y > 0 ? Math.trunc(y) : null;
}

export interface GenreRef {
  /** Groups the spellings of one genre ("alternativa" and "alternative" are the same key). */
  key: string;
  /** How the song spells it. */
  spelled: string;
}

/** The genres of a song, one per canonical genre (a song tagged "Alternative" and "Alternativa" has one). */
export function genresOf(song: Pick<AggregatedSong, 'meta'>): GenreRef[] {
  const out = new Map<string, GenreRef>();
  for (const raw of song.meta?.genres ?? []) {
    if (typeof raw !== 'string') continue;
    const spelled = tidy(raw);
    if (!spelled) continue;
    const key = normalizeSearch(canonicalGenre(spelled));
    if (key && !out.has(key)) out.set(key, { key, spelled });
  }
  return [...out.values()];
}

/** The key of a genre name as picked in a filter (any spelling of the group gives the same key). */
export const genreKey = (name: string): string => normalizeSearch(canonicalGenre(name));

/** What the filters and the facets read from a song, worked out once (a song object is never changed in place). */
export interface SongTraits {
  /** Artist, title and album, normalised: what the free text searches. */
  text: string;
  artistKey: string;
  albumKey: string;
  genres: GenreRef[];
  decade: number | null;
}

const traitsCache = new WeakMap<object, SongTraits>();

export function traitsOf(song: AggregatedSong): SongTraits {
  const cached = traitsCache.get(song);
  if (cached) return cached;
  const album = albumOf(song);
  const year = yearOf(song);
  const traits: SongTraits = {
    text: normalizeSearch(`${song.artist} ${song.title} ${album ?? ''}`),
    artistKey: normalizeSearch(artistOf(song) ?? ''),
    albumKey: normalizeSearch(album ?? ''),
    genres: genresOf(song),
    decade: year === null ? null : decadeOf(year),
  };
  traitsCache.set(song, traits);
  return traits;
}

// ---------------------------------------------------------------------------
// Facets: counting values, one spelling per value
// ---------------------------------------------------------------------------

export interface Spelled {
  key: string;
  spelled: string;
}

/**
 * Counts songs per value (one value is spelt as most of its songs spell it; on a tie the preferred spelling, then A
 * to Z). Most songs first, then A to Z.
 */
export function tally(
  songs: readonly AggregatedSong[],
  refsOf: (song: AggregatedSong) => Spelled[],
  preferred: (spelled: string) => boolean = () => false,
): Array<[string, number]> {
  const groups = new Map<string, { spellings: Map<string, number>; count: number }>();
  for (const song of songs) {
    const seen = new Set<string>();
    for (const { key, spelled } of refsOf(song)) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { spellings: new Map(), count: 0 }));
      g.count += 1;
      g.spellings.set(spelled, (g.spellings.get(spelled) ?? 0) + 1);
    }
  }
  const entries: Array<[string, number]> = [];
  for (const g of groups.values()) {
    const label = [...g.spellings.entries()].sort(
      (a, b) => b[1] - a[1] || Number(preferred(b[0])) - Number(preferred(a[0])) || a[0].localeCompare(b[0], 'it'),
    )[0][0];
    entries.push([label, g.count]);
  }
  return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'it'));
}
