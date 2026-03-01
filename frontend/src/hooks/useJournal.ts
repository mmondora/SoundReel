import { useState, useEffect, useCallback, useRef } from 'react';
import {
  collection, query, orderBy, limit, onSnapshot,
  startAfter, endBefore, limitToLast,
  getCountFromServer,
  type DocumentSnapshot, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { db } from '../services/firebase';
import type { Entry, JournalStats } from '../types';

const DEFAULT_PAGE_SIZE = 20;

export function useJournal(pageSize = DEFAULT_PAGE_SIZE) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  // Cursor refs for pagination
  const firstDocRef = useRef<DocumentSnapshot | null>(null);
  const lastDocRef = useRef<DocumentSnapshot | null>(null);
  const cursorRef = useRef<{ type: 'first' | 'after' | 'before'; doc: DocumentSnapshot } | null>(null);

  const stats: JournalStats = {
    totalEntries: totalCount,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  // Fetch total count
  useEffect(() => {
    const colRef = collection(db, 'entries');
    getCountFromServer(colRef).then(snap => {
      setTotalCount(snap.data().count);
    }).catch(() => {});
  }, []);

  // Subscribe to current page
  useEffect(() => {
    setLoading(true);

    const colRef = collection(db, 'entries');
    let q;

    const cursor = cursorRef.current;
    if (cursor?.type === 'after') {
      q = query(colRef, orderBy('createdAt', 'desc'), startAfter(cursor.doc), limit(pageSize));
    } else if (cursor?.type === 'before') {
      q = query(colRef, orderBy('createdAt', 'desc'), endBefore(cursor.doc), limitToLast(pageSize));
    } else {
      q = query(colRef, orderBy('createdAt', 'desc'), limit(pageSize));
    }

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const newEntries: Entry[] = [];
        const docs: QueryDocumentSnapshot[] = [];
        snapshot.forEach((doc) => {
          docs.push(doc);
          newEntries.push({ id: doc.id, ...doc.data() } as Entry);
        });
        if (docs.length > 0) {
          firstDocRef.current = docs[0];
          lastDocRef.current = docs[docs.length - 1];
        }
        setEntries(newEntries);
        setLoading(false);

        // Update total count on changes
        getCountFromServer(colRef).then(snap => {
          setTotalCount(snap.data().count);
        }).catch(() => {});
      },
      (err) => {
        console.error('[useJournal] Firestore error:', err);
        setError('Errore nel caricamento del journal');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [pageSize, currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const nextPage = useCallback(() => {
    if (currentPage >= totalPages) return;
    if (lastDocRef.current) {
      cursorRef.current = { type: 'after', doc: lastDocRef.current };
      setCurrentPage(p => p + 1);
    }
  }, [currentPage, totalPages]);

  const prevPage = useCallback(() => {
    if (currentPage <= 1) return;
    if (firstDocRef.current) {
      cursorRef.current = { type: 'before', doc: firstDocRef.current };
      setCurrentPage(p => p - 1);
    }
  }, [currentPage]);

  const hasNext = currentPage < totalPages;
  const hasPrev = currentPage > 1;

  return {
    entries, stats, loading, error,
    currentPage, totalPages, hasNext, hasPrev,
    nextPage, prevPage,
  };
}

/**
 * Hook to fetch ALL entries for dedicated list pages (no real-time, just a snapshot).
 */
export function useAllEntries() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'entries'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const all: Entry[] = [];
      snapshot.forEach((doc) => {
        all.push({ id: doc.id, ...doc.data() } as Entry);
      });
      setEntries(all);
      setLoading(false);
    }, () => {
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  return { entries, loading };
}
