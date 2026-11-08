import { describe, expect, it } from 'vitest';
import {
  albumOf,
  computeFacets,
  filterSongs,
  genresOf,
  NO_YEAR,
  parseLibraryQuery,
  sortByArtistTitle,
  yearOf,
} from './libraryFacets';
import type { AggregatedSong, SongMetaRecord } from '../types';

interface Opts {
  album?: string | null;
  mentionAlbum?: string | null;
  genres?: string[];
  year?: number | null;
  noMeta?: boolean;
}

function mk(artist: string, title: string, o: Opts = {}): AggregatedSong {
  const meta: SongMetaRecord | null = o.noMeta
    ? null
    : {
        songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`, deezerId: null, itunesId: null, genres: o.genres ?? [], album: o.album ?? null,
        releaseYear: o.year ?? null, coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null, enrichedAt: null,
        listened: false, favorite: false, downloaded: false, rating: null, score: null,
      };
  return {
    songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`, title, artist, album: o.mentionAlbum ?? null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: 'e', createdAt: '2026-01-01' }], meta, inLibrary: false,
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
const SONGS = [BILLIE, BEAT_IT, PRAYER, ONE_MORE, AROUND, BASSI, CREEP, EVERLONG, MYSTERY, NO_ARTIST];
const keys = (songs: AggregatedSong[]): string[] => songs.map((s) => s.title);

describe('what a song says about itself', () => {
  it('prefers the provider album (one album, one spelling), falls back to the one of the mention', () => {
    expect(albumOf(mk('A', 'B', { album: 'Discovery', mentionAlbum: 'Discovery (Remastered)' }))).toBe('Discovery');
    expect(albumOf(MYSTERY)).toBe('Mystery LP');
    expect(albumOf(mk('A', 'B', { album: '  ', mentionAlbum: null }))).toBeNull();
  });

  it('canonicalises the genres: synonyms are one genre', () => {
    expect(genresOf(AROUND)).toEqual(['Elettronica']);
    expect(genresOf(ONE_MORE)).toEqual(['Elettronica']);
    expect(genresOf(CREEP)).toEqual(['Alternative']);
    expect(genresOf(MYSTERY)).toEqual([]);
  });

  it('reads the year, null when unknown', () => {
    expect(yearOf(BILLIE)).toBe(1982);
    expect(yearOf(MYSTERY)).toBeNull();
    expect(yearOf(mk('A', 'B', { year: null }))).toBeNull();
  });
});

describe('filterSongs', () => {
  it('with no filter gives every song, in the order it was given', () => {
    expect(keys(filterSongs(SONGS, {}))).toEqual(keys(SONGS));
  });

  it('filters by genre, synonyms included (the "tipo" filter)', () => {
    expect(keys(filterSongs(SONGS, { genre: 'Elettronica' }))).toEqual(['One More Time', 'Around the World']);
    expect(keys(filterSongs(SONGS, { genre: 'electronic' }))).toEqual(['One More Time', 'Around the World']);
    expect(keys(filterSongs(SONGS, { genre: 'Alternativa' }))).toEqual(['Creep', 'Everlong']);
    expect(keys(filterSongs(SONGS, { genre: 'Rock' }))).toEqual(['Beat It']);
  });

  it('filters by decade: "anni 80" is 1980 to 1989', () => {
    expect(keys(filterSongs(SONGS, { decade: 1980 }))).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer', 'Untitled']);
    expect(keys(filterSongs(SONGS, { decade: 1990 }))).toEqual(['Around the World', 'Creep', 'Everlong']);
    expect(keys(filterSongs(SONGS, { decade: 2000 }))).toEqual(['One More Time', 'Il Mio Ragazzo']);
    expect(filterSongs(SONGS, { decade: 1970 })).toEqual([]);
  });

  it('"Senza anno" finds the songs no provider dated', () => {
    expect(keys(filterSongs(SONGS, { decade: NO_YEAR }))).toEqual(['Mystery']);
  });

  it('filters by album, ignoring case, accents and punctuation', () => {
    expect(keys(filterSongs(SONGS, { album: 'thriller' }))).toEqual(['Billie Jean', 'Beat It']);
    expect(keys(filterSongs(SONGS, { album: 'THE COLOUR AND THE SHAPE' }))).toEqual(['Everlong']);
    expect(keys(filterSongs(SONGS, { album: 'mystery lp' }))).toEqual(['Mystery']);
  });

  it('filters by artist', () => {
    expect(keys(filterSongs(SONGS, { artist: 'daft punk' }))).toEqual(['One More Time', 'Around the World']);
  });

  it('free text: the order of the words does not matter ("Maestro Bassi" finds "Bassi Maestro")', () => {
    expect(keys(filterSongs(SONGS, { q: 'Maestro Bassi' }))).toEqual(['Il Mio Ragazzo']);
    expect(keys(filterSongs(SONGS, { q: 'jean billie' }))).toEqual(['Billie Jean']);
    expect(keys(filterSongs(SONGS, { q: 'pablo honey' }))).toEqual(['Creep']); // through the album
  });

  it('combines filters: every one must hold', () => {
    expect(keys(filterSongs(SONGS, { genre: 'Pop', decade: 1980 }))).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer', 'Untitled']);
    expect(keys(filterSongs(SONGS, { genre: 'Pop', decade: 1980, artist: 'madonna' }))).toEqual(['Like a Prayer']);
    expect(filterSongs(SONGS, { genre: 'Pop', decade: 2000 })).toEqual([]);
  });

  it('can leave one filter out (what a facet counts over)', () => {
    expect(keys(filterSongs(SONGS, { genre: 'Rock', decade: 1990 }, 'genre'))).toEqual(['Around the World', 'Creep', 'Everlong']);
  });

  it('a blank filter is no filter', () => {
    expect(keys(filterSongs(SONGS, { q: '   ', genre: '' }))).toEqual(keys(SONGS));
  });
});

