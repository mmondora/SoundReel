import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  activeFilterCount,
  enrichSongs,
  extraDatasetFacets,
  facetCounts,
  filterManagerSongs,
  songPlaces,
} from './managerSongs';
import type { ManagerFilters, ManagerSong } from './managerSongs';
import { filterSongs, collectGenres } from './songFilters';
import { NO_YEAR } from './songFacets';
import type { AggregatedSong, SongMetaRecord } from '../types';

// The ONE engine the Playlist manager, the Songs page and the player share: the same rules as the backend's
// `services/libraryFacets.ts` (AND across filters, a facet counts what matches every filter but its own, accents and
// case ignored, the order of the words does not matter). The songs below are the backend's own test songs.

interface Opts {
  album?: string | null;
  mentionAlbum?: string | null;
  genres?: string[];
  year?: number | null;
  noMeta?: boolean;
  inLibrary?: boolean;
  mediaServer?: boolean;
  platforms?: string[];
  tags?: string[];
  favorite?: boolean;
}

function mk(artist: string, title: string, o: Opts = {}): AggregatedSong {
  const key = `${artist.toLowerCase()}::${title.toLowerCase()}`;
  const meta: SongMetaRecord | null = o.noMeta
    ? null
    : {
        songKey: key, deezerId: null, itunesId: null, genres: o.genres ?? [], album: o.album ?? null,
        releaseYear: o.year ?? null, coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null, enrichedAt: null,
        listened: false, favorite: o.favorite ?? false, downloaded: false, rating: null, score: null,
      };
  return {
    songKey: key, title, artist, album: o.mentionAlbum ?? null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: 'e', createdAt: '2026-01-01' }], meta, inLibrary: o.inLibrary ?? false,
    ...(o.mediaServer !== undefined ? { mediaServer: o.mediaServer, fs: o.inLibrary ?? false } : {}),
    ...(o.platforms ? { platforms: o.platforms } : {}),
    ...(o.tags ? { tags: o.tags } : {}),
  };
}

const BILLIE = mk('Michael Jackson', 'Billie Jean', { album: 'Thriller', genres: ['Pop'], year: 1982 });
const BEAT_IT = mk('Michael Jackson', 'Beat It', { album: 'Thriller', genres: ['Pop', 'Rock'], year: 1982 });
const PRAYER = mk('Madonna', 'Like a Prayer', { album: 'Like a Prayer', genres: ['Pop'], year: 1989 });
const ONE_MORE = mk('Daft Punk', 'One More Time', { album: 'Discovery', genres: ['Electronic'], year: 2001 });
const AROUND = mk('Daft Punk', 'Around the World', { album: 'Homework', genres: ['Elettronica'], year: 1997 });
const BASSI = mk('Bassi Maestro', 'Il Mio Ragazzo', { album: 'Fastidio', genres: ['Rap/Hip Hop'], year: 2000 });
const CREEP = mk('Radiohead', 'Creep', { album: 'Pablo Honey', genres: ['Alternativa'], year: 1992 });
const EVERLONG = mk('Foo Fighters', 'Everlong', { album: 'The Colour and the Shape', genres: ['Alternative'], year: 1997 });
const MYSTERY = mk('Unknown Artist', 'Mystery', { noMeta: true, mentionAlbum: 'Mystery LP' });
const NO_ARTIST = mk('', 'Untitled', { genres: ['Pop'], year: 1983 });
const SONGS: ManagerSong[] = enrichSongs([BILLIE, BEAT_IT, PRAYER, ONE_MORE, AROUND, BASSI, CREEP, EVERLONG, MYSTERY, NO_ARTIST]);

const titles = (songs: ManagerSong[]): string[] => songs.map((s) => s.title);
const run = (f: Partial<ManagerFilters>, ctx = {}) => titles(filterManagerSongs(SONGS, { ...EMPTY_FILTERS, ...f }, ctx));

