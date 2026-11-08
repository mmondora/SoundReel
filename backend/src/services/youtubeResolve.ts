import { resolveYoutubeUrl } from './shazamClient';
import { extractYoutubeVideoId, youtubeWatchUrl } from './youtubeVideoId';
import { logInfo, logWarning } from '../utils/logger';

export interface YoutubePlaySource {
  videoId: string;
  watchUrl: string;
  /** How the id was obtained. */
  source: 'stored_url' | 'yt_search';
}

interface CacheEntry {
  value: YoutubePlaySource;
  at: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export function _resetYoutubeResolveCacheForTest(): void {
  cache.clear();
}

/**
 * Resolve a playable YouTube video for a song.
 * Prefer an id already present on `youtubeUrl`; otherwise yt-dlp search via
 * the instaloader sidecar (`/yt/url`). Results are cached 24h in-process.
 */
export async function resolveYoutubePlaySource(opts: {
  songKey: string;
  artist: string;
  title: string;
  youtubeUrl: string | null;
}): Promise<YoutubePlaySource | null> {
  const cached = cache.get(opts.songKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const fromStored = extractYoutubeVideoId(opts.youtubeUrl);
  if (fromStored) {
    const value: YoutubePlaySource = {
      videoId: fromStored,
      watchUrl: youtubeWatchUrl(fromStored),
      source: 'stored_url',
    };
    cache.set(opts.songKey, { value, at: Date.now() });
    return value;
  }

  const query = `${opts.artist} ${opts.title}`.trim();
  if (!query) return null;

  const resolved = await resolveYoutubeUrl(opts.artist, opts.title);
  const videoId = extractYoutubeVideoId(resolved);
  if (!videoId) {
    logWarning('youtube resolve miss', { songKey: opts.songKey, query });
    return null;
  }

  const value: YoutubePlaySource = {
    videoId,
    watchUrl: youtubeWatchUrl(videoId),
    source: 'yt_search',
  };
  cache.set(opts.songKey, { value, at: Date.now() });
  logInfo('youtube resolve ok', { songKey: opts.songKey, videoId, source: 'yt_search' });
  return value;
}
