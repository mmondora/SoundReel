import { activeProvider, streamingConfigured, getStreamingPlatforms } from './streamingAvailability';
import { upsertStreamingOptions } from './filmMeta';
import type { StreamingPlatformOption } from '../types';

export interface RefreshInput {
  filmKey: string;
  imdbId: string;
  cachedTitleId?: number | null;
}

/**
 * Single choke point for refreshing a film's streaming availability: looks up
 * the active provider, persists the result, and returns the options. Used by
 * the analyze.ts pipeline hook, the on-demand refresh route and the backfill
 * script.
 *
 * Throws when the active provider is not configured, or when the provider
 * lookup itself fails — the caller decides how to log/handle that.
 */
export async function refreshStreamingForFilm(input: RefreshInput): Promise<StreamingPlatformOption[]> {
  if (!streamingConfigured()) {
    throw new Error('streaming availability provider not configured');
  }

  const country = process.env.STREAMING_COUNTRY || 'IT';
  const { options, watchmodeTitleId } = await getStreamingPlatforms(
    input.imdbId,
    country,
    activeProvider(),
    input.cachedTitleId ?? null
  );

  await upsertStreamingOptions({
    filmKey: input.filmKey,
    options,
    watchmodeTitleId,
  });

  return options;
}

const IMDB_ID_PATTERN = /tt\d+/;

/** Extracts the `ttNNNNNNN` IMDb id from an IMDb URL, or null if not found. */
export function extractImdbId(imdbUrl: string | null): string | null {
  if (!imdbUrl) return null;
  const match = imdbUrl.match(IMDB_ID_PATTERN);
  return match ? match[0] : null;
}

/** True when `checkedAt` is null (never checked) or older than `ttlDays`. */
export function isStale(checkedAt: string | null, ttlDays: number): boolean {
  if (!checkedAt) return true;
  const checkedTime = new Date(checkedAt).getTime();
  if (Number.isNaN(checkedTime)) return true;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  return Date.now() - checkedTime > ttlMs;
}
