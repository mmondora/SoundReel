import { describe, it, expect } from 'vitest';
import { computeIsPlaying, youtubeSearchUrl } from './SongCard';

describe('computeIsPlaying', () => {
  it('false when no audio is active', () => {
    expect(computeIsPlaying('a::b', null, null)).toBe(false);
  });

  it('false when another song owns the active key', () => {
    expect(computeIsPlaying('a::b', 'c::d', { paused: false })).toBe(false);
  });

  it('false when this song owns the key but playback is paused', () => {
    expect(computeIsPlaying('a::b', 'a::b', { paused: true })).toBe(false);
  });

  it('true when this song owns the key and playback is not paused', () => {
    expect(computeIsPlaying('a::b', 'a::b', { paused: false })).toBe(true);
  });

  it('false when the key matches but there is no audio object (defensive)', () => {
    expect(computeIsPlaying('a::b', 'a::b', null)).toBe(false);
  });
});

describe('youtubeSearchUrl', () => {
  it('encodes "artist title" with no leading/trailing space', () => {
    expect(youtubeSearchUrl('Queen', 'Bohemian Rhapsody')).toBe(
      `https://youtube.com/results?search_query=${encodeURIComponent('Queen Bohemian Rhapsody')}`
    );
  });

  it('trims the leading space produced by an empty artist', () => {
    expect(youtubeSearchUrl('', 'Bohemian Rhapsody')).toBe(
      `https://youtube.com/results?search_query=${encodeURIComponent('Bohemian Rhapsody')}`
    );
  });

  it('trims the trailing space produced by an empty title', () => {
    expect(youtubeSearchUrl('Queen', '')).toBe(
      `https://youtube.com/results?search_query=${encodeURIComponent('Queen')}`
    );
  });
});
