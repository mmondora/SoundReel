import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { DateGroupedList } from '../components/DateGroupedList';
import { useAllEntries } from '../hooks/useJournal';
import { useLanguage } from '../i18n';
import type { Song, JournalStats } from '../types';

interface SongWithEntry extends Song {
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

function getSourceBadge(source: Song['source']): string {
  switch (source) {
    case 'audio_fingerprint': return 'AudD';
    case 'ai_analysis': return 'AI';
    case 'both': return 'AudD + AI';
    default: return '';
  }
}

export function SongsPage() {
  const { entries, loading } = useAllEntries();
  const { t } = useLanguage();

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  const allSongs = useMemo<SongWithEntry[]>(() => {
    const songs: SongWithEntry[] = [];
    for (const entry of entries) {
      const date = parseFirestoreDate(entry.createdAt);
      for (const song of entry.results.songs) {
        songs.push({ ...song, entryId: entry.id, entryDate: date });
      }
    }
    return songs;
  }, [entries]);

  const renderSong = (song: SongWithEntry) => (
    <div className="list-item-row">
      <div className="list-item-icon">🎵</div>
      <div className="list-item-content">
        <div className="list-item-title">{song.title}</div>
        <div className="list-item-subtitle">
          {song.artist}
          {song.album && <span className="list-item-muted"> — {song.album}</span>}
        </div>
        <div className="list-item-badges">
          <span className="source-badge">{getSourceBadge(song.source)}</span>
          {song.spotifyUrl && (
            <a href={song.spotifyUrl} target="_blank" rel="noopener noreferrer" className="badge-link spotify">
              Spotify
            </a>
          )}
          {song.youtubeUrl && (
            <a href={song.youtubeUrl} target="_blank" rel="noopener noreferrer" className="badge-link youtube">
              YouTube
            </a>
          )}
          {song.addedToPlaylist && <span className="badge-playlist">✓ Playlist</span>}
        </div>
      </div>
      <Link to={`/?entry=${song.entryId}`} className="list-item-action">{t.viewReel}</Link>
    </div>
  );

  return (
    <div className="list-page">
      <Header stats={stats} />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allSongs}</h1>
        </div>
        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : (
          <DateGroupedList
            items={allSongs}
            renderItem={renderSong}
            getDate={(s) => s.entryDate}
            emptyMessage={t.noSongsYet}
          />
        )}
      </div>
    </div>
  );
}
