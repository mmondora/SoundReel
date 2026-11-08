import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchListeningStats, fetchRecentPlays } from '../services/api';
import type { StatsQuery } from '../services/api';
import type { ListeningStats, RecentPlay } from '../types';
import { normalizeRecent, normalizeStats } from '../utils/statsView';

export interface ListeningStatsState {
  stats: ListeningStats | null;
  recent: RecentPlay[];
  loading: boolean;
  error: string | null;
}

/**
 * Loads the dashboard numbers and the recent plays for a query. A newer request supersedes an older one (changing the
 * period quickly must not let a slow answer overwrite the new one). `query = null` waits (e.g. until /api/me answered).
 */
export function useListeningStats(query: StatsQuery | null) {
  const [state, setState] = useState<ListeningStatsState>({ stats: null, recent: [], loading: query !== null, error: null });
  const seq = useRef(0);
  const key = query ? JSON.stringify(query) : null;
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback(async () => {
    const q = queryRef.current;
    if (!q) return;
    const id = (seq.current += 1);
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const [statsRes, recentRes] = await Promise.allSettled([fetchListeningStats(q), fetchRecentPlays(q, 50)]);
    if (id !== seq.current) return;
    if (statsRes.status === 'rejected') {
      const reason: unknown = statsRes.reason;
      setState({ stats: null, recent: [], loading: false, error: reason instanceof Error ? reason.message : String(reason) });
      return;
    }
    setState({
      stats: normalizeStats(statsRes.value),
      // The recent list is a bonus: the dashboard still works without it.
      recent: recentRes.status === 'fulfilled' ? normalizeRecent(recentRes.value) : [],
      loading: false,
      error: null,
    });
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the serialised query
  }, [key, load]);

  return { ...state, reload: load };
}
