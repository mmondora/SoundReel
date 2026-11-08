import { useCallback, useEffect, useRef, useState } from 'react';
import { searchLibrary } from '../services/api';
import type { LibrarySearchResponse } from '../types';
import { parseApiError } from '../utils/apiError';
import type { ApiErrorInfo } from '../utils/apiError';
import { SEARCH_DEBOUNCE_MS, SEARCH_LIMIT, canSearch, normalizeQuery } from '../utils/librarySearch';

export type SearchStatus =
  /** Nothing to search for yet (the text is too short). */
  | 'idle'
  /** Typing: the request waits for a pause (debounce). */
  | 'waiting'
  | 'loading'
  | 'ready'
  | 'error';

export interface LibrarySearch {
  status: SearchStatus;
  /** The text the search runs for (trimmed, spaces collapsed). */
  query: string;
  /** The last good answer. While a newer one loads it is kept (and `stale` is true) so the page does not flicker. */
  data: LibrarySearchResponse | null;
  stale: boolean;
  error: ApiErrorInfo | null;
  retry: () => void;
}

/**
 * Searches the library as the user types: after a pause of `debounceMs`, one request, always for ALL scopes
 * (the server only counts the scopes it searched, and the page shows the three counts; picking a scope is a filter
 * on the answer). A newer text cancels the older request; its answer can never overwrite the newer one.
 */
export function useLibrarySearch(text: string, debounceMs: number = SEARCH_DEBOUNCE_MS): LibrarySearch {
  const query = normalizeQuery(text);
  const searchable = canSearch(query);
  const [state, setState] = useState<{
    status: SearchStatus;
    data: LibrarySearchResponse | null;
    dataQuery: string;
    error: ApiErrorInfo | null;
  }>({ status: 'idle', data: null, dataQuery: '', error: null });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = (seq.current += 1);
    if (!searchable) {
      setState({ status: 'idle', data: null, dataQuery: '', error: null });
      return undefined;
    }
    setState((prev) => ({ ...prev, status: 'waiting', error: null }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setState((prev) => ({ ...prev, status: 'loading' }));
      searchLibrary(query, 'all', SEARCH_LIMIT, controller.signal)
        .then((data) => {
          if (id !== seq.current) return;
          setState({ status: 'ready', data, dataQuery: query, error: null });
        })
        .catch((err: unknown) => {
          if (id !== seq.current || controller.signal.aborted) return;
          setState({ status: 'error', data: null, dataQuery: '', error: parseApiError(err) });
        });
    }, debounceMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchable, debounceMs, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    status: state.status,
    query,
    data: state.data,
    stale: state.data !== null && state.dataQuery !== query,
    error: state.error,
    retry,
  };
}