describe('computeFacets', () => {
  it('counts genres with the synonyms merged, most songs first', () => {
    const { genres } = computeFacets(SONGS, {});
    expect(genres[0]).toEqual({ value: 'Pop', label: 'Pop', count: 4 }); // Billie Jean, Beat It, Like a Prayer, Untitled
    expect(genres.find((g) => g.value === 'Elettronica')?.count).toBe(2);
    expect(genres.find((g) => g.value === 'Alternative')?.count).toBe(2);
    expect(genres.find((g) => g.value === 'Rock')?.count).toBe(1);
    expect(genres.map((g) => g.value)).not.toContain('Electronic');
    expect(genres.map((g) => g.value)).not.toContain('Alternativa');
  });

  it('lists decades chronologically with "Senza anno" last', () => {
    const { decades } = computeFacets(SONGS, {});
    expect(decades).toEqual([
      { value: 1980, label: 'Anni 80', count: 4 },
      { value: 1990, label: 'Anni 90', count: 3 },
      { value: 2000, label: 'Anni 2000', count: 2 },
      { value: NO_YEAR, label: 'Senza anno', count: 1 },
    ]);
  });

  it('has no "Senza anno" entry when every song has a year', () => {
    expect(computeFacets([BILLIE, PRAYER], {}).decades.map((d) => d.value)).toEqual([1980]);
  });

  it('counts albums and artists, leaving out the blanks', () => {
    const { albums, artists } = computeFacets(SONGS, {});
    expect(albums[0]).toEqual({ value: 'Thriller', label: 'Thriller', count: 2 });
    expect(albums.map((a) => a.value)).toContain('Mystery LP');
    expect(albums.map((a) => a.value)).not.toContain('');
    expect(artists.slice(0, 2).map((a) => [a.value, a.count])).toEqual([['Daft Punk', 2], ['Michael Jackson', 2]]); // ties A to Z
    expect(artists.map((a) => a.value)).not.toContain('');
  });

  it('each heading counts without its own filter: picking a genre narrows the albums but keeps the other genres', () => {
    const f = { genre: 'Elettronica' };
    const facets = computeFacets(SONGS, f);
    expect(facets.albums.map((a) => a.value).sort()).toEqual(['Discovery', 'Homework']);
    expect(facets.artists.map((a) => a.value)).toEqual(['Daft Punk']);
    expect(facets.genres.map((g) => g.value)).toContain('Pop'); // still there to switch to
    expect(facets.genres.find((g) => g.value === 'Pop')?.count).toBe(4);
    expect(facets.decades.map((d) => d.value)).toEqual([1990, 2000]);
  });

  it('a decade filter narrows the genres but not the decades', () => {
    const facets = computeFacets(SONGS, { decade: 1980 });
    expect(facets.genres.map((g) => g.value).sort()).toEqual(['Pop', 'Rock']);
    expect(facets.decades.map((d) => d.value)).toEqual([1980, 1990, 2000, NO_YEAR]);
  });

  it('spells a value the way most of its songs do', () => {
    const songs = [
      mk('Daft Punk', 'a', { album: 'Discovery' }),
      mk('daft punk', 'b', { album: 'discovery' }),
      mk('Daft Punk', 'c', { album: 'Discovery' }),
    ];
    const { albums, artists } = computeFacets(songs, {});
    expect(albums).toEqual([{ value: 'Discovery', label: 'Discovery', count: 3 }]);
    expect(artists).toEqual([{ value: 'Daft Punk', label: 'Daft Punk', count: 3 }]);
  });

  it('of nothing, gives nothing', () => {
    expect(computeFacets([], {})).toEqual({ genres: [], albums: [], artists: [], decades: [] });
  });
});

