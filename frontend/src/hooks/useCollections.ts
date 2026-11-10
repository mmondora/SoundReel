import { useCallback, useEffect, useState } from 'react';
import { fetchCollections } from '../services/api';
import type { CollectionListItem } from '../types';

export interface CollectionsState {
  /** In the order the server decided: the site never reorders. */
  collections: CollectionListItem[];
  loading: boolean;
  failed: boolean;
  reload: () => void;
}

/** The collections the user sees (or, with `state`, the hidden ones). Read when the page opens and again on `reload`; a late answer never replaces a newer one. */
export function useCollections(state: 'active' | 'hidden' | 'watching' = 'active'): CollectionsState {
  const [collections, setCollections] = useState<CollectionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setFailed(false);
    fetchCollections(state)
      .then((list) => { if (current) { setCollections(list); setLoading(false); } })
      .catch(() => { if (current) { setCollections([]); setFailed(true); setLoading(false); } });
    return () => { current = false; };
  }, [state, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { collections, loading, failed, reload };
}