describe('filters', () => {
  it('no filter gives every song, in the order it was given', () => {
    expect(run({})).toEqual(titles(SONGS));
  });

  it('tipo: synonyms are one genre, whichever way it is picked', () => {
    expect(run({ genres: ['Elettronica'] })).toEqual(['One More Time', 'Around the World']);
    expect(run({ genres: ['Electronic'] })).toEqual(['One More Time', 'Around the World']);
    expect(run({ genres: ['electro'] })).toEqual(['One More Time', 'Around the World']);
    expect(run({ genres: ['Alternativa'] })).toEqual(['Creep', 'Everlong']);
    expect(run({ genres: ['Rock'] })).toEqual(['Beat It']);
  });

  it('tipo: several genres are an OR', () => {
    expect(run({ genres: ['Rock', 'Alternative'] })).toEqual(['Beat It', 'Creep', 'Everlong']);
  });

  it('anni: "Anni 80" is 1980 to 1989 and "Anni 90" starts at 1990 (the boundary)', () => {
    expect(run({ decades: [1980] })).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer', 'Untitled']); // 1982, 1982, 1989, 1983
    expect(run({ decades: [1990] })).toEqual(['Around the World', 'Creep', 'Everlong']);
    expect(run({ decades: [2000] })).toEqual(['One More Time', 'Il Mio Ragazzo']);
    expect(run({ decades: [1970] })).toEqual([]);
  });

  it('anni: 1989 and 1990 fall on opposite sides', () => {
    const edge = enrichSongs([mk('A', 'last of the eighties', { year: 1989 }), mk('B', 'first of the nineties', { year: 1990 })]);
    expect(titles(filterManagerSongs(edge, { ...EMPTY_FILTERS, decades: [1980] }))).toEqual(['last of the eighties']);
    expect(titles(filterManagerSongs(edge, { ...EMPTY_FILTERS, decades: [1990] }))).toEqual(['first of the nineties']);
  });

  it('anni: several decades are an OR, and "Senza anno" finds the songs no provider dated', () => {
    expect(run({ decades: [1980, 2000] })).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer', 'One More Time', 'Il Mio Ragazzo', 'Untitled']);
    expect(run({ decades: [NO_YEAR] })).toEqual(['Mystery']);
    expect(run({ decades: [2000, NO_YEAR] })).toEqual(['One More Time', 'Il Mio Ragazzo', 'Mystery']);
  });

  it('album and autore picked as names are exact (case, accents and punctuation aside)', () => {
    expect(run({ albums: ['thriller'] })).toEqual(['Billie Jean', 'Beat It']);
    expect(run({ albums: ['THE COLOUR AND THE SHAPE'] })).toEqual(['Everlong']);
    expect(run({ albums: ['mystery lp'] })).toEqual(['Mystery']); // the mention’s album when the provider has none
    expect(run({ artists: ['daft punk'] })).toEqual(['One More Time', 'Around the World']);
    expect(run({ artists: ['daft'] })).toEqual([]); // a picked name is the whole name…
    expect(run({ artist: 'daft' })).toEqual(['One More Time', 'Around the World']); // …the text box is "contains"
    expect(run({ albums: ['Thriller', 'Discovery'] })).toEqual(['Billie Jean', 'Beat It', 'One More Time']);
  });

  it('an album picked as a name is not any album that merely contains it ("Discovery" is not "Discovery Live")', () => {
    const songs = enrichSongs([mk('A', 'studio', { album: 'Discovery' }), mk('A', 'concert', { album: 'Discovery Live' })]);
    expect(titles(filterManagerSongs(songs, { ...EMPTY_FILTERS, albums: ['Discovery'] }))).toEqual(['studio']);
    expect(titles(filterManagerSongs(songs, { ...EMPTY_FILTERS, album: 'Discovery' }))).toEqual(['studio', 'concert']); // the text box is "contains"
  });

  it('free text: the order of the words does not matter, nor case or accents', () => {
    expect(run({ text: 'Maestro Bassi' })).toEqual(['Il Mio Ragazzo']);
    expect(run({ text: 'jean billie' })).toEqual(['Billie Jean']);
    expect(run({ text: 'pablo honey' })).toEqual(['Creep']); // through the album
    expect(run({ text: 'RADIOHEAD' })).toEqual(['Creep']);
    expect(run({ text: 'daft punk time' })).toEqual(['One More Time']);
    expect(run({ text: '   ' })).toEqual(titles(SONGS));
  });

  it('free text ignores accents on both sides', () => {
    const songs = enrichSongs([mk('Beyoncé', 'Déjà Vu'), mk('Other', 'Song')]);
    expect(titles(filterManagerSongs(songs, { ...EMPTY_FILTERS, text: 'beyonce deja' }))).toEqual(['Déjà Vu']);
    expect(titles(filterManagerSongs(songs, { ...EMPTY_FILTERS, text: 'BEYONCÉ' }))).toEqual(['Déjà Vu']);
  });

  it('combines filters with AND', () => {
    expect(run({ genres: ['Pop'], decades: [1980] })).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer', 'Untitled']);
    expect(run({ genres: ['Pop'], decades: [1980], artists: ['madonna'] })).toEqual(['Like a Prayer']);
    expect(run({ genres: ['Pop'], decades: [2000] })).toEqual([]);
    expect(run({ text: 'michael', decades: [1980], albums: ['Thriller'], genres: ['Rock'] })).toEqual(['Beat It']);
  });

  it('playlist: the keys of the chosen playlist restrict everything else', () => {
    const playlist = new Set([BILLIE.songKey, ONE_MORE.songKey, PRAYER.songKey]);
    expect(run({ membership: 'in' }, { otherKeys: playlist })).toEqual(['Billie Jean', 'Like a Prayer', 'One More Time']);
    expect(run({ membership: 'in', decades: [1980] }, { otherKeys: playlist })).toEqual(['Billie Jean', 'Like a Prayer']);
    expect(run({ membership: 'notIn' }, { otherKeys: playlist })).toHaveLength(7);
    expect(run({ membership: 'in' }, { otherKeys: null })).toHaveLength(10); // no playlist chosen: no restriction
  });

  it('FS / MS: where the file is', () => {
    const songs = enrichSongs([
      mk('A', 'on disk', { inLibrary: true, mediaServer: false }),
      mk('B', 'on the media server', { inLibrary: true, mediaServer: true }),
      { ...mk('C', 'media only'), fs: false, mediaServer: true, inLibrary: true },
      mk('D', 'streaming only'),
    ]);
    const where = (locations: ManagerFilters['locations'], ctx = {}) => titles(filterManagerSongs(songs, { ...EMPTY_FILTERS, locations }, ctx));
    expect(where(['fs'])).toEqual(['on disk', 'on the media server']);
    expect(where(['ms'])).toEqual(['on the media server', 'media only']);
    expect(where(['fs', 'ms'])).toEqual(['on disk', 'on the media server', 'media only']);
    // a download finished in this session is on the disk
    expect(where(['fs'], { readyKeys: new Set([songs[3].songKey]) })).toContain('streaming only');
    expect(songPlaces(songs[2])).toEqual({ fs: false, ms: true });
  });

  it('fonte, tag and scaricata work through the same entry point', () => {
    const songs = enrichSongs([
      mk('A', 'one', { platforms: ['instagram'], tags: ['#estate'], inLibrary: true }),
      mk('B', 'two', { platforms: ['tiktok'], tags: ['#estate', '#chill'] }),
      mk('C', 'three', { platforms: ['instagram'], tags: [] }),
    ]);
    const pick = (f: Partial<ManagerFilters>) => titles(filterManagerSongs(songs, { ...EMPTY_FILTERS, ...f }));
    expect(pick({ platforms: ['instagram'] })).toEqual(['one', 'three']);
    expect(pick({ tags: ['#estate'] })).toEqual(['one', 'two']);
    expect(pick({ platforms: ['instagram'], tags: ['#estate'] })).toEqual(['one']);
    expect(pick({ state: 'downloaded' })).toEqual(['one']);
    expect(pick({ state: 'notDownloaded', platforms: ['instagram'] })).toEqual(['three']);
  });

  it('a blank filter is no filter', () => {
    expect(run({ text: '  ', artist: ' ', album: '', genres: [], decades: [] })).toEqual(titles(SONGS));
  });

  it('counts the picks of every kind as active filters (the text box apart)', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, decades: [1980, NO_YEAR], albums: ['x'], artists: ['y'], locations: ['fs'], text: 'z' })).toBe(5);
  });
});

