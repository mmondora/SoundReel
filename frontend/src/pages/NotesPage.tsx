import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { DateGroupedList } from '../components/DateGroupedList';
import { useAllEntries } from '../hooks/useJournal';
import { useLanguage } from '../i18n';
import type { Note, JournalStats } from '../types';
import type { Translations } from '../i18n/translations';

interface NoteWithEntry extends Note {
  entryId: string;
  entryDate: Date | null;
}

function parseFirestoreDate(timestamp: unknown): Date | null {
  if (!timestamp) return null;
  if (typeof timestamp === 'object' && timestamp !== null) {
    const ts = timestamp as Record<string, unknown>;
    const seconds = ts._seconds ?? ts.seconds;
    if (typeof seconds === 'number') return new Date(seconds * 1000);
  }
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) return date;
  }
  return null;
}

const CATEGORY_ICONS: Record<Note['category'], string> = {
  place: '📍',
  event: '📅',
  brand: '🏷️',
  book: '📚',
  product: '📦',
  quote: '💬',
  person: '👤',
  other: '📝',
};

function getCategoryLabel(category: Note['category'], t: Translations): string {
  const map: Record<Note['category'], string> = {
    place: t.notePlace,
    event: t.noteEvent,
    brand: t.noteBrand,
    book: t.noteBook,
    product: t.noteProduct,
    quote: t.noteQuote,
    person: t.notePerson,
    other: t.noteOther,
  };
  return map[category] || category;
}

export function NotesPage() {
  const { entries, loading } = useAllEntries();
  const { t } = useLanguage();

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  const allNotes = useMemo<NoteWithEntry[]>(() => {
    const notes: NoteWithEntry[] = [];
    for (const entry of entries) {
      const date = parseFirestoreDate(entry.createdAt);
      for (const note of entry.results.notes || []) {
        notes.push({ ...note, entryId: entry.id, entryDate: date });
      }
    }
    return notes;
  }, [entries]);

  const renderNote = (note: NoteWithEntry) => (
    <div className="list-item-row">
      <div className="list-item-icon">{CATEGORY_ICONS[note.category] || '📝'}</div>
      <div className="list-item-content">
        <div className="list-item-title">{note.text}</div>
        <div className="list-item-badges">
          <span className="category-badge">{getCategoryLabel(note.category, t)}</span>
        </div>
      </div>
      <Link to={`/?entry=${note.entryId}`} className="list-item-action">{t.viewReel}</Link>
    </div>
  );

  return (
    <div className="list-page">
      <Header stats={stats} />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allNotes}</h1>
        </div>
        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : (
          <DateGroupedList
            items={allNotes}
            renderItem={renderNote}
            getDate={(n) => n.entryDate}
            emptyMessage={t.noNotesYet}
          />
        )}
      </div>
    </div>
  );
}
