import { describe, it, expect } from 'vitest';
import { artistOf, dedupeKey } from './SongsPage';
import type { Song } from '../types';

/**
 * Regression cover for a production crash: one extracted track carried
 * `artist: null` (the Song type says string), and an unguarded `.trim()` in the
 * dedupe key took the entire songs page down with a white screen.
 */
function song(partial: Partial<Song>): Song {
  return {
    title: 'Some Title',
    artist: 'Some Artist',
    album: null,
    source: 'ai_analysis',
    spotifyUri: null,
    spotifyUrl: null,
    youtubeUrl: null,
    soundcloudUrl: null,
    addedToPlaylist: false,
    ...partial,
  };
}

describe('artistOf', () => {
  it('returns the trimmed artist', () => {
    expect(artistOf(song({ artist: '  Queen  ' }))).toBe('Queen');
  });

  it('returns an empty string for a null artist instead of throwing', () => {
    expect(artistOf(song({ artist: null as unknown as string }))).toBe('');
  });

  it('returns an empty string for an undefined artist', () => {
    expect(artistOf(song({ artist: undefined as unknown as string }))).toBe('');
  });

  it('returns an empty string for a whitespace-only artist', () => {
    expect(artistOf(song({ artist: '   ' }))).toBe('');
  });
});

describe('dedupeKey', () => {
  it('matches the same track regardless of case and padding', () => {
    expect(dedupeKey(song({ artist: 'Queen', title: 'Bohemian Rhapsody' })))
      .toBe(dedupeKey(song({ artist: ' QUEEN ', title: 'bohemian rhapsody ' })));
  });

  it('separates different tracks by the same artist', () => {
    expect(dedupeKey(song({ artist: 'Queen', title: 'A' })))
      .not.toBe(dedupeKey(song({ artist: 'Queen', title: 'B' })));
  });

  it('does not throw on a null artist', () => {
    expect(() => dedupeKey(song({ artist: null as unknown as string }))).not.toThrow();
    expect(dedupeKey(song({ artist: null as unknown as string, title: 'UFO Robot' })))
      .toBe('|ufo robot');
  });

  it('does not throw on a null title', () => {
    expect(() => dedupeKey(song({ title: null as unknown as string }))).not.toThrow();
  });
});
