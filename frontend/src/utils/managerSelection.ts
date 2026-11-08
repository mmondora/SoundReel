/**
 * Cursor and marks of one manager pane. Marks always refer to the VISIBLE rows (they are pruned
 * whenever the visible list changes), so an operation never touches a song the user cannot see.
 */
import type { ManagerSong } from './managerSongs';

export type CursorMove = 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown';

const PAGE = 10;

/** New cursor key after a keyboard move. `null` when the list is empty. */
export function moveCursor(visibleKeys: readonly string[], cursor: string | null, move: CursorMove): string | null {
  if (visibleKeys.length === 0) return null;
  const at = cursor === null ? -1 : visibleKeys.indexOf(cursor);
  const last = visibleKeys.length - 1;
  let next: number;
  switch (move) {
    case 'home': next = 0; break;
    case 'end': next = last; break;
    case 'up': next = at <= 0 ? 0 : at - 1; break;
    case 'down': next = at < 0 ? 0 : Math.min(last, at + 1); break;
    case 'pageUp': next = Math.max(0, (at < 0 ? 0 : at) - PAGE); break;
    case 'pageDown': next = Math.min(last, (at < 0 ? 0 : at) + PAGE); break;
  }
  return visibleKeys[next];
}

/** The cursor key to keep after the visible list changed (same song if still there, else the nearest slot). */
export function reconcileCursor(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  cursor: string | null,
): string | null {
  if (nextKeys.length === 0) return null;
  if (cursor !== null && nextKeys.includes(cursor)) return cursor;
  if (cursor === null) return nextKeys[0];
  const wasAt = previousKeys.indexOf(cursor);
  const slot = wasAt < 0 ? 0 : Math.min(wasAt, nextKeys.length - 1);
  return nextKeys[slot];
}

export function toggleMark(marked: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(marked);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function markMany(marked: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  return new Set([...marked, ...keys]);
}

export function unmarkMany(marked: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const drop = new Set(keys);
  return new Set([...marked].filter((k) => !drop.has(k)));
}

/** Ctrl+A. */
export function markAllVisible(visibleKeys: readonly string[]): Set<string> {
  return new Set(visibleKeys);
}

/** `*`: marked ↔ unmarked among the visible rows. */
export function invertMarks(marked: ReadonlySet<string>, visibleKeys: readonly string[]): Set<string> {
  return new Set(visibleKeys.filter((k) => !marked.has(k)));
}

/** Drops marks of rows that are no longer visible. */
export function pruneMarks(marked: ReadonlySet<string>, visibleKeys: readonly string[]): Set<string> {
  const visible = new Set(visibleKeys);
  const next = new Set([...marked].filter((k) => visible.has(k)));
  return next.size === marked.size ? (marked as Set<string>) : next;
}

/** Keys between two rows, inclusive, in list order (shift+click). */
export function rangeKeys(visibleKeys: readonly string[], from: string | null, to: string): string[] {
  const b = visibleKeys.indexOf(to);
  if (b < 0) return [];
  const a = from === null ? b : visibleKeys.indexOf(from);
  if (a < 0) return [to];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return visibleKeys.slice(lo, hi + 1);
}

/** Wildcard mask (`*` any run, `?` one char) → anchored, case-insensitive RegExp. */
function maskToRegExp(mask: string): RegExp {
  const body = mask
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Norton-Commander "gray +": without wildcards the text is a case-insensitive substring of title, artist,
 * album or "artist - title"; with `*` / `?` the mask must match one of those fields as a whole.
 */
export function matchesPattern(song: Pick<ManagerSong, 'title' | 'artist' | 'album'>, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const fields = [song.title, song.artist, song.album ?? '', `${song.artist} - ${song.title}`];
  if (!/[*?]/.test(p)) {
    const needle = p.toLowerCase();
    return fields.some((f) => f.toLowerCase().includes(needle));
  }
  const re = maskToRegExp(p);
  return fields.some((f) => re.test(f));
}

export function keysMatching(songs: readonly ManagerSong[], pattern: string): string[] {
  return songs.filter((s) => matchesPattern(s, pattern)).map((s) => s.songKey);
}

/** What an operation acts on: the marked visible rows in list order, else the row under the cursor. */
export function operationTargets(
  marked: ReadonlySet<string>,
  visibleKeys: readonly string[],
  cursor: string | null,
): string[] {
  const markedVisible = visibleKeys.filter((k) => marked.has(k));
  if (markedVisible.length > 0) return markedVisible;
  return cursor !== null && visibleKeys.includes(cursor) ? [cursor] : [];
}
