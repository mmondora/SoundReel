import { useState, useEffect } from 'react';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '../services/firebase';
import type { Entry, JournalStats } from '../types';

export function useJournal(maxEntries = 50) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0)
  };

  useEffect(() => {
    console.log('[useJournal] Setting up Firestore listener...');

    const q = query(
      collection(db, 'entries'),
      orderBy('createdAt', 'desc'),
      limit(maxEntries)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        console.log('[useJournal] Snapshot received, docs:', snapshot.size);
        const newEntries: Entry[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          console.log('[useJournal] Entry:', doc.id, data.status, data.createdAt);
          newEntries.push({
            id: doc.id,
            ...data
          } as Entry);
        });
        setEntries(newEntries);
        setLoading(false);
      },
      (err) => {
        console.error('[useJournal] Firestore error:', err);
        setError('Errore nel caricamento del journal');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [maxEntries]);

  return { entries, stats, loading, error };
}
