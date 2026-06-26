import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { listEntries, openEntryStream } from '../services/api';
import type { Entry, JournalStats } from '../types';

const DEFAULT_PAGE_SIZE = 20;
const FETCH_LIMIT = 1000;

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export interface JournalFilter {
  platform?: string | null;
  channel?: string | null;
  user?: string | null;
}

export function useJournal(pageSize = DEFAULT_PAGE_SIZE, filter?: JournalFilter) {
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

  const filterPlatform = filter?.platform ?? null;
  const filterChannel = filter?.channel ?? null;
  const filterUser = filter?.user ?? null;

  // Reset to page 1 when filter changes
  useEffect(() => { setCurrentPage(1); }, [filterPlatform, filterChannel, filterUser]);

  const filteredEntries = useMemo(() => {
    let result = allEntries;
    if (filterPlatform) result = result.filter(e => e.sourcePlatform === filterPlatform);
    if (filterChannel) result = result.filter(e => e.inputChannel === filterChannel);
    if (filterUser) result = result.filter(e => e.inputUser === filterUser);
    return result;
  }, [allEntries, filterPlatform, filterChannel, filterUser]);

  const availablePlatforms = useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of allEntries) {
      seen.set(e.sourcePlatform, (seen.get(e.sourcePlatform) ?? 0) + 1);
    }
    return Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([p, count]) => ({ platform: p, count }));
  }, [allEntries]);

  const availableChannels = useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of allEntries) {
      seen.set(e.inputChannel, (seen.get(e.inputChannel) ?? 0) + 1);
    }
    return Array.from(seen.entries()).map(([ch, count]) => ({ channel: ch, count }));
  }, [allEntries]);

  const availableUsers = useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of allEntries) {
      if (e.inputUser) seen.set(e.inputUser, (seen.get(e.inputUser) ?? 0) + 1);
    }
    return Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([user, count]) => ({ user, count }));
  }, [allEntries]);

  const totalCount = filteredEntries.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const entries = paginate(filteredEntries, currentPage, pageSize);

  const stats: JournalStats = {
    totalEntries: allEntries.length,
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
    availablePlatforms,
    availableChannels,
    availableUsers,
    filteredCount: totalCount,
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
