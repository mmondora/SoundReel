/**
 * The list of playlists as the person asks for it (ADR-0023, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.B):
 * searched by name, narrowed by kind, sorted by date (or name, or size) and cut in pages. The SERVER does it (rule P): a client shows
 * what it gets, and an app does not have to download every playlist to find one.
 *
 * Pure (no database), so the rules are tested without one. Compatible: a request with NONE of the parameters is answered as before
 * (every playlist, in the order it was given); `total` is the only addition.
 */

export const PLAYLIST_FILTERS = ['all', 'auto', 'mine', 'shared', 'dynamic'] as const;
export const PLAYLIST_SORTS = ['created', 'updated', 'name', 'size'] as const;
export type PlaylistFilter = (typeof PLAYLIST_FILTERS)[number];
export type PlaylistSort = (typeof PLAYLIST_SORTS)[number];

/** The most playlists one page may carry; a bigger `limit` is cut to this. */
export const MAX_PLAYLIST_PAGE = 100;
const MAX_SEARCH_CHARS = 100;

export interface PlaylistListQuery {
  /** The words searched, without case or accents; empty = no search. */
  words: string[];
  filter: PlaylistFilter;
  sort: PlaylistSort;
  order: 'asc' | 'desc';
  /** `null` = not paged: every match comes back. */
  limit: number | null;
  offset: number;
  /** True when the request carried none of the parameters: the answer of before. */
  legacy: boolean;
}

export type PlaylistListParse = { ok: true; query: PlaylistListQuery } | { ok: false; error: string };

/** What the list needs to know about a playlist (a `PlaylistSummary`, with the owner when it is known). */
export interface ListablePlaylist {
  name: string;
  createdAt: string;
  updatedAt: string;
  songCount: number;
  kind?: 'static' | 'dynamic';
  origin?: 'user' | 'auto';
  ownerUser?: string;
}

const KEYS = ['q', 'filter', 'sort', 'order', 'limit', 'offset'] as const;

/** No case, no accents, letters and digits only, one space between words: «Più Ascoltate!» → «piu ascoltate». */
export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Reads the query string. A value that is not one of the known ones is an error to say (400), never a list that looks right but is not. */
export function parsePlaylistListQuery(raw: Record<string, unknown> | null | undefined): PlaylistListParse {
  const src = raw ?? {};
  const legacy = KEYS.every((k) => src[k] === undefined);

  // a repeated parameter arrives as an array: that is not a value
  const read = (key: (typeof KEYS)[number]): { value?: string; bad?: true } => {
    const v = src[key];
    if (v === undefined) return {};
    return typeof v === 'string' ? { value: v } : { bad: true };
  };
  for (const key of KEYS) {
    if (read(key).bad) return { ok: false, error: `${key} must be a single value` };
  }

  const q = (read('q').value ?? '').trim().slice(0, MAX_SEARCH_CHARS);
  const words = normalizeForSearch(q).split(' ').filter(Boolean);

  const filter = (read('filter').value ?? 'all') as PlaylistFilter;
  if (!PLAYLIST_FILTERS.includes(filter)) return { ok: false, error: `filter must be one of ${PLAYLIST_FILTERS.join(', ')}` };

  const sort = (read('sort').value ?? 'updated') as PlaylistSort;
  if (!PLAYLIST_SORTS.includes(sort)) return { ok: false, error: `sort must be one of ${PLAYLIST_SORTS.join(', ')}` };

  // by name the natural way is A to Z; every other is the newest / biggest first
  const orderRaw = read('order').value ?? (sort === 'name' ? 'asc' : 'desc');
  if (orderRaw !== 'asc' && orderRaw !== 'desc') return { ok: false, error: 'order must be asc or desc' };

  let limit: number | null = null;
  const limitRaw = read('limit').value;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) return { ok: false, error: 'limit must be a whole number, at least 1' };
    limit = Math.min(Number(limitRaw), MAX_PLAYLIST_PAGE);
  }

  let offset = 0;
  const offsetRaw = read('offset').value;
  if (offsetRaw !== undefined) {
    if (!/^\d+$/.test(offsetRaw)) return { ok: false, error: 'offset must be a whole number, 0 or more' };
    offset = Number(offsetRaw);
  }

  return { ok: true, query: { words, filter, sort, order: orderRaw, limit, offset, legacy } };
}

const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function compare(a: ListablePlaylist, b: ListablePlaylist, sort: PlaylistSort): number {
  switch (sort) {
    case 'created':
      return time(a.createdAt) - time(b.createdAt);
    case 'updated':
      return time(a.updatedAt) - time(b.updatedAt);
    case 'size':
      return a.songCount - b.songCount;
    case 'name':
      return collator.compare(a.name, b.name);
  }
}

function matchesFilter(p: ListablePlaylist, filter: PlaylistFilter, viewerId: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'auto':
      return p.origin === 'auto';
    case 'mine':
      return p.ownerUser === viewerId;
    case 'shared':
      return p.ownerUser !== undefined && p.ownerUser !== viewerId;
    case 'dynamic':
      return p.kind === 'dynamic';
  }
}

/** The playlists the person asked for, and how many matched BEFORE the page was cut (`total`). */
export function applyPlaylistList<T extends ListablePlaylist>(
  rows: readonly T[],
  query: PlaylistListQuery,
  viewerId: string,
): { items: T[]; total: number } {
  if (query.legacy) return { items: [...rows], total: rows.length };

  const matched = rows.filter((p) => {
    if (!matchesFilter(p, query.filter, viewerId)) return false;
    if (query.words.length === 0) return true;
    const name = normalizeForSearch(p.name);
    return query.words.every((w) => name.includes(w));
  });

  const dir = query.order === 'asc' ? 1 : -1;
  // a tie is settled the same way whatever the direction: the newest first, then by name
  const sorted = [...matched].sort(
    (a, b) => dir * compare(a, b, query.sort) || time(b.createdAt) - time(a.createdAt) || collator.compare(a.name, b.name),
  );

  const items = query.limit === null ? sorted.slice(query.offset) : sorted.slice(query.offset, query.offset + query.limit);
  return { items, total: sorted.length };
}
