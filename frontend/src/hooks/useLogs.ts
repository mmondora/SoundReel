import { useState, useEffect, useCallback, useRef } from 'react';
import { getLogs, clearLogs as apiClearLogs } from '../services/api';
import type { LogEntry, LogFilters, LogLevel } from '../types';

const LOGS_LIMIT = 200;
const POLL_INTERVAL_MS = 3000;

interface LogRecord {
  id: number;
  ts: string;
  level: LogLevel;
  category?: string | null;
  entryId?: string | null;
  message: string;
  data?: {
    function?: string;
    durationMs?: number | null;
    data?: Record<string, unknown> | null;
    error?: string | null;
  } | null;
}

function adapt(r: LogRecord): LogEntry {
  return {
    id: String(r.id),
    timestamp: r.ts,
    level: r.level,
    function: r.data?.function || r.category || 'unknown',
    message: r.message,
    data: r.data?.data || null,
    entryId: r.entryId || null,
    durationMs: r.data?.durationMs ?? null,
    error: r.data?.error ?? null,
  };
}

export function useLogs(filters: LogFilters) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableFunctions, setAvailableFunctions] = useState<string[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);

    const fetchOnce = async (): Promise<void> => {
      try {
        const raw = (await getLogs({
          level: filters.level !== 'all' ? filters.level : undefined,
          entryId: filters.entryId || undefined,
          limit: LOGS_LIMIT,
        })) as unknown as LogRecord[];
        if (!mountedRef.current) return;

        let items = raw.map(adapt);
        const functionsSet = new Set<string>(items.map((l) => l.function));

        if (filters.function !== 'all') {
          items = items.filter((l) => l.function === filters.function);
        }
        if (filters.search) {
          const s = filters.search.toLowerCase();
          items = items.filter(
            (log) =>
              log.message.toLowerCase().includes(s) ||
              log.function.toLowerCase().includes(s) ||
              (log.error && log.error.toLowerCase().includes(s)) ||
              (log.data && JSON.stringify(log.data).toLowerCase().includes(s))
          );
        }

        setLogs(items);
        setAvailableFunctions(Array.from(functionsSet).sort());
        setLoading(false);
        setError(null);
      } catch (err) {
        if (!mountedRef.current) return;
        console.error('Error fetching logs:', err);
        setError('Errore nel caricamento dei log');
        setLoading(false);
      }
    };

    void fetchOnce();
    const timer = window.setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [filters.level, filters.function, filters.entryId, filters.search]);

  const clearLogs = useCallback(async () => {
    await apiClearLogs();
  }, []);

  return { logs, loading, error, availableFunctions, clearLogs };
}
