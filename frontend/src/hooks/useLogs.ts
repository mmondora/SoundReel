import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  where,
  QueryConstraint
} from 'firebase/firestore';
import { db } from '../services/firebase';
import type { LogEntry, LogFilters, LogLevel } from '../types';

const LOGS_LIMIT = 200;

export function useLogs(filters: LogFilters) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableFunctions, setAvailableFunctions] = useState<string[]>([]);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const constraints: QueryConstraint[] = [];

    // Apply level filter
    if (filters.level !== 'all') {
      constraints.push(where('level', '==', filters.level));
    }

    // Apply function filter
    if (filters.function !== 'all') {
      constraints.push(where('function', '==', filters.function));
    }

    // Apply entryId filter
    if (filters.entryId) {
      constraints.push(where('entryId', '==', filters.entryId));
    }

    // Always order by timestamp descending and limit
    constraints.push(orderBy('createdAt', 'desc'));
    constraints.push(limit(LOGS_LIMIT));

    const logsQuery = query(collection(db, 'logs'), ...constraints);

    const unsubscribe = onSnapshot(
      logsQuery,
      (snapshot) => {
        const logsData: LogEntry[] = [];
        const functionsSet = new Set<string>();

        snapshot.forEach((doc) => {
          const data = doc.data();
          logsData.push({
            id: doc.id,
            timestamp: data.timestamp,
            level: data.level as LogLevel,
            function: data.function,
            message: data.message,
            data: data.data,
            entryId: data.entryId,
            durationMs: data.durationMs,
            error: data.error
          });
          functionsSet.add(data.function);
        });

        // Apply client-side search filter
        let filteredLogs = logsData;
        if (filters.search) {
          const searchLower = filters.search.toLowerCase();
          filteredLogs = logsData.filter(
            (log) =>
              log.message.toLowerCase().includes(searchLower) ||
              log.function.toLowerCase().includes(searchLower) ||
              (log.error && log.error.toLowerCase().includes(searchLower)) ||
              (log.data && JSON.stringify(log.data).toLowerCase().includes(searchLower))
          );
        }

        setLogs(filteredLogs);
        setAvailableFunctions(Array.from(functionsSet).sort());
        setLoading(false);
      },
      (err) => {
        console.error('Error fetching logs:', err);
        setError('Errore nel caricamento dei log');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [filters.level, filters.function, filters.entryId, filters.search]);

  const clearLogs = useCallback(async () => {
    try {
      const functionsUrl = import.meta.env.VITE_FUNCTIONS_URL;
      const response = await fetch(`${functionsUrl}/clearAllLogs`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error('Failed to clear logs');
      }
    } catch (err) {
      console.error('Error clearing logs:', err);
      throw err;
    }
  }, []);

  return { logs, loading, error, availableFunctions, clearLogs };
}
