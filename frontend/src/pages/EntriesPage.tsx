import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { DateGroupedList } from '../components/DateGroupedList';
import { useAllEntries } from '../hooks/useJournal';
import { useLanguage } from '../i18n';
import type { Entry, JournalStats } from '../types';

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

function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    instagram: 'IG', tiktok: 'TT', youtube: 'YT', facebook: 'FB',
    twitter: 'X', threads: 'TH', snapchat: 'SC', pinterest: 'PIN',
    linkedin: 'LI', reddit: 'RD', vimeo: 'VM', twitch: 'TW',
    spotify: 'SP', soundcloud: 'SND',
  };
  return labels[platform] || 'WEB';
}

export function EntriesPage() {
  const { entries, loading } = useAllEntries();
  const { t } = useLanguage();

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  const renderEntry = (entry: Entry) => {
    const date = parseFirestoreDate(entry.createdAt);
    const songCount = entry.results.songs.length;
    const filmCount = entry.results.films.length;
    const noteCount = entry.results.notes?.length || 0;
    const summary = entry.results.summary || entry.caption?.substring(0, 120) || entry.sourceUrl;

    return (
      <div className="list-item-row">
        {entry.thumbnailUrl ? (
          <img src={entry.thumbnailUrl} alt="" className="list-item-thumb" loading="lazy" />
        ) : (
          <div className="list-item-thumb-placeholder">
            {getPlatformLabel(entry.sourcePlatform)}
          </div>
        )}
        <div className="list-item-content">
          <div className="list-item-top">
            <span className="list-item-platform">{getPlatformLabel(entry.sourcePlatform)}</span>
            {date && <span className="list-item-date">{date.toLocaleDateString()}</span>}
          </div>
          <p className="list-item-summary">{summary}</p>
          <div className="list-item-meta">
            {songCount > 0 && <span className="list-item-count">🎵 {songCount}</span>}
            {filmCount > 0 && <span className="list-item-count">🎬 {filmCount}</span>}
            {noteCount > 0 && <span className="list-item-count">📝 {noteCount}</span>}
          </div>
        </div>
        <Link to={`/?entry=${entry.id}`} className="list-item-action">{t.openEntry}</Link>
      </div>
    );
  };

  return (
    <div className="list-page">
      <Header stats={stats} />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allEntries}</h1>
        </div>
        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : (
          <DateGroupedList
            items={entries}
            renderItem={renderEntry}
            getDate={(e) => parseFirestoreDate(e.createdAt)}
            emptyMessage={t.noEntries}
          />
        )}
      </div>
    </div>
  );
}
