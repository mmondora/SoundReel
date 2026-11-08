/**
 * Choosing what to play: filter the songs a user can see by genre ("tipo"), album, artist, decade ("anni 80") and
 * free text, and count what is left under each heading so a client can offer the choices (ADR-0013, spec
 * 2026-11-08-player-selection-and-filters-design.md X2/X4). Pure functions over `AggregatedSong`: no I/O, so the
 * rules are tested without a database, and Mondrop's `GET /api/mondrop/library` is a thin route around them.
 *
 * Facet counts follow the usual rule for browsing: each heading counts the songs that match every filter EXCEPT
 * its own, so picking a genre narrows the albums on offer but still shows the other genres to switch to.
 */
import type { AggregatedSong } from '../types';
import { canonicalGenre, canonicalGenres } from '../utils/genres';
import { decadeLabel, decadeOf } from '../utils/releaseYear';
import { matchesAll, normalizeSearch, tokenize } from '../utils/searchText';

/** The decade filter value for songs whose year no provider knows. */
export const NO_YEAR = 'none';
export const NO_YEAR_LABEL = 'Senza anno';

/** A facet is never longer than this: a safety net, a personal library is a few hundred albums. */
const FACET_LIMIT = 2000;

export interface LibraryFilters {
  /** Free text over artist, title and album; the order of the words does not matter. */
  q?: string;
  /** A genre name; synonyms count ("Alternativa" is "Alternative"). */
  genre?: string;
  album?: string;
  artist?: string;
  /** 1980 for the eighties, or `NO_YEAR`. */
  decade?: number | typeof NO_YEAR;
}

export interface FacetEntry<V extends string | number = string> {
  /** What to send back as the filter. */
  value: V;
  /** What to show. */
  label: string;
  count: number;
}

export interface LibraryFacets {
  genres: FacetEntry[];
  albums: FacetEntry[];
  artists: FacetEntry[];
  decades: Array<FacetEntry<number | typeof NO_YEAR>>;
}

// ---------------------------------------------------------------------------
// What a song says about itself (the same words the tracks sent to Mondrop carry)
// ---------------------------------------------------------------------------

const tidy = (s: string | null | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ');

/** The provider's album name when there is one (so one album is spelt one way), else the mention's. */
export function albumOf(song: AggregatedSong): string | null {
  return tidy(song.meta?.album) || tidy(song.album) || null;
}

export const artistOf = (song: AggregatedSong): string | null => tidy(song.artist) || null;

/** Canonical genre names, sorted (utils/genres.ts). */
export const genresOf = (song: AggregatedSong): string[] => canonicalGenres(song.meta?.genres);

export const yearOf = (song: AggregatedSong): number | null => song.meta?.releaseYear ?? null;

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  normalizeSearch(a ?? '') === normalizeSearch(b ?? '');

type Predicate = (song: AggregatedSong) => boolean;

function predicates(f: LibraryFilters): Record<keyof LibraryFilters, Predicate | null> {
  const tokens = f.q ? tokenize(f.q) : [];
  const genre = f.genre ? canonicalGenre(f.genre) : '';
  return {
    q: tokens.length > 0 ? (s) => matchesAll(normalizeSearch(`${s.artist} ${s.title} ${albumOf(s) ?? ''}`), tokens) : null,
    genre: genre ? (s) => genresOf(s).some((g) => same(g, genre)) : null,
    album: f.album ? (s) => same(albumOf(s), f.album) : null,
    artist: f.artist ? (s) => same(artistOf(s), f.artist) : null,
    decade:
      f.decade === undefined
        ? null
        : f.decade === NO_YEAR
          ? (s) => yearOf(s) === null
          : (s) => {
              const y = yearOf(s);
              return y !== null && decadeOf(y) === f.decade;
            },
  };
}

/** The songs matching every filter, or every filter except `skip` (what a facet counts over). Keeps the input order. */
export function filterSongs<T extends AggregatedSong>(songs: readonly T[], f: LibraryFilters, skip?: keyof LibraryFilters): T[] {
  const active = (Object.entries(predicates(f)) as Array<[keyof LibraryFilters, Predicate | null]>)
    .filter(([name, p]) => p !== null && name !== skip)
    .map(([, p]) => p as Predicate);
  if (active.length === 0) return [...songs];
  return songs.filter((s) => active.every((p) => p(s)));
}

/** Artist, then title: how a person looks for a song in a list. */
export function sortByArtistTitle<T extends AggregatedSong>(songs: readonly T[]): T[] {
  return [...songs].sort((a, b) => a.artist.localeCompare(b.artist, 'it') || a.title.localeCompare(b.title, 'it'));
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/** Counts songs per value; one value is spelt as most of its songs spell it. Most songs first, then A to Z. */
function tally(songs: readonly AggregatedSong[], valuesOf: (s: AggregatedSong) => string[]): FacetEntry[] {
  const groups = new Map<string, { spellings: Map<string, number>; count: number }>();
  for (const song of songs) {
    for (const raw of new Set(valuesOf(song))) {
      const key = normalizeSearch(raw);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { spellings: new Map(), count: 0 }));
      g.count += 1;
      g.spellings.set(raw, (g.spellings.get(raw) ?? 0) + 1);
    }
  }
  const entries: FacetEntry[] = [];
  for (const g of groups.values()) {
    const label = [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'it'))[0][0];
    entries.push({ value: label, label, count: g.count });
  }
  return entries.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'it')).slice(0, FACET_LIMIT);
}

