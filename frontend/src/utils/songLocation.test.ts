import { describe, expect, it } from 'vitest';
import {
  isAtHome,
  locationBadge,
  locationFromState,
  locationOverridesFrom,
  resolveSongLocation,
  resolveSongPlace,
  songLocationIn,
  youtubeLink,
} from './songLocation';

describe('resolveSongLocation', () => {
  it('uses the backend flags when present, independently of each other', () => {
    expect(resolveSongLocation({ fs: true, mediaServer: false })).toEqual({ fs: true, mediaServer: false });
    expect(resolveSongLocation({ fs: false, mediaServer: true })).toEqual({ fs: false, mediaServer: true });
    expect(resolveSongLocation({ fs: true, mediaServer: true })).toEqual({ fs: true, mediaServer: true });
  });

  it('a flag from the backend wins over inLibrary', () => {
    expect(resolveSongLocation({ fs: false, inLibrary: true })).toEqual({ fs: false, mediaServer: false });
  });

  it('an old backend (no flags): inLibrary means FS, otherwise streaming only', () => {
    expect(resolveSongLocation({ inLibrary: true })).toEqual({ fs: true, mediaServer: false });
    expect(resolveSongLocation({ inLibrary: false })).toEqual({ fs: false, mediaServer: false });
    expect(resolveSongLocation({})).toEqual({ fs: false, mediaServer: false });
  });

  it('an override replaces only what it knows', () => {
    expect(resolveSongLocation({ fs: false, mediaServer: true }, { fs: true })).toEqual({ fs: true, mediaServer: true });
    expect(resolveSongLocation({ inLibrary: false }, { fs: true, mediaServer: true })).toEqual({ fs: true, mediaServer: true });
    expect(resolveSongLocation({ fs: true }, null)).toEqual({ fs: true, mediaServer: false });
  });
});

describe('locationBadge', () => {
  it('FS, MS, FS+MS, and none for streaming only', () => {
    expect(locationBadge({ fs: true, mediaServer: false })).toBe('FS');
    expect(locationBadge({ fs: false, mediaServer: true })).toBe('MS');
    expect(locationBadge({ fs: true, mediaServer: true })).toBe('FS+MS');
    expect(locationBadge({ fs: false, mediaServer: false })).toBeNull();
  });
});

describe('locationOverridesFrom', () => {
  it('only finished downloads change a badge; the file is at least on the disk (FS)', () => {
    const out = locationOverridesFrom({
      a: { songKey: 'a', phase: 'ready' },
      b: { songKey: 'b', phase: 'ready', location: { fs: true, mediaServer: true } },
      c: { songKey: 'c', phase: 'downloading' },
      d: { songKey: 'd', phase: 'failed', error: 'x' },
    });
    expect(out).toEqual({ a: { fs: true }, b: { fs: true, mediaServer: true } });
  });

  it('songLocationIn applies the override of that song only', () => {
    const overrides = { 'a::one': { fs: true } };
    expect(songLocationIn({ songKey: 'a::one', inLibrary: false }, overrides)).toEqual({ fs: true, mediaServer: false });
    expect(songLocationIn({ songKey: 'b::two', inLibrary: false }, overrides)).toEqual({ fs: false, mediaServer: false });
  });
});

describe('isAtHome (what the green dot means)', () => {
  it('is fs || mediaServer', () => {
    expect(isAtHome({ fs: true, mediaServer: false })).toBe(true);
    expect(isAtHome({ fs: false, mediaServer: true })).toBe(true);
    expect(isAtHome({ fs: true, mediaServer: true })).toBe(true);
    expect(isAtHome({ fs: false, mediaServer: false })).toBe(false);
  });
});

describe('resolveSongPlace (rule W8: where, in words)', () => {
  const song = { fs: true, mediaServer: true, fsPath: '~/Music/SoundReel/Kavinsky - Nightcall.mp3', mediaUrl: 'http://fritz/Music/Kavinsky/Nightcall.mp3' };

  it('carries the addresses of the places the song is at', () => {
    expect(resolveSongPlace(song)).toEqual({
      fs: true, mediaServer: true, fsPath: song.fsPath, mediaUrl: song.mediaUrl, streamUrl: null,
    });
  });

  it('an address only shows for a place the song really is at (a stale path is not "there")', () => {
    expect(resolveSongPlace({ ...song, fs: false })).toMatchObject({ fs: false, fsPath: null, mediaServer: true, mediaUrl: song.mediaUrl });
    expect(resolveSongPlace({ ...song, mediaServer: false })).toMatchObject({ mediaServer: false, mediaUrl: null, fsPath: song.fsPath });
  });

  it('missing addresses are null (an old backend sends none)', () => {
    expect(resolveSongPlace({ fs: true, mediaServer: false })).toEqual({ fs: true, mediaServer: false, fsPath: null, mediaUrl: null, streamUrl: null });
    expect(resolveSongPlace({ inLibrary: true })).toMatchObject({ fs: true, fsPath: null });
  });

  it('the session override (a finished download, or a fresh state) wins, addresses included', () => {
    const place = resolveSongPlace(
      { fs: false, mediaServer: false },
      { fs: true, fsPath: '~/Music/SoundReel/X.mp3', streamUrl: 'https://youtu.be/abc' },
    );
    expect(place).toEqual({ fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/X.mp3', mediaUrl: null, streamUrl: 'https://youtu.be/abc' });
  });
});

describe('locationOverridesFrom keeps the addresses the server sent', () => {
  it('a ready download brings its paths along; a partial answer brings only what it has', () => {
    const out = locationOverridesFrom({
      'a::b': { songKey: 'a::b', phase: 'ready', location: { fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/b.mp3', mediaUrl: null, streamUrl: 'https://youtu.be/b' } },
      'c::d': { songKey: 'c::d', phase: 'ready' },
    });
    expect(out['a::b']).toEqual({ fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/b.mp3', streamUrl: 'https://youtu.be/b' });
    expect(out['c::d']).toEqual({ fs: true });
  });
});

describe('locationFromState', () => {
  it('uses location when the backend sends it, otherwise inLibrary means FS', () => {
    expect(locationFromState({ inLibrary: false, location: { fs: false, mediaServer: true, mediaUrl: 'http://fritz/x.mp3' } })).toEqual({ fs: false, mediaServer: true, mediaUrl: 'http://fritz/x.mp3' });
    expect(locationFromState({ inLibrary: true })).toEqual({ fs: true, mediaServer: false });
    expect(locationFromState({ inLibrary: false })).toEqual({ fs: false, mediaServer: false });
  });
});

describe('youtubeLink', () => {
  const song = { artist: 'Kavinsky', title: 'Nightcall', youtubeUrl: null };

  it('prefers the address the server knows (stream URL), then the stored one', () => {
    expect(youtubeLink(song, 'https://www.youtube.com/watch?v=abc')).toEqual({ url: 'https://www.youtube.com/watch?v=abc', exact: true });
    expect(youtubeLink({ ...song, youtubeUrl: 'https://youtu.be/xyz' })).toEqual({ url: 'https://youtu.be/xyz', exact: true });
    expect(youtubeLink({ ...song, youtubeUrl: 'https://youtu.be/xyz' }, 'https://www.youtube.com/watch?v=abc').url).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('with no video known it is a search link (never the Data API)', () => {
    expect(youtubeLink(song)).toEqual({ url: 'https://youtube.com/results?search_query=Kavinsky%20Nightcall', exact: false });
    expect(youtubeLink(song, '  ').exact).toBe(false);
  });
});
