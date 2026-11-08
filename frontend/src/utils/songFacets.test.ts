import { describe, expect, it } from 'vitest';
import {
  NO_YEAR,
  albumOf,
  artistOf,
  decadeLabel,
  decadeLabelFor,
  decadeOf,
  genreKey,
  genresOf,
  matchesAll,
  normalizeSearch,
  tally,
  tokenize,
  traitsOf,
  yearOf,
} from './songFacets';
import { canonicalGenre, isCanonicalGenre } from './genres';
import type { AggregatedSong, SongMetaRecord } from '../types';

function song(patch: Partial<AggregatedSong> = {}, meta: Partial<SongMetaRecord> | null = {}): AggregatedSong {
  return {
    songKey: 'a::b', title: 'B', artist: 'A', album: null, youtubeUrl: null, spotifyUrl: null, mentions: [],
    meta: meta === null ? null : {
      songKey: 'a::b', deezerId: null, itunesId: null, genres: [], album: null, coverUrl: null, previewUrl: null,
      deezerUrl: null, itunesUrl: null, enrichedAt: null, listened: false, favorite: false, downloaded: false,
      rating: null, score: null, ...meta,
    },
    ...patch,
  };
}

describe('text: no case, no accents, no punctuation, any word order', () => {
  it('normalises', () => {
    expect(normalizeSearch('Beyoncé — Déjà Vu!')).toBe('beyonce deja vu');
    expect(normalizeSearch('AC/DC')).toBe('ac dc');
    expect(normalizeSearch('  Maestro   Bassi ')).toBe('maestro bassi');
    expect(normalizeSearch('Mötley Crüe')).toBe('motley crue');
    expect(normalizeSearch('')).toBe('');
  });

  it('tokenises and matches every word, wherever it is', () => {
    expect(tokenize('Maestro Bassi')).toEqual(['maestro', 'bassi']);
    expect(tokenize('   ')).toEqual([]);
    expect(matchesAll(normalizeSearch('Bassi Maestro Il Mio Ragazzo'), tokenize('maestro bassi'))).toBe(true);
    expect(matchesAll(normalizeSearch('Bassi Maestro'), tokenize('maestro daft'))).toBe(false);
    expect(matchesAll('anything', [])).toBe(true);
  });
});

describe('decades', () => {
  it('1989 is the eighties and 1990 the nineties (the boundaries)', () => {
    expect(decadeOf(1979)).toBe(1970);
    expect(decadeOf(1980)).toBe(1980);
    expect(decadeOf(1989)).toBe(1980);
    expect(decadeOf(1990)).toBe(1990);
    expect(decadeOf(1999)).toBe(1990);
    expect(decadeOf(2000)).toBe(2000);
    expect(decadeOf(2009)).toBe(2000);
    expect(decadeOf(2010)).toBe(2010);
  });

  it('says them the way people say them in Italian: "Anni 80", but "Anni 2000"', () => {
    expect(decadeLabel(1920)).toBe('Anni 20');
    expect(decadeLabel(1950)).toBe('Anni 50');
    expect(decadeLabel(1980)).toBe('Anni 80');
    expect(decadeLabel(1990)).toBe('Anni 90');
    expect(decadeLabel(2000)).toBe('Anni 2000');
    expect(decadeLabel(2010)).toBe('Anni 2010');
    expect(decadeLabel(2020)).toBe('Anni 2020');
    expect(decadeLabel(1910)).toBe('Anni 1910');
  });

  it('and as "1980s" in English', () => {
    expect(decadeLabelFor(1980, 'en')).toBe('1980s');
    expect(decadeLabelFor(1980, 'it')).toBe('Anni 80');
  });
});

