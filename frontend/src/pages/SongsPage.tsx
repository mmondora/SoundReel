import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { SongCard } from '../components/SongCard';
import { fetchSongs, patchSongMeta } from '../services/api';
import type { SongMetaPatchBody } from '../services/api';
import { filterSongs, collectGenres } from '../utils/songFilters';
import type { ListenedFilter, DownloadedFilter } from '../utils/songFilters';
import { useAllEntries } from '../hooks/useJournal';
import { useLanguage } from '../i18n';
import type { AggregatedSong, SongMetaRecord, JournalStats } from '../types';

function createDefaultMeta(songKey: string): SongMetaRecord {
  return {
    songKey,
    deezerId: null,
    itunesId: null,
    genres: [],
    album: null,
    coverUrl: null,
    previewUrl: null,
    deezerUrl: null,
    itunesUrl: null,
    enrichedAt: null,
    listened: false,
    favorite: false,
    downloaded: false,
    rating: null,
    score: null,
  };
}

/** Applies a patch to a song's local meta the same way the backend would, for optimistic updates. */
export function mergePatch(meta: SongMetaRecord | null, songKey: string, patch: SongMetaPatchBody): SongMetaRecord {
  const next: SongMetaRecord = { ...(meta ?? createDefaultMeta(songKey)) };

  if (patch.listened !== undefined) next.listened = patch.listened;
  if (patch.favorite !== undefined) next.favorite = patch.favorite;
  if (patch.downloaded !== undefined) next.downloaded = patch.downloaded;
  if (patch.rating !== undefined) next.rating = patch.rating;
  if (patch.score !== undefined) next.score = patch.score;
  // Rating or a score always implies the song has been listened to.
  if ((patch.rating !== undefined && patch.rating !== null) || (patch.score !== undefined && patch.score !== null)) {
    next.listened = true;
  }

  return next;
}

export function SongsPage() {
  const { entries } = useAllEntries();
  const { t } = useLanguage();

  const [songs, setSongs] = useState<AggregatedSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  const [listenedFilter, setListenedFilter] = useState<ListenedFilter>('all');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [downloadedFilter, setDownloadedFilter] = useState<DownloadedFilter>('all');
  // Per-songKey monotonic counter so a slow/out-of-order PATCH response
  // (success or failure) can never clobber a newer patch already applied to
  // that song.
  const patchSeqRef = useRef(new Map<string, number>());

  useEffect(() => {
    fetchSongs().then(setSongs).catch(() => setSongs([])).finally(() => setLoading(false));
  }, []);

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  // Most recently mentioned song first (mentions are ordered newest-first by the backend).
  const sortedSongs = useMemo(() => {
    return [...songs].sort((a, b) => {
      const aTime = a.mentions[0] ? new Date(a.mentions[0].createdAt).getTime() : 0;
      const bTime = b.mentions[0] ? new Date(b.mentions[0].createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [songs]);

  const genres = useMemo(() => collectGenres(sortedSongs), [sortedSongs]);
  const visible = useMemo(
    () =>
      filterSongs(sortedSongs, {
        genres: genreFilter,
        listened: listenedFilter,
        favorite: favoriteOnly,
        downloaded: downloadedFilter,
      }),
    [sortedSongs, genreFilter, listenedFilter, favoriteOnly, downloadedFilter]
  );

  function toggleGenre(genre: string) {
    setGenreFilter((prev) => (prev.includes(genre) ? prev.filter((g) => g !== genre) : [...prev, genre]));
  }

  // Optimistic patch: apply locally, PATCH, roll back on failure. Rollback and
  // the success write are both scoped to this one song's meta (never the
  // whole array) and guarded by a per-songKey sequence number so a response
  // that arrives after a newer patch for the same song can't overwrite it.
  async function applyPatch(songKey: string, patch: SongMetaPatchBody) {
    const seq = (patchSeqRef.current.get(songKey) ?? 0) + 1;
    patchSeqRef.current.set(songKey, seq);
    const isLatest = () => patchSeqRef.current.get(songKey) === seq;

    let previousMeta: SongMetaRecord | null = null;
    setSongs((prev) =>
      prev.map((s) => {
        if (s.songKey !== songKey) return s;
        previousMeta = s.meta;
        return { ...s, meta: mergePatch(s.meta, songKey, patch) };
      })
    );

    try {
      const serverMeta = await patchSongMeta(songKey, patch);
      if (!isLatest()) return; // superseded by a later patch for this song
      setSongs((prev) => prev.map((s) => (s.songKey === songKey ? { ...s, meta: serverMeta } : s)));
    } catch {
      if (!isLatest()) return; // a newer patch already replaced this state; don't roll back over it
      setSongs((prev) => prev.map((s) => (s.songKey === songKey ? { ...s, meta: previousMeta } : s)));
    }
  }

  const listenedOptions: Array<{ key: ListenedFilter; label: string }> = [
    { key: 'all', label: t.filmsFilterAll },
    { key: 'listened', label: t.songsFilterListened },
    { key: 'unlistened', label: t.songsFilterUnlistened },
  ];

  const downloadedOptions: Array<{ key: DownloadedFilter; label: string }> = [
    { key: 'all', label: t.filmsFilterAll },
    { key: 'yes', label: t.songsFilterDownloaded },
    { key: 'no', label: t.songsFilterNotDownloaded },
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
          <div className="films-filter-bar">
            {genres.map((genre) => (
              <button
                key={genre}
                type="button"
                className={`genre-chip ${genreFilter.includes(genre) ? 'active' : ''}`}
                onClick={() => toggleGenre(genre)}
              >
                {genre}
              </button>
            ))}
            <span className="filter-segment-group">
              <span className="filter-segment-label">{t.songsListenedFilterLabel}</span>
              <div className="filter-segment">
                {listenedOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={listenedFilter === opt.key ? 'active' : ''}
                    onClick={() => setListenedFilter(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </span>
            <button
              type="button"
              className={`genre-chip ${favoriteOnly ? 'active' : ''}`}
              onClick={() => setFavoriteOnly((v) => !v)}
            >
              ⭐ {t.songsFilterFavorites}
            </button>
            <span className="filter-segment-group">
              <span className="filter-segment-label">{t.songsDownloadedFilterLabel}</span>
              <div className="filter-segment">
                {downloadedOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={downloadedFilter === opt.key ? 'active' : ''}
                    onClick={() => setDownloadedFilter(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </span>
            <span className="filter-result-count">{visible.length}</span>
          </div>
        )}

        {loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="list-page-empty">{t.noSongsYet}</div>
        ) : (
          visible.map((song) => (
            <SongCard
              key={song.songKey}
              song={song}
              onPatch={(patch) => {
                void applyPatch(song.songKey, patch);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
