import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchEntryFacets, listEntrySummaries, openEntryStream } from '../services/api';
import type { EntryFacets, EntrySummary, InboxFilter } from '../types';

// The Inbox, a page of the whole library at a time (Michele, 10 November: «la paginazione con 30 o 40 per pagina», spec
// 2026-11-10-web-look-and-feel-rethink-design.md §3.6, contract docs/entries-index.md). The server gives the page, the total (which follows the filters)
// and the facets; this keeps them, drops an answer that is already out of date, and reads the page again when the library changes.

/** Posts in a page: Michele said «30 o 40»; 40, like the Link page. */
export const INBOX_PAGE_SIZE = 40;
/** A change of the library (a post arrives, an analysis moves) reads the page again after this pause, once however many changes came. */
export const STREAM_REFRESH_MS = 400;
/** The facets (what the filters offer) are read again at most this often: an analysis makes many changes in a row. */
export const FACETS_REFRESH_MS = 10_000;

export function useInbox(page: number, filter: InboxFilter, pageSize = INBOX_PAGE_SIZE) {
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [facets, setFacets] = useState<EntryFacets | null>(null);
  /** Goes up with every change of the library: the post that is open is read again. */
  const [version, setVersion] = useState(0);
  const turn = useRef(0);
  const facetsAt = useRef(0);

  // the filter is compared by what it says, not by the object: a page that writes the same filter again does not ask again
  const filterKey = JSON.stringify([filter.platform ?? '', filter.channel ?? '', filter.user ?? '', filter.category ?? '', filter.verdict ?? '', filter.tag ?? '']);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  /** `silent`: a refresh the person did not ask for (the library changed): no «loading», and a failure leaves what is on the screen. */
  const load = useCallback(async (silent: boolean) => {
    const mine = ++turn.current;
    if (!silent) {
      setLoading(true);
      setError(false);
    }
    try {
      const result = await listEntrySummaries(pageSize, (page - 1) * pageSize, filterRef.current);
      if (mine !== turn.current) return;
      setEntries(result.entries);
      setTotal(result.total);
      setError(false);
    } catch (e) {
      if (mine !== turn.current) return;
      console.error('[useInbox]', e);
      if (!silent) {
        setEntries([]);
        setTotal(0);
        setError(true);
      }
    } finally {
      if (mine === turn.current && !silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, filterKey]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const loadFacets = useCallback(async (force: boolean) => {
    if (!force && facetsAt.current !== 0 && Date.now() - facetsAt.current < FACETS_REFRESH_MS) return;
    facetsAt.current = Date.now();
    try {
      setFacets(await fetchEntryFacets());
    } catch (e) {
      console.error('[useInbox] facets', e);   // no facets: the list is not touched
    }
  }, []);

  useEffect(() => {
    void loadFacets(true);
  }, [loadFacets]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const close = openEntryStream(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion((v) => v + 1);
        void loadRef.current(true);
        void loadFacets(false);
      }, STREAM_REFRESH_MS);
    });
    return () => {
      close();
      if (timer) clearTimeout(timer);
    };
  }, [loadFacets]);

  const reload = useCallback(() => { void load(false); }, [load]);

  return { entries, total, pageCount: Math.max(1, Math.ceil(total / pageSize)), loading, error, facets, version, reload };
}
