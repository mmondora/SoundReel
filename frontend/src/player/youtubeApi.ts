/** Minimal YouTube IFrame API typings used by the player. */
export interface YtPlayer {
  loadVideoById: (videoId: string, startSeconds?: number) => void;
  cueVideoById: (videoId: string, startSeconds?: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  destroy: () => void;
}

export interface YtPlayerOptions {
  videoId?: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number | boolean>;
  events?: {
    onReady?: (e: { target: YtPlayer }) => void;
    onStateChange?: (e: { data: number; target: YtPlayer }) => void;
    onError?: (e: { data: number; target: YtPlayer }) => void;
  };
}

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, opts: YtPlayerOptions) => YtPlayer;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
        UNSTARTED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

/** Load the YouTube IFrame API script once. */
export function loadYoutubeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prior?.();
      resolve();
    };
    const existing = document.querySelector('script[data-sr-yt]');
    if (existing) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.dataset.srYt = '1';
    // A failed load is forgotten (promise and script tag), so the next attempt — the first real play after a
    // warm-up that failed at page load — tries again instead of inheriting the failure.
    const fail = (message: string) => {
      apiPromise = null;
      tag.remove();
      reject(new Error(message));
    };
    tag.onerror = () => fail('YouTube API load failed');
    document.head.appendChild(tag);
    // In case the API was already loaded by something else after we checked.
    const started = Date.now();
    const poll = window.setInterval(() => {
      if (window.YT?.Player) {
        window.clearInterval(poll);
        resolve();
      } else if (Date.now() - started > 15000) {
        window.clearInterval(poll);
        fail('YouTube API timeout');
      }
    }, 50);
  });

  return apiPromise;
}

export const YT_ENDED = 0;
export const YT_PLAYING = 1;
export const YT_PAUSED = 2;
export const YT_BUFFERING = 3;
export const YT_CUED = 5;