describe('sortByArtistTitle', () => {
  it('sorts by artist, then title, accents and case aside, without touching the input', () => {
    const input = [mk('b', 'z'), mk('A', 'y'), mk('b', 'a'), mk('À', 'b')];
    const sorted = sortByArtistTitle(input);
    expect(sorted.map((s) => `${s.artist}/${s.title}`)).toEqual(['A/y', 'À/b', 'b/a', 'b/z']);
    expect(input.map((s) => s.title)).toEqual(['z', 'y', 'a', 'b']);
  });
});

describe('parseLibraryQuery', () => {
  it('has sensible defaults', () => {
    expect(parseLibraryQuery({})).toEqual({ ok: true, filters: {}, limit: 100, offset: 0, facets: true });
  });

  it('reads every filter, trimmed', () => {
    const r = parseLibraryQuery({ q: ' sade ', genre: 'Pop', album: 'Thriller', artist: 'Madonna', decade: '1980', limit: '50', offset: '100' });
    expect(r).toEqual({ ok: true, filters: { q: 'sade', genre: 'Pop', album: 'Thriller', artist: 'Madonna', decade: 1980 }, limit: 50, offset: 100, facets: true });
  });

  it('accepts "none" as the decade (songs without a year)', () => {
    expect(parseLibraryQuery({ decade: 'none' })).toMatchObject({ ok: true, filters: { decade: NO_YEAR } });
  });

  it('treats blank values as absent', () => {
    expect(parseLibraryQuery({ q: '   ', genre: '', decade: '', limit: '' })).toEqual({ ok: true, filters: {}, limit: 100, offset: 0, facets: true });
  });

  it('lets a client skip the facets (paging does not need them again)', () => {
    expect(parseLibraryQuery({ facets: '0' })).toMatchObject({ ok: true, facets: false });
    expect(parseLibraryQuery({ facets: '1' })).toMatchObject({ ok: true, facets: true });
  });

  it('rejects a decade that is not a decade, naming the field', () => {
    for (const decade of ['1985', 'abc', '1890', '2100', '-1980', '19.80']) {
      expect(parseLibraryQuery({ decade })).toEqual({ ok: false, field: 'decade' });
    }
  });

  it('rejects limits and offsets out of range', () => {
    expect(parseLibraryQuery({ limit: '0' })).toEqual({ ok: false, field: 'limit' });
    expect(parseLibraryQuery({ limit: '501' })).toEqual({ ok: false, field: 'limit' });
    expect(parseLibraryQuery({ limit: 'x' })).toEqual({ ok: false, field: 'limit' });
    expect(parseLibraryQuery({ limit: '500' })).toMatchObject({ ok: true, limit: 500 });
    expect(parseLibraryQuery({ offset: '-1' })).toEqual({ ok: false, field: 'offset' });
    expect(parseLibraryQuery({ offset: '1.5' })).toEqual({ ok: false, field: 'offset' });
  });

  it('rejects text that is too long, and anything that is not a single string (repeated parameters)', () => {
    expect(parseLibraryQuery({ q: 'x'.repeat(201) })).toEqual({ ok: false, field: 'q' });
    expect(parseLibraryQuery({ genre: ['Pop', 'Rock'] })).toEqual({ ok: false, field: 'genre' });
    expect(parseLibraryQuery({ album: { a: 1 } })).toEqual({ ok: false, field: 'album' });
    expect(parseLibraryQuery({ q: 'x'.repeat(200) })).toMatchObject({ ok: true });
  });
});
