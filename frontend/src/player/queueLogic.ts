export type RepeatMode = 'off' | 'one' | 'all';

/**
 * Index of the next track after `current` finishes or the user hits next.
 * `repeat: 'one'` stays on the same index. At the end of the queue,
 * `repeat: 'all'` wraps to 0; `off` returns null (stop).
 */
export function nextIndex(
  current: number,
  length: number,
  repeat: RepeatMode,
): number | null {
  if (length <= 0) return null;
  if (repeat === 'one') return clampIndex(current, length);
  const next = current + 1;
  if (next < length) return next;
  if (repeat === 'all') return 0;
  return null;
}

/** Previous track; with `repeat: 'all'` wraps from 0 to the last item. */
export function prevIndex(
  current: number,
  length: number,
  repeat: RepeatMode,
): number | null {
  if (length <= 0) return null;
  if (repeat === 'one') return clampIndex(current, length);
  const prev = current - 1;
  if (prev >= 0) return prev;
  if (repeat === 'all') return length - 1;
  return null;
}

function clampIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

/**
 * Find the start index for `songKey` in `list` (0 if missing).
 * The queue is the list itself — automatic, no manual enqueue.
 */
export function queueFromList<T extends { songKey: string }>(
  list: T[],
  songKey: string,
): { queue: T[]; index: number } {
  const index = list.findIndex((s) => s.songKey === songKey);
  return { queue: list, index: index >= 0 ? index : 0 };
}

/**
 * Rebuild a sticky playback queue from persisted song keys, keeping order.
 * Songs missing from the catalog are dropped. Returns null if nothing left.
 */
export function rebuildQueueFromKeys<T extends { songKey: string }>(
  catalog: T[],
  songKeys: string[],
  currentKey: string | null,
): { queue: T[]; index: number } | null {
  if (songKeys.length === 0) return null;
  const byKey = new Map(catalog.map((s) => [s.songKey, s]));
  const queue = songKeys.map((k) => byKey.get(k)).filter((s): s is T => !!s);
  if (queue.length === 0) return null;
  const index = currentKey
    ? Math.max(0, queue.findIndex((s) => s.songKey === currentKey))
    : 0;
  return { queue, index: index >= 0 ? index : 0 };
}

/**
 * Fisher–Yates shuffle that keeps `currentIndex` item at position 0 so
 * playback does not jump when the user enables shuffle mid-track.
 */
export function shuffleKeepingCurrent<T>(
  queue: T[],
  currentIndex: number,
  random: () => number = Math.random,
): { queue: T[]; index: number } {
  if (queue.length === 0) return { queue: [], index: 0 };
  const safeIndex = clampIndex(currentIndex, queue.length);
  const current = queue[safeIndex];
  const rest = queue.filter((_, i) => i !== safeIndex);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = rest[i];
    rest[i] = rest[j];
    rest[j] = tmp;
  }
  return { queue: [current, ...rest], index: 0 };
}

export function cycleRepeat(mode: RepeatMode): RepeatMode {
  if (mode === 'off') return 'all';
  if (mode === 'all') return 'one';
  return 'off';
}

/** Liked = explicit like rating, or score in the outer like zone (≥ 80). */
export function isLikedSong(meta: { rating?: string | null; score?: number | null } | null | undefined): boolean {
  if (!meta) return false;
  if (meta.rating === 'like') return true;
  return meta.score != null && meta.score >= 80;
}

/** @deprecated Player streams YouTube online; kept for tests / legacy callers. */
export function isPlayableFull(song: { inLibrary?: boolean; meta?: { downloaded?: boolean } | null }): boolean {
  return song.inLibrary === true || song.meta?.downloaded === true;
}
