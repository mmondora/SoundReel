import { describe, it, expect } from 'vitest';
import { filterSongs, collectGenres } from './songFilters';
import type { AggregatedSong } from '../types';

function song(key: string, meta: Partial<NonNullable<AggregatedSong['meta']>> | null): AggregatedSong {
  return {
    songKey: key, title: key, artist: 'Artist', album: null,
    youtubeUrl: null, spotifyUrl: null, mentions: [],
    meta: meta === null ? null : {
      songKey: key, deezerId: null, itunesId: null, genres: [], album: null,
      coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null,
      enrichedAt: null, listened: false, favorite: false, downloaded: false,
      rating: null, score: null,
      ...meta,
    },
  };
}

const SONGS = [
  song('a', { genres: ['Pop'], listened: true, favorite: true, downloaded: true }),
  song('b', { genres: ['Rock', 'Pop'], downloaded: false }),
  song('c', null),
];

describe('filterSongs', () => {
  it('no filters returns everything', () => {
    expect(filterSongs(SONGS, { genres: [], listened: 'all', favorite: false, downloaded: 'all' })).toHaveLength(3);
  });

  it('genre filter is OR across selected genres', () => {
    const out = filterSongs(SONGS, { genres: ['Rock'], listened: 'all', favorite: false, downloaded: 'all' });
    expect(out.map((s) => s.songKey)).toEqual(['b']);
  });

  it('listened / unlistened split; missing meta counts as unlistened', () => {
    expect(filterSongs(SONGS, { genres: [], listened: 'listened', favorite: false, downloaded: 'all' }).map((s) => s.songKey)).toEqual(['a']);
    expect(filterSongs(SONGS, { genres: [], listened: 'unlistened', favorite: false, downloaded: 'all' }).map((s) => s.songKey)).toEqual(['b', 'c']);
  });

  it('favorite-only filter; missing meta counts as not-favorite', () => {
    expect(filterSongs(SONGS, { genres: [], listened: 'all', favorite: true, downloaded: 'all' }).map((s) => s.songKey)).toEqual(['a']);
  });

  it('favorite false does not filter anything out', () => {
    expect(filterSongs(SONGS, { genres: [], listened: 'all', favorite: false, downloaded: 'all' })).toHaveLength(3);
  });

  it('downloaded yes/no split; missing meta counts as not-downloaded', () => {
    expect(filterSongs(SONGS, { genres: [], listened: 'all', favorite: false, downloaded: 'yes' }).map((s) => s.songKey)).toEqual(['a']);
    expect(filterSongs(SONGS, { genres: [], listened: 'all', favorite: false, downloaded: 'no' }).map((s) => s.songKey)).toEqual(['b', 'c']);
  });

  it('combines filters (AND across categories, OR within genres)', () => {
    const out = filterSongs(SONGS, { genres: ['Pop'], listened: 'all', favorite: false, downloaded: 'no' });
    expect(out.map((s) => s.songKey)).toEqual(['b']);
  });
});

describe('collectGenres', () => {
  it('unique sorted genre list', () => {
    expect(collectGenres(SONGS)).toEqual(['Pop', 'Rock']);
  });
});