function decadeFacet(songs: readonly AggregatedSong[]): LibraryFacets['decades'] {
  const byDecade = new Map<number, number>();
  let withoutYear = 0;
  for (const song of songs) {
    const y = yearOf(song);
    if (y === null) withoutYear += 1;
    else byDecade.set(decadeOf(y), (byDecade.get(decadeOf(y)) ?? 0) + 1);
  }
  const out: LibraryFacets['decades'] = [...byDecade.entries()]
    .sort((a, b) => a[0] - b[0]) // chronological: that is how decades are browsed
    .map(([decade, count]) => ({ value: decade, label: decadeLabel(decade), count }));
  if (withoutYear > 0) out.push({ value: NO_YEAR, label: NO_YEAR_LABEL, count: withoutYear });
  return out;
}

export function computeFacets(songs: readonly AggregatedSong[], f: LibraryFilters): LibraryFacets {
  return {
    genres: tally(filterSongs(songs, f, 'genre'), genresOf),
    albums: tally(filterSongs(songs, f, 'album'), (s) => [albumOf(s) ?? '']),
    artists: tally(filterSongs(songs, f, 'artist'), (s) => [artistOf(s) ?? '']),
    decades: decadeFacet(filterSongs(songs, f, 'decade')),
  };
}

// ---------------------------------------------------------------------------
// The query string of GET /api/mondrop/library
// ---------------------------------------------------------------------------

export const DEFAULT_LIBRARY_LIMIT = 100;
export const MAX_LIBRARY_LIMIT = 500;
const MAX_TEXT = 200;

export type LibraryQueryResult =
  | { ok: true; filters: LibraryFilters; limit: number; offset: number; facets: boolean }
  | { ok: false; field: string };

type RawQuery = Record<string, unknown>;

function text(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length > MAX_TEXT) return null; // null = invalid
  const t = raw.trim();
  return t === '' ? undefined : t;
}

function whole(raw: unknown, min: number, max: number): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n < min || n > max ? null : n;
}

/** Validates the query string. Anything unexpected is a 400 naming the field, never a silent default. */
export function parseLibraryQuery(query: RawQuery): LibraryQueryResult {
  const filters: LibraryFilters = {};
  for (const key of ['q', 'genre', 'album', 'artist'] as const) {
    const v = text(query[key]);
    if (v === null) return { ok: false, field: key };
    if (v !== undefined) filters[key] = v;
  }

  const rawDecade = query.decade;
  if (rawDecade !== undefined && rawDecade !== '') {
    if (rawDecade === NO_YEAR) filters.decade = NO_YEAR;
    else {
      const d = whole(rawDecade, 1900, 2090);
      if (d === null || d === undefined || d % 10 !== 0) return { ok: false, field: 'decade' };
      filters.decade = d;
    }
  }

  const limit = whole(query.limit, 1, MAX_LIBRARY_LIMIT);
  if (limit === null) return { ok: false, field: 'limit' };
  const offset = whole(query.offset, 0, 1_000_000);
  if (offset === null) return { ok: false, field: 'offset' };
  const withFacets = query.facets === undefined ? true : query.facets !== '0';

  return { ok: true, filters, limit: limit ?? DEFAULT_LIBRARY_LIMIT, offset: offset ?? 0, facets: withFacets };
}
