import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchJournalStats } from '../services/api';
import type { JournalStats } from '../types';

/**
 * The counts of the journal (links, songs, films, notes, software) for the menu of the shell. Read again whenever the page changes (what was
 * analysed meanwhile shows), kept when the server does not answer.
 */
export function useJournalStats(): JournalStats | null {
  const { pathname } = useLocation();
  const [stats, setStats] = useState<JournalStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJournalStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        /* the menu simply shows no counts */
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return stats;
}