describe('what a song says about itself', () => {
  it('the year is a plausible number, else none', () => {
    expect(yearOf(song({}, { releaseYear: 1989 }))).toBe(1989);
    expect(yearOf(song({}, { releaseYear: null }))).toBeNull();
    expect(yearOf(song({}, {}))).toBeNull(); // an older backend: the field is not there at all
    expect(yearOf(song({}, null))).toBeNull();
    expect(yearOf(song({}, { releaseYear: 0 }))).toBeNull();
    expect(yearOf(song({}, { releaseYear: Number.NaN }))).toBeNull();
  });

  it('the album is the provider’s when there is one, else the mention’s, else none', () => {
    expect(albumOf(song({ album: 'Discovery (Remastered)' }, { album: 'Discovery' }))).toBe('Discovery');
    expect(albumOf(song({ album: 'Mystery LP' }, null))).toBe('Mystery LP');
    expect(albumOf(song({ album: '  ' }, { album: '' }))).toBeNull();
  });

  it('the artist, tidied, or none', () => {
    expect(artistOf(song({ artist: '  Daft   Punk ' }))).toBe('Daft Punk');
    expect(artistOf(song({ artist: ' ' }))).toBeNull();
  });

  it('a song has ONE entry per genre, however its providers spell it', () => {
    const refs = genresOf(song({}, { genres: ['Alternative', 'Alternativa', 'Rock', '  ', 'Jazz'] }));
    expect(refs.map((r) => r.key)).toEqual(['alternative', 'rock', 'jazz']);
    expect(refs[0].spelled).toBe('Alternative');
    expect(genresOf(song({}, null))).toEqual([]);
  });

  it('works out everything a filter reads, once per song object', () => {
    const s = song({ artist: 'Daft Punk', title: 'One More Time', album: null }, { album: 'Discovery', genres: ['Electronic'], releaseYear: 2001 });
    const t = traitsOf(s);
    expect(t).toMatchObject({ text: 'daft punk one more time discovery', artistKey: 'daft punk', albumKey: 'discovery', decade: 2000 });
    expect(t.genres.map((g) => g.key)).toEqual(['elettronica']);
    expect(traitsOf(s)).toBe(t); // cached
    expect(traitsOf(song({}, { releaseYear: null })).decade).toBeNull();
    expect(NO_YEAR).toBe('none');
  });
});

describe('genres: synonyms are one genre (the same list as the backend)', () => {
  it('maps the variants to one name and leaves the unknown alone', () => {
    expect(canonicalGenre('Alternativa')).toBe('Alternative');
    expect(canonicalGenre('alternative rock')).toBe('Alternative');
    expect(canonicalGenre('Rap/Hip Hop')).toBe('Hip-Hop/Rap');
    expect(canonicalGenre('hip hop')).toBe('Hip-Hop/Rap');
    expect(canonicalGenre('Electro')).toBe('Elettronica');
    expect(canonicalGenre('Electronic')).toBe('Elettronica');
    expect(canonicalGenre('Film/Videogiochi')).toBe('Colonne sonore');
    expect(canonicalGenre('Musica Latina')).toBe('Latina');
    expect(canonicalGenre('  Jazz  ')).toBe('Jazz');
    expect(canonicalGenre('Trap')).toBe('Trap');
  });

  it('a genre picked under any spelling has the same key', () => {
    expect(genreKey('Alternativa')).toBe(genreKey('Alternative'));
    expect(genreKey('ELECTRONIC')).toBe(genreKey('Elettronica'));
    expect(genreKey('Rock')).not.toBe(genreKey('Pop'));
  });

  it('knows which names are the canonical ones', () => {
    expect(isCanonicalGenre('Elettronica')).toBe(true);
    expect(isCanonicalGenre('Electronic')).toBe(false);
  });
});

describe('tally', () => {
  const refs = (s: AggregatedSong) => [{ key: normalizeSearch(s.artist), spelled: s.artist }];

  it('one entry per value, spelt as most songs spell it, most songs first then A to Z', () => {
    const songs = [song({ artist: 'Daft Punk' }), song({ artist: 'daft punk' }), song({ artist: 'Daft Punk' }), song({ artist: 'Air' }), song({ artist: 'Bjork' })];
    expect(tally(songs, refs)).toEqual([['Daft Punk', 3], ['Air', 1], ['Bjork', 1]]);
  });

  it('on a tie the preferred spelling wins, then A to Z', () => {
    const songs = [song({ artist: 'Electronic' }), song({ artist: 'Elettronica' })];
    const both = (s: AggregatedSong) => [{ key: 'elettronica', spelled: s.artist }];
    expect(tally(songs, both, isCanonicalGenre)).toEqual([['Elettronica', 2]]);
    expect(tally(songs, both)).toEqual([['Electronic', 2]]);
  });

  it('counts a song once per value and skips blank values', () => {
    const twice = (s: AggregatedSong) => [{ key: 'x', spelled: 'X' }, { key: 'x', spelled: 'X' }, { key: '', spelled: '' }, { key: 'y', spelled: s.artist }];
    expect(tally([song({ artist: 'Y' })], twice)).toEqual([['X', 1], ['Y', 1]]);
    expect(tally([], refs)).toEqual([]);
  });
});
