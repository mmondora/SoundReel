import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import {
  activeProvider,
  streamingConfigured,
  getStreamingPlatforms,
} from './streamingAvailability';

const ENV_KEYS = [
  'WATCHMODE_API_KEY',
  'MOVIE_OF_THE_NIGHT_API_KEY',
  'STREAMING_AVAILABILITY_PROVIDER',
  'STREAMING_COUNTRY',
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('activeProvider', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('defaults to watchmode', () => {
    expect(activeProvider()).toBe('watchmode');
  });

  it('reads STREAMING_AVAILABILITY_PROVIDER', () => {
    process.env.STREAMING_AVAILABILITY_PROVIDER = 'movie_of_the_night';
    expect(activeProvider()).toBe('movie_of_the_night');
  });
});

describe('streamingConfigured', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('false when active provider has no key configured', () => {
    expect(streamingConfigured()).toBe(false);
  });

  it('true when watchmode key is present and watchmode is active', () => {
    process.env.WATCHMODE_API_KEY = 'wm-key';
    expect(streamingConfigured()).toBe(true);
  });

  it('true when motn key is present and motn is active', () => {
    process.env.STREAMING_AVAILABILITY_PROVIDER = 'movie_of_the_night';
    process.env.MOVIE_OF_THE_NIGHT_API_KEY = 'motn-key';
    expect(streamingConfigured()).toBe(true);
  });

  it('false when watchmode key present but motn is active', () => {
    process.env.STREAMING_AVAILABILITY_PROVIDER = 'movie_of_the_night';
    process.env.WATCHMODE_API_KEY = 'wm-key';
    expect(streamingConfigured()).toBe(false);
  });
});

describe('getStreamingPlatforms — watchmode', () => {
  beforeEach(() => {
    clearEnv();
    process.env.WATCHMODE_API_KEY = 'wm-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearEnv();
  });

  const SEARCH_RESPONSE = {
    title_results: [{ id: 555, imdb_id: 'tt9999999' }, { id: 42, imdb_id: 'tt0113277' }],
  };

  const SOURCES_RESPONSE = [
    { source_id: 1, name: 'Netflix', type: 'sub', region: 'IT', web_url: 'https://netflix.com/watch/1', price: null },
    { source_id: 2, name: 'Apple TV', type: 'rent', region: 'IT', web_url: 'https://tv.apple.com/2', price: 3.99 },
    { source_id: 3, name: 'Apple TV', type: 'rent', region: 'IT', web_url: 'https://tv.apple.com/2b', price: 2.99 },
    { source_id: 4, name: 'Chili', type: 'buy', region: 'IT', web_url: 'https://chili.com/4', price: 9.99 },
    { source_id: 5, name: 'RaiPlay', type: 'free', region: 'IT', web_url: 'https://raiplay.it/5', price: null },
    { source_id: 6, name: 'Sky Go', type: 'tv_everywhere', region: 'IT', web_url: 'https://sky.it/6', price: null },
    { source_id: 7, name: 'Netflix', type: 'sub', region: 'US', web_url: 'https://netflix.com/watch/us', price: null },
  ];

  it('two-step happy path: search then sources, maps + dedupes + ignores tv_everywhere', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => SEARCH_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => SOURCES_RESPONSE });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getStreamingPlatforms('tt0113277', 'IT', 'watchmode');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('search_value=tt0113277');
    expect(fetchMock.mock.calls[1][0]).toContain('/title/42/sources/');
    expect(fetchMock.mock.calls[1][0]).toContain('regions=IT');

    expect(result.watchmodeTitleId).toBe(42);
    expect(result.options).toEqual(
      expect.arrayContaining([
        { platform: 'Netflix', type: 'SUBSCRIPTION', is_free: false, price: null, url: 'https://netflix.com/watch/1' },
        { platform: 'Apple TV', type: 'RENTAL', is_free: false, price: 2.99, url: 'https://tv.apple.com/2b' },
        { platform: 'Chili', type: 'PURCHASE', is_free: false, price: 9.99, url: 'https://chili.com/4' },
        { platform: 'RaiPlay', type: 'FREE', is_free: true, price: null, url: 'https://raiplay.it/5' },
      ])
    );
    // tv_everywhere ignored, US region excluded, duplicate Apple TV rent deduped to lowest price
    expect(result.options).toHaveLength(4);
  });

  it('skips the search step when cachedWatchmodeTitleId is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => SOURCES_RESPONSE });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getStreamingPlatforms('tt0113277', 'IT', 'watchmode', 42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/title/42/sources/');
    expect(result.watchmodeTitleId).toBe(42);
    expect(result.options.length).toBeGreaterThan(0);
  });

  it('returns empty result when imdb_id is not found in search results', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ title_results: [{ id: 1, imdb_id: 'tt0000001' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getStreamingPlatforms('tt0113277', 'IT', 'watchmode');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ options: [], watchmodeTitleId: null });
  });

  it('throws with provider, status and body snippet when sources call fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => SEARCH_RESPONSE })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'internal server error blah blah' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStreamingPlatforms('tt0113277', 'IT', 'watchmode')).rejects.toThrow(/watchmode.*500/i);
  });

  it('throws with provider, status and body snippet when search call fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'quota exceeded' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStreamingPlatforms('tt0113277', 'IT', 'watchmode')).rejects.toThrow(/watchmode.*429/i);
  });
});

