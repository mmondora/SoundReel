import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./streamingAvailability', () => ({
  activeProvider: vi.fn(),
  streamingConfigured: vi.fn(),
  getStreamingPlatforms: vi.fn(),
}));
vi.mock('./filmMeta', () => ({
  upsertStreamingOptions: vi.fn(),
}));

import { refreshStreamingForFilm, extractImdbId, isStale } from './streamingRefresher';
import { activeProvider, streamingConfigured, getStreamingPlatforms } from './streamingAvailability';
import { upsertStreamingOptions } from './filmMeta';

describe('refreshStreamingForFilm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.STREAMING_COUNTRY;
  });
  afterEach(() => {
    delete process.env.STREAMING_COUNTRY;
  });

  it('throws when the provider is not configured, without calling the lookup', async () => {
    vi.mocked(streamingConfigured).mockReturnValue(false);

    await expect(
      refreshStreamingForFilm({ filmKey: 'heat::1995', imdbId: 'tt0113277' })
    ).rejects.toThrow();
    expect(getStreamingPlatforms).not.toHaveBeenCalled();
    expect(upsertStreamingOptions).not.toHaveBeenCalled();
  });

  it('happy path: looks up platforms with default country IT and active provider, then upserts and returns options', async () => {
    vi.mocked(streamingConfigured).mockReturnValue(true);
    vi.mocked(activeProvider).mockReturnValue('watchmode');
    const options = [
      { platform: 'Netflix', type: 'SUBSCRIPTION' as const, is_free: false, price: null, url: 'https://netflix.com/1' },
    ];
    vi.mocked(getStreamingPlatforms).mockResolvedValue({ options, watchmodeTitleId: 42 });

    const result = await refreshStreamingForFilm({ filmKey: 'heat::1995', imdbId: 'tt0113277', cachedTitleId: 42 });

    expect(getStreamingPlatforms).toHaveBeenCalledWith('tt0113277', 'IT', 'watchmode', 42);
    expect(upsertStreamingOptions).toHaveBeenCalledWith({
      filmKey: 'heat::1995',
      options,
      watchmodeTitleId: 42,
    });
    expect(result).toEqual(options);
  });

  it('reads STREAMING_COUNTRY from env when set', async () => {
    process.env.STREAMING_COUNTRY = 'US';
    vi.mocked(streamingConfigured).mockReturnValue(true);
    vi.mocked(activeProvider).mockReturnValue('watchmode');
    vi.mocked(getStreamingPlatforms).mockResolvedValue({ options: [], watchmodeTitleId: null });

    await refreshStreamingForFilm({ filmKey: 'heat::1995', imdbId: 'tt0113277' });

    expect(getStreamingPlatforms).toHaveBeenCalledWith('tt0113277', 'US', 'watchmode', null);
  });

  it('propagates lookup errors without upserting', async () => {
    vi.mocked(streamingConfigured).mockReturnValue(true);
    vi.mocked(activeProvider).mockReturnValue('watchmode');
    vi.mocked(getStreamingPlatforms).mockRejectedValue(new Error('watchmode 500: boom'));

    await expect(
      refreshStreamingForFilm({ filmKey: 'heat::1995', imdbId: 'tt0113277' })
    ).rejects.toThrow('watchmode 500: boom');
    expect(upsertStreamingOptions).not.toHaveBeenCalled();
  });
});

describe('extractImdbId', () => {
  it('extracts the tt id from a full IMDb URL', () => {
    expect(extractImdbId('https://www.imdb.com/title/tt0405296/')).toBe('tt0405296');
  });

  it('returns null for null input', () => {
    expect(extractImdbId(null)).toBeNull();
  });

  it('returns null for a URL without a tt id', () => {
    expect(extractImdbId('https://www.imdb.com/title/nope/')).toBeNull();
    expect(extractImdbId('garbage')).toBeNull();
  });
});

describe('isStale', () => {
  it('is stale when never checked (null)', () => {
    expect(isStale(null, 30)).toBe(true);
  });

  it('is not stale when checked recently', () => {
    expect(isStale(new Date().toISOString(), 30)).toBe(false);
  });

  it('is stale when checked longer ago than the TTL', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(old, 30)).toBe(true);
  });
});
