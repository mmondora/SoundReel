import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Header } from '../components/Header';
import { SongCard } from '../components/SongCard';
import { DateGroupedList } from '../components/DateGroupedList';
import { FilterPanel } from '../components/FilterPanel';
import type { FilterSection } from '../components/FilterPanel';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { PlaylistPanel, removeFromActivePlaylist } from '../components/PlaylistPanel';
import { ElsewhereHint } from '../components/library/ElsewhereHint';
import { LibrarySearchResults } from '../components/library/LibrarySearchResults';
import { ScopeSelect } from '../components/library/ScopeSelect';
import { useLibrarySearch } from '../hooks/useLibrarySearch';
import { fetchSongs, patchSongMeta } from '../services/api';
import type { SongMetaPatchBody } from '../services/api';
import { filterSongs, collectGenres, sortSongs } from '../utils/songFilters';
import type { ListenedFilter, DownloadedFilter, SongSortMode } from '../utils/songFilters';
import { useLanguage } from '../i18n';
import { usePlayer } from '../player/PlayerContext';
import { canSearch, scopeCount } from '../utils/librarySearch';
import type { AggregatedSong, LibraryScope, PlaylistDetail, SongMetaRecord } from '../types';

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
  const { t } = useLanguage();
  const navigate = useNavigate();
  const player = usePlayer();

  const [songs, setSongs] = useState<AggregatedSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [textFilter, setTextFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  const [listenedFilter, setListenedFilter] = useState<ListenedFilter>('all');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [downloadedFilter, setDownloadedFilter] = useState<DownloadedFilter>('all');
  const [panelOpen, setPanelOpen] = useState(false);
  const [sortMode, setSortMode] = useState<SongSortMode>('date');
  // "Cerca in": the journal songs (the page as it always was) or the files — media server, local folders, both.
  const [scope, setScope] = useState<LibraryScope>('songs');
  const search = useLibrarySearch(textFilter);
  const [activePlaylist, setActivePlaylist] = useState<PlaylistDetail | null>(null);
  const [songToAdd, setSongToAdd] = useState<string | null>(null);
  // Per-songKey monotonic counter so a slow/out-of-order PATCH response
  // (success or failure) can never clobber a newer patch already applied to
  // that song.
  const patchSeqRef = useRef(new Map<string, number>());

  useEffect(() => {
    fetchSongs().then(setSongs).catch(() => setSongs([])).finally(() => setLoading(false));
  }, []);

  const sortedSongs = useMemo(() => sortSongs(songs, sortMode), [songs, sortMode]);

  const genres = useMemo(() => collectGenres(sortedSongs), [sortedSongs]);
  const visible = useMemo(() => {
    let list = filterSongs(sortedSongs, {
      genres: genreFilter,
      listened: listenedFilter,
      favorite: favoriteOnly,
      downloaded: downloadedFilter,
      text: textFilter,
    });
    if (activePlaylist) {
      // Keep playlist order when browsing a playlist.
      const byKey = new Map(list.map((s) => [s.songKey, s]));
      list = activePlaylist.songKeys
        .map((k) => byKey.get(k))
        .filter((s): s is AggregatedSong => !!s);
    }
    return list;
  }, [sortedSongs, genreFilter, listenedFilter, favoriteOnly, downloadedFilter, textFilter, activePlaylist]);

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
    (downloadedFilter !== 'all' ? 1 : 0) +
    (activePlaylist ? 1 : 0);

  function handlePlaylistSelect(playlist: PlaylistDetail | null) {
    setActivePlaylist(playlist);
  }

  async function handleRemoveFromPlaylist(songKey: string) {
    if (!activePlaylist) return;
    try {
      const updated = await removeFromActivePlaylist(activePlaylist.id, songKey);
      setActivePlaylist(updated);
    } catch {
      // leave list as-is; panel shows its own errors on other actions
    }
  }

  function playActivePlaylist() {
    if (!activePlaylist || visible.length === 0) return;
    player.playSong(visible[0].songKey, visible, activePlaylist.name);
    navigate('/player');
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

  const showingFiles = scope !== 'songs';
  // The counts belong to the text now typed; while a newer search runs they are not shown (they would be stale).
  const counts = search.data && !search.stale ? search.data.counts : null;

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
      <Header />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allSongs}</h1>
          <Link to="/player" className="songs-open-player">{t.playerOpen}</Link>
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
              <ScopeSelect value={scope} onChange={setScope} counts={counts} />
              <span className="filter-result-count">
                {showingFiles ? (counts ? scopeCount(counts, scope) : 0) : visible.length}
              </span>
              {!showingFiles && (
                <>
                  <select
                    className="sort-select"
                    value={sortMode}
                    aria-label={t.sortLabel}
                    onChange={(e) => setSortMode(e.target.value as SongSortMode)}
                  >
                    <option value="date">{t.sortByDate}</option>
                    <option value="mentions">{t.sortByMentions}</option>
                    <option value="artist">{t.sortByArtist}</option>
                  </select>
                  <button type="button" className="filter-open-btn" onClick={() => setPanelOpen(true)}>
                    {t.filtersButton}{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                  </button>
                </>
              )}
            </div>

            {showingFiles && (
              <LibrarySearchResults search={search} scope={scope} text={textFilter} onScope={setScope} />
            )}

            {!showingFiles && visible.length === 0 && counts && canSearch(textFilter) && (
              <ElsewhereHint counts={counts} current="songs" onPick={setScope} />
            )}

            {!showingFiles && activeFilterCount > 0 && (
              <div className="active-chips">
                {activePlaylist && (
                  <button type="button" className="genre-chip active" onClick={() => setActivePlaylist(null)}>
                    {t.playlistActiveChip}: {activePlaylist.name} ×
                  </button>
                )}
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

            {!showingFiles && (
              <FilterPanel
                open={panelOpen}
                onClose={() => setPanelOpen(false)}
                title={t.filtersTitle}
                onReset={resetFilters}
                resetLabel={t.filtersReset}
                sections={filterSections}
              />
            )}

            {!showingFiles && (
              <PlaylistPanel
                activeId={activePlaylist?.id ?? null}
                onSelect={handlePlaylistSelect}
              />
            )}

            {songToAdd && (
              <AddToPlaylistModal
                songKey={songToAdd}
                songLabel={
                  (() => {
                    const s = songs.find((x) => x.songKey === songToAdd);
                    return s ? `${s.title} — ${s.artist || '—'}` : undefined;
                  })()
                }
                onClose={() => setSongToAdd(null)}
                onDone={(pl) => {
                  if (activePlaylist?.id === pl.id) setActivePlaylist(pl);
                }}
              />
            )}

            {!showingFiles && activePlaylist && visible.length > 0 && (
              <div className="playlist-play-row">
                <button type="button" className="player-play-all" onClick={playActivePlaylist}>
                  {t.playlistPlay} · {activePlaylist.name}
                </button>
              </div>
            )}
          </>
        )}

        {showingFiles ? null : loading ? (
          <div className="journal-loading">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="list-page-empty">{t.noSongsYet}</div>
        ) : sortMode === 'date' && !activePlaylist ? (
          <DateGroupedList
            items={visible}
            pageSize={50}
            getDate={(song) => (song.mentions[0] ? new Date(song.mentions[0].createdAt) : null)}
            renderItem={(song) => (
              <SongCard
                key={song.songKey}
                song={song}
                onPatch={(patch) => {
                  void applyPatch(song.songKey, patch);
                }}
                onAddToPlaylist={setSongToAdd}
                onRemoveFromPlaylist={activePlaylist ? handleRemoveFromPlaylist : undefined}
              />
            )}
          />
        ) : (
          visible.map((song) => (
            <SongCard
              key={song.songKey}
              song={song}
              onPatch={(patch) => {
                void applyPatch(song.songKey, patch);
              }}
              onAddToPlaylist={setSongToAdd}
              onRemoveFromPlaylist={activePlaylist ? handleRemoveFromPlaylist : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}
