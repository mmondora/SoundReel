import { useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Pagination } from '../components/Pagination';
import { useAllEntries } from '../hooks/useJournal';
import { useLanguage } from '../i18n';
import type { Song, JournalStats } from '../types';

type SortKey = 'recent' | 'artist' | 'title' | 'frequency';

const PAGE_SIZE = 50;

/** One row of the playlist: a unique track plus how often it turned up. */
interface PlaylistSong extends Song {
  /** Entry to open when clicking through — the most recent occurrence. */
  entryId: string;
  /** How many entries this song appeared in. */
  count: number;
  /** Most recent occurrence, used for the "recent" sort. */
  lastSeen: Date | null;
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

/**
 * The Song type declares artist/title as strings, but extracted data can carry
 * nulls (a track recognised by title with no artist attached), so every read
 * here is defensive — one null used to take the whole page down.
 */
export function artistOf(song: Song): string {
  return song.artist?.trim() || '';
}

export function dedupeKey(song: Song): string {
  return `${artistOf(song).toLowerCase()}|${(song.title?.trim() || '').toLowerCase()}`;
}

export function SongsPage() {
  const { entries, loading } = useAllEntries();
  const { t } = useLanguage();
  const [sort, setSort] = useState<SortKey>('recent');
  const [page, setPage] = useState(1);

  const changeSort = useCallback((key: SortKey) => {
    setSort(key);
    setPage(1);
  }, []);

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  // The same track often shows up across several posts; collapse those into one
  // row so this reads as a library rather than a log of occurrences.
  const songs = useMemo<PlaylistSong[]>(() => {
    const byKey = new Map<string, PlaylistSong>();

    for (const entry of entries) {
      const date = parseFirestoreDate(entry.createdAt);
      for (const song of entry.results.songs) {
        if (!song.title?.trim()) continue;
        const key = dedupeKey(song);
        const existing = byKey.get(key);

        if (!existing) {
          byKey.set(key, { ...song, entryId: entry.id, count: 1, lastSeen: date });
          continue;
        }

        existing.count += 1;
        // Newest occurrence wins as the clickthrough target; listening links are
        // merged so a copy that lacks them inherits from one that has them.
        if (date && (!existing.lastSeen || date > existing.lastSeen)) {
          existing.lastSeen = date;
          existing.entryId = entry.id;
        }
        existing.spotifyUrl = existing.spotifyUrl || song.spotifyUrl;
        existing.youtubeUrl = existing.youtubeUrl || song.youtubeUrl;
        existing.soundcloudUrl = existing.soundcloudUrl || song.soundcloudUrl;
        existing.album = existing.album || song.album;
        existing.addedToPlaylist = existing.addedToPlaylist || song.addedToPlaylist;
      }
    }

    return Array.from(byKey.values());
  }, [entries]);

  const sorted = useMemo(() => {
    const list = [...songs];
    switch (sort) {
      case 'artist':
        return list.sort((a, b) =>
          artistOf(a).localeCompare(artistOf(b)) || (a.title || '').localeCompare(b.title || ''));
      case 'title':
        return list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      case 'frequency':
        return list.sort((a, b) => b.count - a.count || artistOf(a).localeCompare(artistOf(b)));
      case 'recent':
      default:
        return list.sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));
    }
  }, [songs, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageItems = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const renderSong = (song: PlaylistSong) => (
    <div className="list-item-row" key={dedupeKey(song)}>
      <div className="list-item-icon">🎵</div>
      <div className="list-item-content">
        <div className="list-item-title">
          {song.title}
          {song.count > 1 && <span className="song-count-badge">×{song.count}</span>}
        </div>
        <div className="list-item-subtitle">
          {artistOf(song) || t.unknownArtist}
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
          {song.soundcloudUrl && (
            <a href={song.soundcloudUrl} target="_blank" rel="noopener noreferrer" className="badge-link soundcloud">
              SoundCloud
            </a>
          )}
          {song.addedToPlaylist && <span className="badge-playlist">✓ Playlist</span>}
        </div>
      </div>
      <Link to={`/?entry=${song.entryId}`} className="list-item-action">{t.viewReel}</Link>
    </div>
  );

  /** Under the artist sort, print each artist once above their tracks. */
  const renderList = () => {
    if (pageItems.length === 0) {
      return <div className="journal-empty"><p>{t.noSongsYet}</p></div>;
    }

    if (sort !== 'artist') {
      return <>{pageItems.map(renderSong)}</>;
    }

    const blocks: Array<{ artist: string; items: PlaylistSong[] }> = [];
    for (const song of pageItems) {
      const last = blocks[blocks.length - 1];
      const artist = artistOf(song) || t.unknownArtist;
      if (last && last.artist === artist) last.items.push(song);
      else blocks.push({ artist, items: [song] });
    }

    return (
      <>
        {blocks.map((block) => (
          <div key={block.artist}>
            <div className="date-group-header">{block.artist}</div>
            {block.items.map(renderSong)}
          </div>
        ))}
      </>
    );
  };

  const SORTS: Array<{ key: SortKey; label: string }> = [
    { key: 'recent', label: t.sortRecent },
    { key: 'artist', label: t.sortArtist },
    { key: 'title', label: t.sortTitle },
    { key: 'frequency', label: t.sortFrequency },
  ];

  return (
    <div className="list-page">
      <Header stats={stats} />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allSongs}</h1>
        </div>

        {!loading && (
          <div className="journal-filter-bar">
            {SORTS.map(({ key, label }) => (
              <button
                key={key}
                className={`filter-chip ${sort === key ? 'active' : ''}`}
                onClick={() => changeSort(key)}
              >
                {label}
              </button>
            ))}
            <span className="filter-result-count">{sorted.length}</span>
          </div>
        )}

        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : (
          <>
            {renderList()}
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              onPrev={() => setPage((p) => Math.max(1, p - 1))}
              onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
            />
          </>
        )}
      </div>
    </div>
  );
}
