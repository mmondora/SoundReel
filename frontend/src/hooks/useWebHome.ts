import { useCallback, useEffect, useState } from 'react';
import { fetchWebHome } from '../services/api';
import type { WebHomeSection } from '../types';

export interface WebHomeState {
  sections: WebHomeSection[];
  loading: boolean;
  /** The Home could not be built or reached (a section that fails is not an error: the server just leaves it out). */
  error: boolean;
  reload: () => void;
}

/** The sections of the Home view, read when the page opens and again on `reload`. A late answer never replaces a newer one. */
export function useWebHome(): WebHomeState {
  const [sections, setSections] = useState<WebHomeSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(false);
    fetchWebHome()
      .then((home) => { if (current) { setSections(home.sections); setLoading(false); } })
      .catch(() => { if (current) { setSections([]); setError(true); setLoading(false); } });
    return () => { current = false; };
  }, [round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { sections, loading, error, reload };
}
