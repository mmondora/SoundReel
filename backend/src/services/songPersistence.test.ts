import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({ getEntry: vi.fn(), updateEntry: vi.fn() }));

import { resolvedToSongs, appendSongsToEntry } from './songPersistence';
import { getEntry, updateEntry } from '../utils/db';
import type { ResolvedSong } from './songResolver';
import type { Entry, Song } from '../types';

function makeEntry(songs: unknown, overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    sourceUrl: 'https://example.com/top10',
    sourcePlatform: 'other',
    inputChannel: 'web',
    inputUser: null,
    caption: null,
    thumbnailUrl: null,
    mediaUrl: null,
    status: 'completed',
    results: { songs, films: [], notes: [], links: [], tags: [], summary: null } as never,
    actionLog: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeResolved(overrides: Partial<ResolvedSong> = {}): ResolvedSong {
  return {
    title: 'One More Time',
    artist: 'Daft Punk',
    spotifyUrl: 'https://open.spotify.com/track/123',
    spotifyUri: 'spotify:track:123',
    youtubeUrl: 'https://youtube.com/results?search_query=One+More+Time+Daft+Punk',
    sentToSpooty: true,
    ...overrides,
  };
}

describe('resolvedToSongs', () => {
  it('maps ResolvedSong to Song with source music_list, album null, addedToPlaylist false', () => {
    const songs = resolvedToSongs([makeResolved()]);
    expect(songs).toEqual([{
      title: 'One More Time',
      artist: 'Daft Punk',
      album: null,
      source: 'music_list',
      spotifyUri: 'spotify:track:123',
      spotifyUrl: 'https://open.spotify.com/track/123',
      youtubeUrl: 'https://youtube.com/results?search_query=One+More+Time+Daft+Punk',
      soundcloudUrl: null,
      addedToPlaylist: false,
    }]);
  });

  it('maps a resolved song with no Spotify match to null spotify fields', () => {
    const songs = resolvedToSongs([makeResolved({ spotifyUrl: null, spotifyUri: null, sentToSpooty: false })]);
    expect(songs[0].spotifyUrl).toBeNull();
    expect(songs[0].spotifyUri).toBeNull();
  });

  it('maps an empty list to an empty list', () => {
    expect(resolvedToSongs([])).toEqual([]);
  });
});

describe('appendSongsToEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 without reading/writing when given no songs', async () => {
    const count = await appendSongsToEntry('entry-1', []);
    expect(count).toBe(0);
    expect(getEntry).not.toHaveBeenCalled();
    expect(updateEntry).not.toHaveBeenCalled();
  });

  it('appends new songs and returns the count appended', async () => {
    vi.mocked(getEntry).mockResolvedValue(makeEntry([]));
    const incoming: Song[] = resolvedToSongsHelper();
    const count = await appendSongsToEntry('entry-1', incoming);
    expect(count).toBe(1);
    expect(updateEntry).toHaveBeenCalledWith('entry-1', {
      'results.songs': incoming,
    });
  });

  it('does not duplicate a song whose songKey already exists in results.songs', async () => {
    const existing: Song = {
      title: 'One More Time', artist: 'Daft Punk', album: 'Discovery',
      source: 'audio_fingerprint', spotifyUri: null, spotifyUrl: null,
      youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false,
    };
    vi.mocked(getEntry).mockResolvedValue(makeEntry([existing]));
    const incoming = resolvedToSongsHelper(); // same title/artist, different casing tolerated by songKey
    const count = await appendSongsToEntry('entry-1', incoming);
    expect(count).toBe(0);
    expect(updateEntry).not.toHaveBeenCalled();
  });

  it('appends only the genuinely new songs when the batch mixes existing and new', async () => {
    const existing: Song = {
      title: 'One More Time', artist: 'Daft Punk', album: 'Discovery',
      source: 'audio_fingerprint', spotifyUri: null, spotifyUrl: null,
      youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false,
    };
    vi.mocked(getEntry).mockResolvedValue(makeEntry([existing]));
    const newSong = resolvedToSongsHelper({ title: 'Harder Better Faster Stronger' })[0];
    const count = await appendSongsToEntry('entry-1', [resolvedToSongsHelper()[0], newSong]);
    expect(count).toBe(1);
    expect(updateEntry).toHaveBeenCalledWith('entry-1', {
      'results.songs': [existing, newSong],
    });
  });

  it('dedupes within the incoming batch itself', async () => {
    vi.mocked(getEntry).mockResolvedValue(makeEntry([]));
    const song = resolvedToSongsHelper()[0];
    const count = await appendSongsToEntry('entry-1', [song, { ...song }]);
    expect(count).toBe(1);
  });

  it('tolerates malformed results (missing/non-array songs) and treats it as no existing songs', async () => {
    vi.mocked(getEntry).mockResolvedValue(makeEntry(undefined));
    const incoming = resolvedToSongsHelper();
    const count = await appendSongsToEntry('entry-1', incoming);
    expect(count).toBe(1);
    expect(updateEntry).toHaveBeenCalledWith('entry-1', { 'results.songs': incoming });
  });

  it('re-reads the entry at write time rather than trusting a stale copy', async () => {
    vi.mocked(getEntry).mockResolvedValue(makeEntry([]));
    await appendSongsToEntry('entry-1', resolvedToSongsHelper());
    expect(getEntry).toHaveBeenCalledWith('entry-1');
    expect(getEntry).toHaveBeenCalledTimes(1);
  });

  it('throws when the entry cannot be found (callers are expected to catch/log)', async () => {
    vi.mocked(getEntry).mockResolvedValue(null);
    await expect(appendSongsToEntry('missing', resolvedToSongsHelper())).rejects.toThrow();
    expect(updateEntry).not.toHaveBeenCalled();
  });

  it('propagates db errors from getEntry', async () => {
    vi.mocked(getEntry).mockRejectedValue(new Error('DB down'));
    await expect(appendSongsToEntry('entry-1', resolvedToSongsHelper())).rejects.toThrow('DB down');
  });

  it('propagates db errors from updateEntry', async () => {
    vi.mocked(getEntry).mockResolvedValue(makeEntry([]));
    vi.mocked(updateEntry).mockRejectedValue(new Error('write failed'));
    await expect(appendSongsToEntry('entry-1', resolvedToSongsHelper())).rejects.toThrow('write failed');
  });
});

function resolvedToSongsHelper(overrides: Partial<Song> = {}): Song[] {
  return [{
    title: 'One More Time',
    artist: 'Daft Punk',
    album: null,
    source: 'music_list',
    spotifyUri: 'spotify:track:123',
    spotifyUrl: 'https://open.spotify.com/track/123',
    youtubeUrl: 'https://youtube.com/results?search_query=One+More+Time+Daft+Punk',
    soundcloudUrl: null,
    addedToPlaylist: false,
    ...overrides,
  }];
}
