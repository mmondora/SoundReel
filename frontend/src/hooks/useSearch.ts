import { useState, useEffect, useRef } from 'react';
import { searchEntries } from '../services/api';
import type { SearchResult } from '../types';

interface SearchState {
  results: SearchResult[];
  expandedTerms: string[];
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: SearchState = {
  results: [],
  expandedTerms: [],
  loading: false,
  error: null,
};

const DEBOUNCE_MS = 400;
const MIN_QUERY_LEN = 2;

export function useSearch(query: string): SearchState {
  const [state, setState] = useState<SearchState>(INITIAL_STATE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    clearTimeout(timerRef.current);

    if (query.trim().length < MIN_QUERY_LEN) {
      setState(INITIAL_STATE);
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));

    timerRef.current = setTimeout(async () => {
      try {
        const data = await searchEntries(query);
        if (!mountedRef.current) return;
        setState({
          results: data.results,
          expandedTerms: data.expandedTerms,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, loading: false, error: String(err) }));
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [query]);

  return state;
}
