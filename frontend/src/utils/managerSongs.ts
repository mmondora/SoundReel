/**
 * Song rows, filters and facet counts of the playlist manager ("Norton Commander").
 * Pure functions only: the page/hook feed them data and render the result.
 */
import type { AggregatedSong, Song } from '../types';
import type { Translations } from '../i18n/translations';
import { sortSongs } from './songFilters';
import type { ListenedFilter } from './songFilters';
import { isAtHome, resolveSongLocation } from './songLocation';
import { isCanonicalGenre } from './genres';
import {
  NO_YEAR,
  NO_YEAR_LABEL,
  albumOf,
  artistOf,
  decadeLabel,
  genreKey,
  matchesAll,
  normalizeSearch,
  tally,
  tokenize,
  traitsOf,
  yearOf,
} from './songFacets';
import type { DecadeValue } from './songFacets';

export type SongSourceKind = Song['source'];

/** "Tipo": how the song was found. */
export const SOURCE_KINDS: readonly SongSourceKind[] = [
  'audio_fingerprint',
  'ai_analysis',
  'both',
  'music_list',
  'spotify_link',
  'shazam_link',
];

export const SOURCE_LABEL_KEY: Record<SongSourceKind, keyof Translations> = {
  audio_fingerprint: 'mgrTypeAudio',
  ai_analysis: 'mgrTypeAi',
  both: 'mgrTypeBoth',
  music_list: 'mgrTypeList',
  spotify_link: 'mgrTypeSpotify',
  shazam_link: 'mgrTypeShazam',
};

const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  facebook: 'Facebook',
  twitter: 'X',
  threads: 'Threads',
  snapchat: 'Snapchat',
  pinterest: 'Pinterest',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  vimeo: 'Vimeo',
  twitch: 'Twitch',
  spotify: 'Spotify',
  shazam: 'Shazam',
  soundcloud: 'SoundCloud',
  other: 'Web',
};

/** "Fonte": the platform of the entry that mentioned the song. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? (platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : '—');
}

/** What the journal knows about an entry, joined to songs through `mentions[].entryId`. */
export interface EntryFact {
  platform: string;
  tags: string[];
}

export interface ManagerSong extends AggregatedSong {
  sources: SongSourceKind[];
  platforms: string[];
  tags: string[];
  /** A playlist key the user has no journal entry for (shared playlists can reference such songs). */
  placeholder?: boolean;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((v) => v.trim() !== ''))].sort((a, b) => a.localeCompare(b));
}

/**
 * Makes sure every song carries `sources` / `platforms` / `tags` arrays. The backend values win;
 * `platforms` and `tags` fall back to the entry facts (journal summaries) joined by mention.
 */
export function enrichSongs(
  songs: AggregatedSong[],
  facts?: ReadonlyMap<string, EntryFact> | null,
): ManagerSong[] {
  return songs.map((song) => {
    let platforms = song.platforms;
    let tags = song.tags;
    if ((platforms === undefined || tags === undefined) && facts) {
      const p = new Set<string>();
      const tg = new Set<string>();
      for (const mention of song.mentions) {
        const fact = facts.get(mention.entryId);
        if (!fact) continue;
        if (fact.platform) p.add(fact.platform);
        for (const tag of fact.tags) tg.add(tag);
      }
      platforms = platforms ?? uniqueSorted(p);
      tags = tags ?? uniqueSorted(tg);
    }
    return {
      ...song,
      sources: song.sources ? [...new Set(song.sources)] : [],
      platforms: platforms ?? [],
      tags: tags ?? [],
    };
  });
}

/** Which facets have any data at all (a facet nobody can fill is hidden instead of showing an empty list). */
export interface DatasetFacets {
  types: boolean;
  platforms: boolean;
  tags: boolean;
  genres: boolean;
}

export function datasetFacets(songs: readonly ManagerSong[]): DatasetFacets {
  return {
    types: songs.some((s) => s.sources.length > 0),
    platforms: songs.some((s) => s.platforms.length > 0),
    tags: songs.some((s) => s.tags.length > 0),
    genres: songs.some((s) => (s.meta?.genres ?? []).length > 0),
  };
}

