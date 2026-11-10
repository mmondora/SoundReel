import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPlaylistsPage } from '../services/api';
import type { PlaylistFilter, PlaylistSort, PlaylistSummary } from '../types';

/** A page of the list of playlists (ADR-0023). */
export const PLAYLIST_PAGE_SIZE = 30;
/** The search waits for a pause in the typing before it asks the server. */
export const SEARCH_DEBOUNCE_MS = 250;

export interface PlaylistListControls {
  q: string;
  filter: PlaylistFilter;
  sort: PlaylistSort;
  order: 'asc' | 'desc';
}

/** Michele: «un ordine di data»: by creation date, the newest first. */
export const DEFAULT_PLAYLIST_CONTROLS: PlaylistListControls = { q: '', filter: 'all', sort: 'created', order: 'desc' };

/** The natural direction of a sort: A to Z by name, the newest or biggest first for the others. */
export const naturalOrder = (sort: PlaylistSort): 'asc' | 'desc' => (sort === 'name' ? 'asc' : 'desc');

/**
 * The list of playlists, asked to the server one page at a time: search (waits for a pause), filter, sort, «show more». The
 * server does the work (rule P); this only keeps what came back, and ignores an answer that is already out of date (the person
 * typed again while it was on its way).
 */
export function usePlaylistList(pageSize = PLAYLIST_PAGE_SIZE, initial: Partial<PlaylistListControls> = {}) {
  const [controls, setControls] = useState<PlaylistListControls>({ ...DEFAULT_PLAYLIST_CONTROLS, ...initial });
  const [asked, setAsked] = useState(controls.q);
  const [items, setItems] = useState<PlaylistSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const turn = useRef(0);
  const itemsRef = useRef<PlaylistSummary[]>([]);
  itemsRef.current = items;

  // what the person typed reaches the server only after a pause
  useEffect(() => {
    const id = setTimeout(() => setAsked(controls.q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [controls.q]);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      const mine = ++turn.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const page = await fetchPlaylistsPage({
          q: asked || undefined,
          filter: controls.filter,
          sort: controls.sort,
          order: controls.order,
          limit: pageSize,
          offset,
        });
        if (mine !== turn.current) return;
        setFailed(false);
        setTotal(page.total);
        setItems((prev) => {
          if (!append) return page.playlists;
          // a playlist made meanwhile shifts the pages: never show the same one twice
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...page.playlists.filter((p) => !seen.has(p.id))];
        });
      } catch {
        if (mine !== turn.current) return;
        setFailed(true);
        if (!append) {
          setItems([]);
          setTotal(0);
        }
      } finally {
        if (mine === turn.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [asked, controls.filter, controls.sort, controls.order, pageSize],
  );

  // a new search, filter or order starts again from the first page
  useEffect(() => {
    void load(0, false);
  }, [load]);

  const more = useCallback(() => {
    if (loadingMore || itemsRef.current.length >= total) return;
    void load(itemsRef.current.length, true);
  }, [load, loadingMore, total]);

  const reload = useCallback(() => load(0, false), [load]);

  const actions = useMemo(
    () => ({
      setQ: (q: string) => setControls((c) => ({ ...c, q })),
      setFilter: (filter: PlaylistFilter) => setControls((c) => ({ ...c, filter })),
      // choosing a sort puts the natural direction; the arrow then flips it
      setSort: (sort: PlaylistSort) => setControls((c) => ({ ...c, sort, order: naturalOrder(sort) })),
      toggleOrder: () => setControls((c) => ({ ...c, order: c.order === 'desc' ? 'asc' : 'desc' })),
    }),
    [],
  );

  return {
    items,
    total,
    loading,
    loadingMore,
    failed,
    controls,
    hasMore: items.length < total,
    /** True when a search or a filter narrows the list (so «no playlist» means «none matches», not «none yet»). */
    narrowed: asked !== '' || controls.filter !== 'all',
    more,
    reload,
    ...actions,
  };
}
