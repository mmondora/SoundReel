import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { DateGroupedList } from '../components/DateGroupedList';
import { useAllEntries } from '../hooks/useJournal';
import { useLanguage } from '../i18n';
import type { Film, JournalStats } from '../types';

interface FilmWithEntry extends Film {
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

export function FilmsPage() {
  const { entries, loading } = useAllEntries();
  const { t } = useLanguage();

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  const allFilms = useMemo<FilmWithEntry[]>(() => {
    const films: FilmWithEntry[] = [];
    for (const entry of entries) {
      const date = parseFirestoreDate(entry.createdAt);
      for (const film of entry.results.films) {
        films.push({ ...film, entryId: entry.id, entryDate: date });
      }
    }
    return films;
  }, [entries]);

  const renderFilm = (film: FilmWithEntry) => (
    <div className="list-item-row">
      {film.posterUrl ? (
        <img src={film.posterUrl} alt="" className="list-item-poster" loading="lazy" />
      ) : (
        <div className="list-item-icon">🎬</div>
      )}
      <div className="list-item-content">
        <div className="list-item-title">{film.title}</div>
        <div className="list-item-subtitle">
          {film.director && <span>{t.director}: {film.director}</span>}
          {film.year && <span className="list-item-muted"> ({film.year})</span>}
        </div>
        <div className="list-item-badges">
          {film.imdbUrl && (
            <a href={film.imdbUrl} target="_blank" rel="noopener noreferrer" className="badge-link imdb">
              IMDb
            </a>
          )}
          {film.streamingUrls?.netflix && (
            <a href={film.streamingUrls.netflix} target="_blank" rel="noopener noreferrer" className="badge-link netflix">
              Netflix
            </a>
          )}
          {film.streamingUrls?.primeVideo && (
            <a href={film.streamingUrls.primeVideo} target="_blank" rel="noopener noreferrer" className="badge-link prime">
              Prime
            </a>
          )}
          {film.streamingUrls?.disneyPlus && (
            <a href={film.streamingUrls.disneyPlus} target="_blank" rel="noopener noreferrer" className="badge-link disney">
              Disney+
            </a>
          )}
        </div>
      </div>
      <Link to={`/?entry=${film.entryId}`} className="list-item-action">{t.viewReel}</Link>
    </div>
  );

  return (
    <div className="list-page">
      <Header stats={stats} />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allFilms}</h1>
        </div>
        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : (
          <DateGroupedList
            items={allFilms}
            renderItem={renderFilm}
            getDate={(f) => f.entryDate}
            emptyMessage={t.noFilmsYet}
          />
        )}
      </div>
    </div>
  );
}