/** Display stand-in for a playlist key without a journal entry: keys look like `artist::title`. */
export function placeholderSong(songKey: string): ManagerSong {
  const sep = songKey.indexOf('::');
  const artist = sep === -1 ? '' : songKey.slice(0, sep);
  const title = sep === -1 ? songKey : songKey.slice(sep + 2);
  return {
    songKey,
    title,
    artist,
    album: null,
    youtubeUrl: null,
    spotifyUrl: null,
    mentions: [],
    meta: null,
    sources: [],
    platforms: [],
    tags: [],
    placeholder: true,
  };
}

export type StateFilter = 'all' | 'downloaded' | 'notDownloaded' | 'preparing';
export type MembershipFilter = 'all' | 'in' | 'notIn';
/** Where the file is: geekom's disk (FS) or the media server (MS). */
export type PlaceKind = 'fs' | 'ms';

/**
 * Every way to choose songs, in one shape — the Playlist manager's filter drawer and the player's "Scegli cosa
 * suonare" panel both edit it. AND across the entries below, OR among the values picked inside one entry.
 *
 *   - tipo          → `genres`  (the genre; synonyms are one genre: "Alternativa" is "Alternative")
 *   - album, autore → `albums`, `artists` (exact names picked as chips) and `album`, `artist` (text, "contains")
 *   - anni          → `decades` (1980 is "Anni 80"; `NO_YEAR` is "Senza anno")
 *   - fonte, tag    → `platforms`, `tags`; `types` is how the song was recognised
 *   - playlist      → `membership` against the keys in `FilterContext.otherKeys`
 *   - scaricata     → `state`;  FS / MS → `locations`
 *   - free text     → `text` (artist, title, album; the order of the words does not matter)
 */
export interface ManagerFilters {
  text: string;
  artist: string;
  album: string;
  artists: string[];
  albums: string[];
  decades: DecadeValue[];
  types: SongSourceKind[];
  platforms: string[];
  genres: string[];
  tags: string[];
  locations: PlaceKind[];
  state: StateFilter;
  favorite: boolean;
  listened: ListenedFilter;
  /** Relative to the playlist shown in the OTHER pane (or the playlist the player picked). */
  membership: MembershipFilter;
}

export const EMPTY_FILTERS: ManagerFilters = {
  text: '',
  artist: '',
  album: '',
  artists: [],
  albums: [],
  decades: [],
  types: [],
  platforms: [],
  genres: [],
  tags: [],
  locations: [],
  state: 'all',
  favorite: false,
  listened: 'all',
  membership: 'all',
};

/** Live knowledge the filters need besides the song itself. */
export interface FilterContext {
  /** Songs whose MP3 became available during this session (first-play downloads). */
  readyKeys?: ReadonlySet<string>;
  /** Songs the server is preparing right now. */
  preparingKeys?: ReadonlySet<string>;
  /** Keys of the playlist shown in the other pane (null/undefined when that pane shows the library). */
  otherKeys?: ReadonlySet<string> | null;
}

/**
 * The green dot (rule S8 of the web-player spec): the file is on FS or on the media server. The backend sends that as
 * `inLibrary` (= fs || mediaServer) and the dot trusts it, NOTHING else: not the "downloaded" flag a user can set by
 * hand. A first-play download that finished in this session turns it green at once. Only when `inLibrary` is not
 * sent at all (another backend) are the `fs` / `mediaServer` flags read.
 */
export function isSongDownloaded(song: AggregatedSong, ctx: FilterContext = {}): boolean {
  if (ctx.readyKeys?.has(song.songKey) === true) return true;
  if (typeof song.inLibrary === 'boolean') return song.inLibrary;
  return isAtHome(resolveSongLocation(song));
}

export function isSongPreparing(song: AggregatedSong, ctx: FilterContext = {}): boolean {
  if (isSongDownloaded(song, ctx)) return false;
  return ctx.preparingKeys?.has(song.songKey) === true || song.fileState === 'preparing';
}

/** Where the file is: a download finished in this session is on the disk (FS) for sure. */
export function songPlaces(song: AggregatedSong, ctx: FilterContext = {}): Record<PlaceKind, boolean> {
  const loc = resolveSongLocation(song, ctx.readyKeys?.has(song.songKey) === true ? { fs: true } : undefined);
  return { fs: loc.fs, ms: loc.mediaServer };
}

/** Number of non-default filters (the text box is not counted, like on the Songs page). */
export function activeFilterCount(f: ManagerFilters): number {
  return (
    (f.artist.trim() ? 1 : 0) +
    (f.album.trim() ? 1 : 0) +
    f.artists.length +
    f.albums.length +
    f.decades.length +
    f.types.length +
    f.platforms.length +
    f.genres.length +
    f.tags.length +
    f.locations.length +
    (f.state !== 'all' ? 1 : 0) +
    (f.favorite ? 1 : 0) +
    (f.listened !== 'all' ? 1 : 0) +
    (f.membership !== 'all' ? 1 : 0)
  );
}

