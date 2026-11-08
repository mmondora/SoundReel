import type { AggregatedSong } from '../types';

export interface MediaSessionHandlers {
  play: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seek?: (seconds: number) => void;
}

/** Updates Media Session metadata for lock-screen / BT controls (no-op when unsupported). */
export function setMediaSessionMetadata(song: AggregatedSong | null): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  if (!song) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const artwork = song.meta?.coverUrl
    ? [{ src: song.meta.coverUrl, sizes: '300x300', type: 'image/jpeg' }]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist || 'Unknown',
    album: song.album ?? song.meta?.album ?? 'SoundReel',
    artwork,
  });
}

export function setMediaSessionPlaybackState(playing: boolean): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

/** Wires action handlers; safe to call repeatedly (replaces previous handlers). */
export function bindMediaSessionHandlers(handlers: MediaSessionHandlers): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    ms.setActionHandler('play', () => handlers.play());
    ms.setActionHandler('pause', () => handlers.pause());
    ms.setActionHandler('previoustrack', () => handlers.previous());
    ms.setActionHandler('nexttrack', () => handlers.next());
    if (handlers.seek) {
      ms.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') handlers.seek!(details.seekTime);
      });
    }
  } catch {
    // Some browsers throw on unsupported action names — ignore.
  }
}
