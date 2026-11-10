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
 * The list of playlists, asked to the server one page at a time: search (waits for a pause), filter, sort, and then either «show more»
 * (`mode` 'more', the default: the pages pile up) or real pages (`mode` 'pages': one page at a time, `page`, `pageCount`, `goToPage`:
 * the chooser of a playlist, where a person who has a hundred does not scroll them all). The server does the work (rule P); this only
 * keeps what came back, and ignores an answer that is already out of date (the person typed again while it was on its way).
 */
export function usePlaylistList(pageSize = PLAYLIST_PAGE_SIZE, initial: Partial<PlaylistListControls> = {}, mode: 'more' | 'pages' = 'more') {
  const paged = mode === 'pages';
  const [controls, setControls] = useState<PlaylistListControls>({ ...DEFAULT_PLAYLIST_CONTROLS, ...initial });
  const [asked, setAsked] = useState(controls.q);
  const askedRef = useRef(controls.q);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<PlaylistSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const turn = useRef(0);
  const itemsRef = useRef<PlaylistSummary[]>([]);
  itemsRef.current = items;

  // what the person typed reaches the server only after a pause; a different search starts again from the first page
  useEffect(() => {
    const id = setTimeout(() => {
      const next = controls.q.trim();
      if (next === askedRef.current) return;
      askedRef.current = next;
      setAsked(next);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
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

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageCountRef = useRef(pageCount);
  pageCountRef.current = pageCount;
  const offsetOfPage = paged ? (page - 1) * pageSize : 0;

  // a new search, filter or order starts again from the first page (in pages mode: the page that was asked)
  useEffect(() => {
    void load(offsetOfPage, false);
  }, [load, offsetOfPage]);

  // the list got shorter while a late page was open: go to the last page there is
  useEffect(() => {
    if (paged && !loading && !failed && page > pageCount) setPage(pageCount);
  }, [paged, loading, failed, page, pageCount]);

  const more = useCallback(() => {
    if (paged || loadingMore || itemsRef.current.length >= total) return;
    void load(itemsRef.current.length, true);
  }, [paged, load, loadingMore, total]);

  const reload = useCallback(() => load(offsetOfPage, false), [load, offsetOfPage]);

  const goToPage = useCallback((n: number) => setPage(Math.min(Math.max(1, Math.floor(n)), pageCountRef.current)), []);

  const actions = useMemo(
    () => ({
      setQ: (q: string) => setControls((c) => ({ ...c, q })),
      setFilter: (filter: PlaylistFilter) => { setControls((c) => ({ ...c, filter })); setPage(1); },
      // choosing a sort puts the natural direction; the arrow then flips it
      setSort: (sort: PlaylistSort) => { setControls((c) => ({ ...c, sort, order: naturalOrder(sort) })); setPage(1); },
      toggleOrder: () => { setControls((c) => ({ ...c, order: c.order === 'desc' ? 'asc' : 'desc' })); setPage(1); },
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
    hasMore: paged ? page < pageCount : items.length < total,
    /** Pages mode: the page shown (from 1), how many there are, and the way to move; in «show more» mode the page stays 1. */
    page,
    pageCount,
    goToPage,
    nextPage: () => goToPage(page + 1),
    prevPage: () => goToPage(page - 1),
    /** True when a search or a filter narrows the list (so «no playlist» means «none matches», not «none yet»). */
    narrowed: asked !== '' || controls.filter !== 'all',
    more,
    reload,
    ...actions,
  };
}