/**
 * The entries a facet counts "without its own filter". "artist" and "album" stand for the whole heading: the text
 * box and the exact names picked as chips.
 */
export type FacetKey = 'types' | 'platforms' | 'genres' | 'tags' | 'state' | 'artist' | 'album' | 'decades' | 'locations';

/**
 * Applies every filter. `skip` ignores one facet's own filter — used to count "what would I get if I
 * picked another value of this facet". Keeps the order of `songs`.
 */
export function filterManagerSongs(
  songs: readonly ManagerSong[],
  f: ManagerFilters,
  ctx: FilterContext = {},
  skip?: FacetKey,
): ManagerSong[] {
  const tokens = tokenize(f.text);
  const genres = skip === 'genres' ? [] : f.genres;
  const genreKeys = genres.length > 0 ? new Set(genres.map(genreKey)) : null;
  const artistText = skip === 'artist' ? '' : normalizeSearch(f.artist);
  const albumText = skip === 'album' ? '' : normalizeSearch(f.album);
  const artistKeys = skip === 'artist' || f.artists.length === 0 ? null : new Set(f.artists.map(normalizeSearch));
  const albumKeys = skip === 'album' || f.albums.length === 0 ? null : new Set(f.albums.map(normalizeSearch));
  const decades = skip === 'decades' || f.decades.length === 0 ? null : new Set<DecadeValue>(f.decades);
  const locations = skip === 'locations' ? [] : f.locations;
  const types = skip === 'types' ? [] : f.types;
  const platforms = skip === 'platforms' ? [] : f.platforms;
  const tags = skip === 'tags' ? [] : f.tags;
  const state: StateFilter = skip === 'state' ? 'all' : f.state;

  return songs.filter((song) => {
    const traits = traitsOf(song);
    if (tokens.length > 0 && !matchesAll(traits.text, tokens)) return false;
    if (artistText && !traits.artistKey.includes(artistText)) return false;
    if (albumText && !traits.albumKey.includes(albumText)) return false;
    if (artistKeys && !artistKeys.has(traits.artistKey)) return false;
    if (albumKeys && !albumKeys.has(traits.albumKey)) return false;
    if (decades && !decades.has(traits.decade ?? NO_YEAR)) return false;
    if (genreKeys && !traits.genres.some((g) => genreKeys.has(g.key))) return false;
    if (f.favorite && !(song.meta?.favorite ?? false)) return false;
    if (f.listened !== 'all') {
      const listened = song.meta?.listened ?? false;
      if (f.listened === 'listened' && !listened) return false;
      if (f.listened === 'unlistened' && listened) return false;
    }
    if (types.length > 0 && !types.some((k) => song.sources.includes(k))) return false;
    if (platforms.length > 0 && !platforms.some((p) => song.platforms.includes(p))) return false;
    if (tags.length > 0 && !tags.some((tg) => song.tags.includes(tg))) return false;
    if (locations.length > 0) {
      const places = songPlaces(song, ctx);
      if (!locations.some((k) => places[k])) return false;
    }
    if (state !== 'all') {
      const downloaded = isSongDownloaded(song, ctx);
      if (state === 'downloaded' && !downloaded) return false;
      if (state === 'notDownloaded' && downloaded) return false;
      if (state === 'preparing' && !isSongPreparing(song, ctx)) return false;
    }
    if (f.membership !== 'all' && ctx.otherKeys) {
      const inOther = ctx.otherKeys.has(song.songKey);
      if (f.membership === 'in' && !inOther) return false;
      if (f.membership === 'notIn' && inOther) return false;
    }
    return true;
  });
}

export interface DecadeCount {
  value: DecadeValue;
  /** "Anni 80", "Senza anno" (the Italian the backend says; the interface re-words it for English). */
  label: string;
  count: number;
}

