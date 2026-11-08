/**
 * List window of the web player (D11, docs/mondrop-stats.md §7). A queue of MORE than 20 songs shows at most 20:
 * the first shown is always the song in play, the next ones follow, and the songs already played drop out of the
 * top as playback advances. With 20 or fewer the list stays complete.
 *
 * This is presentation only: previous / next / shuffle / repeat keep working on the FULL queue. "Already played"
 * means everything before the current index in the queue order (that is also what shuffle produces).
 */
export const QUEUE_WINDOW_LIMIT = 20;

export interface QueueWindow {
  /** Queue indices to show, in display order; the first is the current song when the list is windowed. */
  indices: number[];
  total: number;
  shown: number;
  /** True when the queue is longer than the limit and therefore cut. */
  windowed: boolean;
  /** Already played (before the current index) and not shown: "14 già ascoltate nascoste". */
  hiddenPlayed: number;
  /** Still to come and not shown yet (beyond the 20). */
  hiddenAhead: number;
}

export interface QueueWindowOptions {
  limit?: number;
  /**
   * Repeat is on: after the last song playback continues from the first one, so a window that runs out of
   * songs at the end of the queue is completed with the songs from its start (they are coming up again).
   */
  wrap?: boolean;
}

export function computeQueueWindow(total: number, currentIndex: number, opts: QueueWindowOptions = {}): QueueWindow {
  const limit = Math.max(1, opts.limit ?? QUEUE_WINDOW_LIMIT);
  const size = Math.max(0, Math.floor(total));

  if (size <= limit) {
    return {
      indices: Array.from({ length: size }, (_, i) => i),
      total: size,
      shown: size,
      windowed: false,
      hiddenPlayed: 0,
      hiddenAhead: 0,
    };
  }

  const current = Number.isFinite(currentIndex) ? Math.min(Math.max(Math.floor(currentIndex), 0), size - 1) : 0;
  const indices: number[] = [];
  for (let i = current; i < size && indices.length < limit; i += 1) indices.push(i);

  let wrapped = 0;
  if (opts.wrap) {
    for (let i = 0; i < current && indices.length < limit; i += 1) {
      indices.push(i);
      wrapped += 1;
    }
  }

  const hiddenPlayed = current - wrapped;
  return {
    indices,
    total: size,
    shown: indices.length,
    windowed: true,
    hiddenPlayed,
    hiddenAhead: size - indices.length - hiddenPlayed,
  };
}

/** The songs of the window, in display order. */
export function windowItems<T>(queue: readonly T[], win: QueueWindow): T[] {
  return win.indices.map((i) => queue[i]);
}
