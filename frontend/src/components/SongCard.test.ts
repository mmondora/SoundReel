import { describe, it, expect, afterEach } from 'vitest';
import {
  computeIsPlaying,
  youtubeSearchUrl,
  _setSharedAudioForTest,
  _getSharedAudioKeyForTest,
  _releaseSharedAudioIfOwnerForTest,
} from './SongCard';

describe('computeIsPlaying', () => {
  it('false when no audio is active', () => {
    expect(computeIsPlaying('a::b', null, null)).toBe(false);
  });

  it('false when another song owns the active key', () => {
    expect(computeIsPlaying('a::b', 'c::d', { paused: false, ended: false })).toBe(false);
  });

  it('false when this song owns the key but playback is paused', () => {
    expect(computeIsPlaying('a::b', 'a::b', { paused: true, ended: false })).toBe(false);
  });

  it('true when this song owns the key and playback is not paused', () => {
    expect(computeIsPlaying('a::b', 'a::b', { paused: false, ended: false })).toBe(true);
  });

  it('false when the key matches but there is no audio object (defensive)', () => {
    expect(computeIsPlaying('a::b', 'a::b', null)).toBe(false);
  });

  it('false when this song owns the key and is not paused but has ended', () => {
    // A finished HTMLAudioElement can report paused=false in some browsers
    // right at the ended transition — `ended` must be checked explicitly so
    // playback-finished is never mistaken for still-playing.
    expect(computeIsPlaying('a::b', 'a::b', { paused: false, ended: true })).toBe(false);
  });
});

describe('releaseSharedAudioIfOwner (via test-only accessors)', () => {
  afterEach(() => _setSharedAudioForTest(null, null));

  it('clears ownership and the audio ref when the given key is the current owner', () => {
    _setSharedAudioForTest('a::b', { paused: false });
    _releaseSharedAudioIfOwnerForTest('a::b');
    expect(_getSharedAudioKeyForTest()).toBeNull();
  });

  it('does nothing when another song currently owns the key', () => {
    _setSharedAudioForTest('c::d', { paused: false });
    _releaseSharedAudioIfOwnerForTest('a::b');
    expect(_getSharedAudioKeyForTest()).toBe('c::d');
  });

  it('is a no-op when nothing owns the key yet', () => {
    _setSharedAudioForTest(null, null);
    _releaseSharedAudioIfOwnerForTest('a::b');
    expect(_getSharedAudioKeyForTest()).toBeNull();
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