describe('getStreamingPlatforms — movie_of_the_night', () => {
  beforeEach(() => {
    clearEnv();
    process.env.MOVIE_OF_THE_NIGHT_API_KEY = 'motn-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearEnv();
  });

  const MOTN_RESPONSE = {
    streamingOptions: {
      it: [
        { service: { name: 'Netflix' }, type: 'subscription', link: 'https://netflix.com/it/1' },
        { service: { name: 'Rai Play' }, type: 'free', link: 'https://raiplay.it/1' },
        { service: { name: 'Pluto TV' }, type: 'ads', link: 'https://pluto.tv/1' },
        { service: { name: 'Sky' }, type: 'addon', link: 'https://sky.it/1' },
        { service: { name: 'Apple TV' }, type: 'rent', link: 'https://tv.apple.com/1', price: { amount: 3.99 } },
        { service: { name: 'Chili' }, type: 'buy', link: 'https://chili.com/1', price: { amount: 9.99 } },
        { service: { name: 'Weird' }, type: 'mystery_type', link: 'https://weird.com/1' },
      ],
      us: [{ service: { name: 'Netflix' }, type: 'subscription', link: 'https://netflix.com/us/1' }],
    },
  };

  it('maps types incl. ads→FREE and addon→SUBSCRIPTION, ignores unknown types, uses country key', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => MOTN_RESPONSE });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getStreamingPlatforms('tt0113277', 'IT', 'movie_of_the_night');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/shows/tt0113277');
    expect(init.headers['x-rapidapi-key']).toBe('motn-key');
    expect(init.headers['x-rapidapi-host']).toBe('streaming-availability.p.rapidapi.com');

    expect(result.watchmodeTitleId).toBeNull();
    expect(result.options).toEqual(
      expect.arrayContaining([
        { platform: 'Netflix', type: 'SUBSCRIPTION', is_free: false, price: null, url: 'https://netflix.com/it/1' },
        { platform: 'Rai Play', type: 'FREE', is_free: true, price: null, url: 'https://raiplay.it/1' },
        { platform: 'Pluto TV', type: 'FREE', is_free: true, price: null, url: 'https://pluto.tv/1' },
        { platform: 'Sky', type: 'SUBSCRIPTION', is_free: false, price: null, url: 'https://sky.it/1' },
        { platform: 'Apple TV', type: 'RENTAL', is_free: false, price: 3.99, url: 'https://tv.apple.com/1' },
        { platform: 'Chili', type: 'PURCHASE', is_free: false, price: 9.99, url: 'https://chili.com/1' },
      ])
    );
    // mystery_type ignored, only 'it' country used
    expect(result.options).toHaveLength(6);
  });

  it('returns empty result on 404 (not found)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getStreamingPlatforms('tt0113277', 'IT', 'movie_of_the_night');

    expect(result).toEqual({ options: [], watchmodeTitleId: null });
  });

  it('throws with provider, status and body snippet on other HTTP failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server exploded' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getStreamingPlatforms('tt0113277', 'IT', 'movie_of_the_night')).rejects.toThrow(/movie_of_the_night.*500/i);
  });

  it('returns empty options when country code has no entries', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ streamingOptions: { us: [{ service: { name: 'Netflix' }, type: 'subscription', link: 'x' }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getStreamingPlatforms('tt0113277', 'IT', 'movie_of_the_night');
    expect(result).toEqual({ options: [], watchmodeTitleId: null });
  });
});