describe('facet counts: each heading counts what matches every filter EXCEPT its own', () => {
  it('genres: synonyms are one entry, most songs first, spelt as most songs spell it', () => {
    const { genres } = facetCounts(SONGS, EMPTY_FILTERS);
    const list = [...genres.entries()];
    expect(list[0]).toEqual(['Pop', 4]); // Billie Jean, Beat It, Like a Prayer, Untitled
    // "Electronic" and "Elettronica" tie on spelling: the canonical name wins
    expect(genres.get('Elettronica')).toBe(2);
    expect(genres.get('Alternative')).toBe(2);
    expect(genres.get('Rock')).toBe(1);
    expect(genres.has('Electronic')).toBe(false);
    expect(genres.has('Alternativa')).toBe(false);
  });

  it('a majority spelling that is not the canonical name is kept (one chip, the way the data says it)', () => {
    const songs = enrichSongs([
      mk('A', '1', { genres: ['Electronic'] }), mk('B', '2', { genres: ['Electronic'] }), mk('C', '3', { genres: ['Electronic'] }), mk('D', '4', { genres: ['Elettronica'] }),
    ]);
    expect([...facetCounts(songs, EMPTY_FILTERS).genres.entries()]).toEqual([['Electronic', 4]]);
  });

  it('anni: chronological, "Senza anno" last', () => {
    expect(facetCounts(SONGS, EMPTY_FILTERS).decades).toEqual([
      { value: 1980, label: 'Anni 80', count: 4 },
      { value: 1990, label: 'Anni 90', count: 3 },
      { value: 2000, label: 'Anni 2000', count: 2 },
      { value: NO_YEAR, label: 'Senza anno', count: 1 },
    ]);
  });

  it('anni: no "Senza anno" entry when every song has a year', () => {
    expect(facetCounts(enrichSongs([BILLIE, PRAYER]), EMPTY_FILTERS).decades.map((d) => d.value)).toEqual([1980]);
  });

  it('albums and autori: counted once per name, blanks left out, one spelling per name', () => {
    const { albums, artists } = facetCounts(SONGS, EMPTY_FILTERS);
    expect(albums[0]).toEqual(['Thriller', 2]);
    expect(albums.map((a) => a[0])).toContain('Mystery LP');
    expect(albums.map((a) => a[0])).not.toContain('');
    expect(artists.slice(0, 2)).toEqual([['Daft Punk', 2], ['Michael Jackson', 2]]); // ties A to Z
    expect(artists.map((a) => a[0])).not.toContain('');
    const mixed = enrichSongs([mk('Daft Punk', 'a', { album: 'Discovery' }), mk('daft punk', 'b', { album: 'discovery' }), mk('Daft Punk', 'c', { album: 'Discovery' })]);
    expect(facetCounts(mixed, EMPTY_FILTERS).albums).toEqual([['Discovery', 3]]);
    expect(facetCounts(mixed, EMPTY_FILTERS).artists).toEqual([['Daft Punk', 3]]);
  });

  it('picking a genre narrows albums, autori and anni, but still shows the other genres to switch to', () => {
    const f = { ...EMPTY_FILTERS, genres: ['Elettronica'] };
    const facets = facetCounts(SONGS, f);
    expect(facets.albums.map((a) => a[0]).sort()).toEqual(['Discovery', 'Homework']);
    expect(facets.artists.map((a) => a[0])).toEqual(['Daft Punk']);
    expect(facets.decades.map((d) => d.value)).toEqual([1990, 2000]);
    expect(facets.genres.get('Pop')).toBe(4); // its own filter is left out of its own count
  });

  it('picking a decade narrows the genres but not the decades', () => {
    const facets = facetCounts(SONGS, { ...EMPTY_FILTERS, decades: [1980] });
    expect([...facets.genres.keys()].sort()).toEqual(['Pop', 'Rock']);
    expect(facets.decades.map((d) => d.value)).toEqual([1980, 1990, 2000, NO_YEAR]);
  });

  it('picking an album narrows everything but the albums', () => {
    const facets = facetCounts(SONGS, { ...EMPTY_FILTERS, albums: ['Thriller'] });
    expect(facets.albums.length).toBeGreaterThan(5); // the other albums are still on offer
    expect(facets.artists).toEqual([['Michael Jackson', 2]]);
    expect(facets.decades).toEqual([{ value: 1980, label: 'Anni 80', count: 2 }]);
  });

  it('the text box narrows every heading', () => {
    const facets = facetCounts(SONGS, { ...EMPTY_FILTERS, text: 'daft' });
    expect(facets.artists).toEqual([['Daft Punk', 2]]);
    expect(facets.decades.map((d) => d.value)).toEqual([1990, 2000]);
  });

  it('a playlist is a scope for all of them', () => {
    const ctx = { otherKeys: new Set([BILLIE.songKey, PRAYER.songKey, ONE_MORE.songKey]) };
    const facets = facetCounts(SONGS, { ...EMPTY_FILTERS, membership: 'in' }, ctx);
    expect(facets.decades.map((d) => [d.value, d.count])).toEqual([[1980, 2], [2000, 1]]);
    expect(facets.artists.map((a) => a[0]).sort()).toEqual(['Daft Punk', 'Madonna', 'Michael Jackson']);
  });

  it('FS / MS: songs per place (a song on both counts in both)', () => {
    const songs = enrichSongs([
      mk('A', 'disk', { inLibrary: true, mediaServer: false }),
      mk('B', 'both', { inLibrary: true, mediaServer: true }),
      { ...mk('C', 'media'), fs: false, mediaServer: true, inLibrary: true },
      mk('D', 'none'),
    ]);
    expect(facetCounts(songs, EMPTY_FILTERS).locations).toEqual({ fs: 2, ms: 2 });
    expect(facetCounts(songs, { ...EMPTY_FILTERS, locations: ['fs'] }).locations).toEqual({ fs: 2, ms: 2 }); // its own filter is left out
    expect(facetCounts(songs, { ...EMPTY_FILTERS, text: 'both' }).locations).toEqual({ fs: 1, ms: 1 });
  });

  it('of nothing, gives nothing', () => {
    const facets = facetCounts([], EMPTY_FILTERS);
    expect(facets.genres.size).toBe(0);
    expect(facets.albums).toEqual([]);
    expect(facets.artists).toEqual([]);
    expect(facets.decades).toEqual([]);
    expect(facets.locations).toEqual({ fs: 0, ms: 0 });
  });

  it('knows which of the new headings have any data at all', () => {
    expect(extraDatasetFacets(SONGS)).toEqual({ decades: true, albums: true, artists: true, locations: false });
    expect(extraDatasetFacets(enrichSongs([mk('A', 'b', { noMeta: true })]))).toEqual({ decades: false, albums: false, artists: true, locations: false });
    expect(extraDatasetFacets(enrichSongs([mk('A', 'b', { inLibrary: true })])).locations).toBe(true);
  });
});

describe('the Songs page and the player shelves use the same rules', () => {
  const opts = { genres: [] as string[], listened: 'all' as const, favorite: false, downloaded: 'all' as const };

  it('free text: any word order, accents ignored', () => {
    expect(filterSongs([BASSI, BILLIE], { ...opts, text: 'maestro bassi' }).map((s) => s.title)).toEqual(['Il Mio Ragazzo']);
    expect(filterSongs([mk('Beyoncé', 'Halo')], { ...opts, text: 'beyonce' })).toHaveLength(1);
  });

  it('genres: the synonyms are one genre', () => {
    expect(filterSongs([ONE_MORE, AROUND, BILLIE], { ...opts, genres: ['Elettronica'] }).map((s) => s.title)).toEqual(['One More Time', 'Around the World']);
  });

  it('the genre chips list one entry per genre, A to Z', () => {
    expect(collectGenres([ONE_MORE, AROUND, CREEP, EVERLONG, BILLIE, BEAT_IT])).toEqual(['Alternative', 'Elettronica', 'Pop', 'Rock']);
  });
});
