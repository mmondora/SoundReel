import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { SongCard } from '../components/SongCard';
import { FilterPanel } from '../components/FilterPanel';
import type { FilterSection } from '../components/FilterPanel';
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
  const [textFilter, setTextFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  const [listenedFilter, setListenedFilter] = useState<ListenedFilter>('all');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [downloadedFilter, setDownloadedFilter] = useState<DownloadedFilter>('all');
  const [panelOpen, setPanelOpen] = useState(false);
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
        text: textFilter,
      }),
    [sortedSongs, genreFilter, listenedFilter, favoriteOnly, downloadedFilter, textFilter]
  );

  function toggleGenre(genre: string) {
    setGenreFilter((prev) => (prev.includes(genre) ? prev.filter((g) => g !== genre) : [...prev, genre]));
  }

  function resetFilters() {
    setGenreFilter([]);
    setListenedFilter('all');
    setFavoriteOnly(false);
    setDownloadedFilter('all');
  }

  // Non-default filters count toward the "Filtri (n)" badge; text search is excluded on purpose.
  const activeFilterCount =
    genreFilter.length +
    (listenedFilter !== 'all' ? 1 : 0) +
    (favoriteOnly ? 1 : 0) +
    (downloadedFilter !== 'all' ? 1 : 0);

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

  const listenedLabel = listenedOptions.find((o) => o.key === listenedFilter)?.label ?? '';
  const downloadedLabel = downloadedOptions.find((o) => o.key === downloadedFilter)?.label ?? '';

  const filterSections: FilterSection[] = [
    { kind: 'chips', label: t.genreSectionLabel, options: genres, selected: genreFilter, onToggle: toggleGenre },
    { kind: 'radio', label: t.songsListenedFilterLabel, options: listenedOptions, value: listenedFilter, onChange: (v) => setListenedFilter(v as ListenedFilter) },
    { kind: 'toggle', label: `⭐ ${t.songsFilterFavorites}`, value: favoriteOnly, onChange: setFavoriteOnly },
    { kind: 'radio', label: t.songsDownloadedFilterLabel, options: downloadedOptions, value: downloadedFilter, onChange: (v) => setDownloadedFilter(v as DownloadedFilter) },
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
          <>
            <div className="filter-topbar">
              <input
                type="text"
                className="filter-search"
                placeholder={`🔍 ${t.searchPlaceholder}`}
                value={textFilter}
                onChange={(e) => setTextFilter(e.target.value)}
              />
              <span className="filter-result-count">{visible.length}</span>
              <button type="button" className="filter-open-btn" onClick={() => setPanelOpen(true)}>
                {t.filtersButton}{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </button>
            </div>

            {activeFilterCount > 0 && (
              <div className="active-chips">
                {genreFilter.map((genre) => (
                  <button key={genre} type="button" className="genre-chip active" onClick={() => toggleGenre(genre)}>
                    {genre} ×
                  </button>
                ))}
                {listenedFilter !== 'all' && (
                  <button type="button" className="genre-chip active" onClick={() => setListenedFilter('all')}>
                    {listenedLabel} ×
                  </button>
                )}
                {favoriteOnly && (
                  <button type="button" className="genre-chip active" onClick={() => setFavoriteOnly(false)}>
                    ⭐ {t.songsFilterFavorites} ×
                  </button>
                )}
                {downloadedFilter !== 'all' && (
                  <button type="button" className="genre-chip active" onClick={() => setDownloadedFilter('all')}>
                    {downloadedLabel} ×
                  </button>
                )}
              </div>
            )}

            <FilterPanel
              open={panelOpen}
              onClose={() => setPanelOpen(false)}
              title={t.filtersTitle}
              onReset={resetFilters}
              resetLabel={t.filtersReset}
              sections={filterSections}
            />
          </>
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
