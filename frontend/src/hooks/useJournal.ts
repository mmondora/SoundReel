import { useState, useEffect, useCallback, useRef } from 'react';
import { listEntries, openEntryStream } from '../services/api';
import type { Entry, JournalStats } from '../types';

const DEFAULT_PAGE_SIZE = 20;
const FETCH_LIMIT = 1000; // keep a local cache of the most recent N entries

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function useJournal(pageSize = DEFAULT_PAGE_SIZE) {
  const [allEntries, setAllEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    try {
      const data = await listEntries(FETCH_LIMIT);
      if (!mountedRef.current) return;
      setAllEntries(data);
      setLoading(false);
    } catch (e) {
      if (!mountedRef.current) return;
      console.error('[useJournal] fetch error', e);
      setError('Errore nel caricamento del journal');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    reload();
    const close = openEntryStream(
      () => { void reload(); },
      () => { /* keep trying */ }
    );
    return () => {
      mountedRef.current = false;
      close();
    };
  }, [reload]);

  const totalCount = allEntries.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const entries = paginate(allEntries, currentPage, pageSize);

  const stats: JournalStats = {
    totalEntries: totalCount,
    totalSongs: allEntries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: allEntries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: allEntries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  const nextPage = useCallback(() => {
    setCurrentPage((p) => Math.min(p + 1, totalPages));
  }, [totalPages]);
  const prevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(p - 1, 1));
  }, []);

  return {
    entries,
    stats,
    loading,
    error,
    currentPage,
    totalPages,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
    nextPage,
    prevPage,
  };
}

export function useAllEntries() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async (): Promise<void> => {
      try {
        const data = await listEntries(FETCH_LIMIT);
        if (!mounted) return;
        setEntries(data);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    const close = openEntryStream(() => { void load(); });
    return () => {
      mounted = false;
      close();
    };
  }, []);

  return { entries, loading };
}
