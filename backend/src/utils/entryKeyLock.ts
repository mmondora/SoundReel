/**
 * One thing at a time per post: "look the entry up, then create it" must not interleave for the same (owner, post),
 * or two shares at the same instant (Telegram and Mondrop, two taps) make two entries
 * (spec 2026-11-08-no-duplicates-and-post-links, D2; ADR-0017). The backend is a single process, so a lock in memory is
 * enough; a second caller for the same key simply waits for the first to finish and then finds its entry.
 */
import { postKey } from '../services/urlNormalize';

const tails = new Map<string, Promise<void>>();

export function withEntryKeyLock<T>(owner: string | null | undefined, url: string, fn: () => Promise<T>): Promise<T> {
  const key = `${String(owner ?? '').trim().toLowerCase()}|${postKey(url)}`;
  const previous = tails.get(key);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail: Promise<void> = previous ? previous.then(() => mine) : mine;
  tails.set(key, tail);
  const run = async (): Promise<T> => {
    try {
      return await fn();
    } finally {
      release();
      // nobody queued behind us: forget the key, so the map never grows
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
  // Nobody holds the key (the usual case): start at once, in the same tick, as if there were no lock.
  return previous ? previous.then(run) : run();
}

/** Tests only. */
export const pendingLocks = (): number => tails.size;
