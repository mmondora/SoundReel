import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./spotify', () => ({
  searchTrack: vi.fn(),
  generateYoutubeSearchUrl: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

// Mock global fetch for Spooty calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { resolveSong, resolveSongs } from './songResolver';
import { searchTrack, generateYoutubeSearchUrl } from './spotify';

const SONG = { title: 'Bohemian Rhapsody', artist: 'Queen' };

describe('resolveSong', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateYoutubeSearchUrl).mockReturnValue('https://youtube.com/results?search_query=Bohemian+Rhapsody+Queen');
  });

  it('resolves with Spotify URL when track found', async () => {
    vi.mocked(searchTrack).mockResolvedValue({
      uri: 'spotify:track:123', url: 'https://open.spotify.com/track/123',
      name: 'Bohemian Rhapsody', artist: 'Queen',
    });
    mockFetch.mockResolvedValue({ ok: true });

    const result = await resolveSong(SONG);
    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/123');
    expect(result.spotifyUri).toBe('spotify:track:123');
    expect(result.youtubeUrl).toBe('https://youtube.com/results?search_query=Bohemian+Rhapsody+Queen');
    expect(result.sentToSpooty).toBe(true);
  });

  it('sets spotifyUrl null when Spotify search returns nothing', async () => {
    vi.mocked(searchTrack).mockResolvedValue(null);

    const result = await resolveSong(SONG);
    expect(result.spotifyUrl).toBeNull();
    expect(result.spotifyUri).toBeNull();
    expect(result.sentToSpooty).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sets sentToSpooty false when Spooty POST fails', async () => {
    vi.mocked(searchTrack).mockResolvedValue({
      uri: 'spotify:track:123', url: 'https://open.spotify.com/track/123',
      name: 'Bohemian Rhapsody', artist: 'Queen',
    });
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'Server Error' });

    const result = await resolveSong(SONG);
    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/123');
    expect(result.sentToSpooty).toBe(false);
  });

  it('sets sentToSpooty false when fetch throws', async () => {
    vi.mocked(searchTrack).mockResolvedValue({
      uri: 'spotify:track:123', url: 'https://open.spotify.com/track/123',
      name: 'Bohemian Rhapsody', artist: 'Queen',
    });
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await resolveSong(SONG);
    expect(result.sentToSpooty).toBe(false);
    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/123');
  });

  it('always populates youtubeUrl regardless of Spotify result', async () => {
    vi.mocked(searchTrack).mockResolvedValue(null);
    vi.mocked(generateYoutubeSearchUrl).mockReturnValue('https://youtube.com/results?search_query=test');

    const result = await resolveSong({ title: 'test', artist: 'artist' });
    expect(result.youtubeUrl).toBe('https://youtube.com/results?search_query=test');
  });

  it('returns failed resolve when searchTrack throws', async () => {
    vi.mocked(searchTrack).mockRejectedValue(new Error('Spotify API error'));

    const result = await resolveSong(SONG);
    expect(result.spotifyUrl).toBeNull();
    expect(result.sentToSpooty).toBe(false);
  });
});

describe('resolveSongs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateYoutubeSearchUrl).mockReturnValue('https://youtube.com/results?search_query=x');
  });

  it('resolves all songs in parallel', async () => {
    vi.mocked(searchTrack).mockResolvedValue(null);
    const songs = [SONG, { title: 'Hotel California', artist: 'Eagles' }];
    const results = await resolveSongs(songs);
    expect(results).toHaveLength(2);
    expect(vi.mocked(searchTrack)).toHaveBeenCalledTimes(2);
  });

  it('returns empty array for empty input', async () => {
    expect(await resolveSongs([])).toEqual([]);
  });
});