export interface FacetCounts {
  types: Map<SongSourceKind, number>;
  platforms: Map<string, number>;
  /** Keyed by the way most songs spell the genre; the synonyms of one genre are ONE entry. */
  genres: Map<string, number>;
  tags: Map<string, number>;
  state: Record<Exclude<StateFilter, 'all'>, number>;
  /** Most frequent first. One spelling per author, however many songs spell it differently (case, accents). */
  artists: Array<[string, number]>;
  albums: Array<[string, number]>;
  /** Chronological, "Senza anno" last. */
  decades: DecadeCount[];
  locations: Record<PlaceKind, number>;
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decadeCounts(songs: readonly AggregatedSong[]): DecadeCount[] {
  const byDecade = new Map<number, number>();
  let withoutYear = 0;
  for (const song of songs) {
    const decade = traitsOf(song).decade;
    if (decade === null) withoutYear += 1;
    else bump(byDecade, decade);
  }
  const out: DecadeCount[] = [...byDecade.entries()]
    .sort((a, b) => a[0] - b[0]) // chronological: that is how decades are browsed
    .map(([decade, count]) => ({ value: decade, label: decadeLabel(decade), count }));
  if (withoutYear > 0) out.push({ value: NO_YEAR, label: NO_YEAR_LABEL, count: withoutYear });
  return out;
}

/** Counts per facet value, each computed with every OTHER filter applied. */
export function facetCounts(songs: readonly ManagerSong[], f: ManagerFilters, ctx: FilterContext = {}): FacetCounts {
  const types = new Map<SongSourceKind, number>();
  for (const s of filterManagerSongs(songs, f, ctx, 'types')) {
    for (const k of s.sources) bump(types, k);
  }
  const platforms = new Map<string, number>();
  for (const s of filterManagerSongs(songs, f, ctx, 'platforms')) {
    for (const p of s.platforms) bump(platforms, p);
  }
  const genres = new Map<string, number>(
    tally(filterManagerSongs(songs, f, ctx, 'genres'), (s) => traitsOf(s).genres.map((g) => ({ key: g.key, spelled: g.spelled })), isCanonicalGenre),
  );
  const tags = new Map<string, number>();
  for (const s of filterManagerSongs(songs, f, ctx, 'tags')) {
    for (const tg of s.tags) bump(tags, tg);
  }
  const state = { downloaded: 0, notDownloaded: 0, preparing: 0 };
  for (const s of filterManagerSongs(songs, f, ctx, 'state')) {
    if (isSongDownloaded(s, ctx)) state.downloaded += 1;
    else {
      state.notDownloaded += 1;
      if (isSongPreparing(s, ctx)) state.preparing += 1;
    }
  }
  const artists = tally(filterManagerSongs(songs, f, ctx, 'artist'), (s) => {
    const name = artistOf(s);
    return name ? [{ key: traitsOf(s).artistKey, spelled: name }] : [];
  });
  const albums = tally(filterManagerSongs(songs, f, ctx, 'album'), (s) => {
    const name = albumOf(s);
    return name ? [{ key: traitsOf(s).albumKey, spelled: name }] : [];
  });
  const decades = decadeCounts(filterManagerSongs(songs, f, ctx, 'decades'));
  const locations = { fs: 0, ms: 0 };
  for (const s of filterManagerSongs(songs, f, ctx, 'locations')) {
    const places = songPlaces(s, ctx);
    if (places.fs) locations.fs += 1;
    if (places.ms) locations.ms += 1;
  }
  return { types, platforms, genres, tags, state, artists, albums, decades, locations };
}

/** The facets the plain `datasetFacets` does not cover: which of them have any data at all. */
export interface ExtraDatasetFacets {
  decades: boolean;
  albums: boolean;
  artists: boolean;
  locations: boolean;
}

export function extraDatasetFacets(songs: readonly AggregatedSong[]): ExtraDatasetFacets {
  return {
    decades: songs.some((s) => yearOf(s) !== null),
    albums: songs.some((s) => albumOf(s) !== null),
    artists: songs.some((s) => artistOf(s) !== null),
    locations: songs.some((s) => {
      const loc = resolveSongLocation(s);
      return loc.fs || loc.mediaServer;
    }),
  };
}

export type LibrarySortMode = 'date' | 'artist' | 'title';

export function sortLibrary(songs: readonly ManagerSong[], mode: LibrarySortMode): ManagerSong[] {
  if (mode === 'title') {
    return [...songs].sort((a, b) => a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist));
  }
  return sortSongs([...songs], mode);
}

/** "1 brano" / "n brani": the i18n string has the plural form, `one` the singular. */
export function countLabel(n: number, plural: string, one: string): string {
  return n === 1 ? one : plural.replace('{n}', String(n));
}
