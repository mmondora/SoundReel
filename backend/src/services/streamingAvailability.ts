import { logWarning } from '../utils/logger';
import type { StreamingOptionType, StreamingPlatformOption } from '../types';

export type StreamingProvider = 'watchmode' | 'movie_of_the_night';

export interface StreamingLookupResult {
  options: StreamingPlatformOption[];
  watchmodeTitleId: number | null;
}

const EMPTY_RESULT: StreamingLookupResult = { options: [], watchmodeTitleId: null };

/** Active provider, read from env at call time (default watchmode). */
export function activeProvider(): StreamingProvider {
  return process.env.STREAMING_AVAILABILITY_PROVIDER === 'movie_of_the_night'
    ? 'movie_of_the_night'
    : 'watchmode';
}

/** True when the active provider has its API key configured. */
export function streamingConfigured(): boolean {
  const provider = activeProvider();
  if (provider === 'watchmode') return !!process.env.WATCHMODE_API_KEY;
  return !!process.env.MOVIE_OF_THE_NIGHT_API_KEY;
}

async function bodySnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

function throwProviderError(provider: string, response: Response, snippet: string): never {
  throw new Error(`${provider} ${response.status}: ${snippet}`);
}

// --- Watchmode -------------------------------------------------------------

interface WatchmodeSearchResult {
  title_results?: Array<{ id: number; imdb_id: string | null }>;
}

interface WatchmodeSource {
  name: string;
  type: string;
  region: string;
  web_url: string;
  price: number | null;
}

// Watchmode source `type` values we act on. Other types (e.g. `tv_everywhere`,
// which is a cable-login gateway, not directly actionable) are ignored.
const WATCHMODE_TYPE_MAP: Record<string, StreamingOptionType> = {
  free: 'FREE',
  sub: 'SUBSCRIPTION',
  rent: 'RENTAL',
  buy: 'PURCHASE',
};

async function resolveWatchmodeTitleId(
  imdbId: string,
  apiKey: string
): Promise<number | null> {
  const url = `https://api.watchmode.com/v1/search/?apiKey=${apiKey}&search_field=imdb_id&search_value=${encodeURIComponent(imdbId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throwProviderError('watchmode', response, await bodySnippet(response));
  }
  const data = (await response.json()) as WatchmodeSearchResult;
  const match = (data.title_results ?? []).find((r) => r.imdb_id === imdbId);
  return match ? match.id : null;
}

async function fetchWatchmodeSources(
  titleId: number,
  countryCode: string,
  apiKey: string
): Promise<StreamingPlatformOption[]> {
  const url = `https://api.watchmode.com/v1/title/${titleId}/sources/?apiKey=${apiKey}&regions=${encodeURIComponent(countryCode)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throwProviderError('watchmode', response, await bodySnippet(response));
  }
  const sources = (await response.json()) as WatchmodeSource[];

  const byKey = new Map<string, StreamingPlatformOption>();
  for (const source of sources) {
    if (source.region !== countryCode) continue;
    const type = WATCHMODE_TYPE_MAP[source.type];
    if (!type) continue; // ignored type (e.g. tv_everywhere)

    const price = type === 'RENTAL' || type === 'PURCHASE' ? source.price ?? null : null;
    const option: StreamingPlatformOption = {
      platform: source.name,
      type,
      is_free: type === 'FREE',
      price,
      url: source.web_url,
    };

    const key = `${option.platform}::${option.type}`;
    const existing = byKey.get(key);
    if (!existing || (option.price !== null && (existing.price === null || option.price < existing.price))) {
      byKey.set(key, option);
    }
  }
  return Array.from(byKey.values());
}

async function getWatchmodePlatforms(
  imdbId: string,
  countryCode: string,
  cachedWatchmodeTitleId?: number | null
): Promise<StreamingLookupResult> {
  const apiKey = process.env.WATCHMODE_API_KEY;
  if (!apiKey) {
    logWarning('WATCHMODE_API_KEY non configurata');
    return EMPTY_RESULT;
  }

  let titleId = cachedWatchmodeTitleId ?? null;
  if (!titleId) {
    titleId = await resolveWatchmodeTitleId(imdbId, apiKey);
    if (titleId === null) {
      return EMPTY_RESULT;
    }
  }

  const options = await fetchWatchmodeSources(titleId, countryCode, apiKey);
  return { options, watchmodeTitleId: titleId };
}

// --- Movie of the Night (RapidAPI) -----------------------------------------

interface MotnOption {
  service: { name: string };
  type: string;
  link: string;
  price?: { amount: number };
}

interface MotnResponse {
  streamingOptions?: Record<string, MotnOption[]>;
}

// MotN option `type` values we act on. `addon` is mapped to SUBSCRIPTION
// (documented choice: included in an add-on plan the user may have);
// anything else is ignored.
const MOTN_TYPE_MAP: Record<string, StreamingOptionType> = {
  free: 'FREE',
  ads: 'FREE',
  subscription: 'SUBSCRIPTION',
  addon: 'SUBSCRIPTION',
  rent: 'RENTAL',
  buy: 'PURCHASE',
};

async function getMotnPlatforms(imdbId: string, countryCode: string): Promise<StreamingLookupResult> {
  const apiKey = process.env.MOVIE_OF_THE_NIGHT_API_KEY;
  if (!apiKey) {
    logWarning('MOVIE_OF_THE_NIGHT_API_KEY non configurata');
    return EMPTY_RESULT;
  }

  const response = await fetch(`https://streaming-availability.p.rapidapi.com/shows/${encodeURIComponent(imdbId)}`, {
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': 'streaming-availability.p.rapidapi.com',
    },
  });

  if (!response.ok) {
    if (response.status === 404) return EMPTY_RESULT;
    throwProviderError('movie_of_the_night', response, await bodySnippet(response));
  }

  const data = (await response.json()) as MotnResponse;
  const countryOptions = data.streamingOptions?.[countryCode.toLowerCase()] ?? [];

  const options: StreamingPlatformOption[] = [];
  for (const opt of countryOptions) {
    const type = MOTN_TYPE_MAP[opt.type];
    if (!type) continue; // ignored type

    const price = type === 'RENTAL' || type === 'PURCHASE' ? opt.price?.amount ?? null : null;
    options.push({
      platform: opt.service.name,
      type,
      is_free: type === 'FREE',
      price,
      url: opt.link,
    });
  }

  return { options, watchmodeTitleId: null };
}

// --- Public API --------------------------------------------------------

export async function getStreamingPlatforms(
  imdbId: string,
  countryCode: string,
  provider: StreamingProvider,
  cachedWatchmodeTitleId?: number | null
): Promise<StreamingLookupResult> {
  if (provider === 'watchmode') {
    return getWatchmodePlatforms(imdbId, countryCode, cachedWatchmodeTitleId);
  }
  return getMotnPlatforms(imdbId, countryCode);
}
