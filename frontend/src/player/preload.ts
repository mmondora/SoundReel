/**
 * Getting the YouTube side ready BEFORE the first play (spec 2026-11-08-player-selection-and-filters-design.md §2,
 * X6): the IFrame API is a script from youtube.com and the player an iframe that needs connections to youtube.com and
 * i.ytimg.com, which used to start only at the first press of play. Done once, when the player page is idle:
 *
 *   - `preconnect` to the two origins (the connection is open when it is needed),
 *   - the IFrame API script itself (loaded, not started: no player exists until a song needs it).
 *
 * A song that plays from the home file (media server or disk) never waits for any of it.
 */
import { loadYoutubeApi } from './youtubeApi';

export const YOUTUBE_ORIGINS = ['https://www.youtube.com', 'https://i.ytimg.com'] as const;

/** Runs `fn` when the browser has nothing better to do; where there is no idle callback, after `fallbackMs`. */
export function whenIdle(fn: () => void, fallbackMs = 1500): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => fn(), { timeout: 4000 });
    return () => window.cancelIdleCallback?.(id);
  }
  const timer = window.setTimeout(fn, fallbackMs);
  return () => window.clearTimeout(timer);
}

/** `<link rel="preconnect">` for each origin, once per origin. */
export function addPreconnect(origins: readonly string[] = YOUTUBE_ORIGINS): void {
  for (const origin of origins) {
    if (document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    link.dataset.srPreconnect = '1';
    document.head.appendChild(link);
  }
}

let warmedUp = false;

/** Preconnect + the IFrame API script. Never twice; a failed warm-up is not an error (the real play tries again). */
export function warmUpYoutube(): Promise<void> {
  if (warmedUp) return Promise.resolve();
  warmedUp = true;
  addPreconnect();
  return loadYoutubeApi().catch(() => undefined);
}

/** Warm up when idle. Calling it again (a second mount of the page) does nothing more. Returns a cancel. */
export function scheduleYoutubeWarmUp(): () => void {
  if (warmedUp) return () => undefined;
  return whenIdle(() => { void warmUpYoutube(); });
}

/** For tests: forget that the warm-up happened. */
export function resetWarmUpForTests(): void {
  warmedUp = false;
}
