import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { FilmCard } from '../components/FilmCard';
import { DateGroupedList } from '../components/DateGroupedList';
import { FilterPanel } from '../components/FilterPanel';
import type { FilterSection } from '../components/FilterPanel';
import { fetchFilms, patchFilmMeta, refreshFilmStreaming, archiveLookupFilm, archiveDownloadFilm } from '../services/api';
import type { FilmMetaPatchBody } from '../services/api';
import { filterFilms, collectGenres, sortFilms } from '../utils/filmFilters';
import type { WatchedFilter, AvailabilityFilter, FilmSortMode } from '../utils/filmFilters';
import { useAllEntries } from '../hooks/useJournal';
import { useLanguage } from '../i18n';
import type { AggregatedFilm, FilmMetaRecord, JournalStats, StreamingUrls } from '../types';

function createDefaultMeta(filmKey: string): FilmMetaRecord {
  return {
    filmKey,
    tmdbId: null,
    genres: [],
    overview: null,
    cast: [],
    tmdbScore: null,
    watched: false,
    rating: null,
    score: null,
    availability: {},
    streamingOptions: null,
    streamingCheckedAt: null,
    watchmodeTitleId: null,
    iaIdentifier: null,
    iaTitle: null,
    iaYear: null,
    iaPageUrl: null,
    iaFileUrl: null,
    iaCheckedAt: null,
    iaDownloadedPath: null,
  };
}

/** Applies a patch to a film's local meta the same way the backend would, for optimistic updates. */
export function mergePatch(meta: FilmMetaRecord | null, filmKey: string, patch: FilmMetaPatchBody): FilmMetaRecord {
  const next: FilmMetaRecord = { ...(meta ?? createDefaultMeta(filmKey)) };

  if (patch.watched !== undefined) next.watched = patch.watched;
  if (patch.rating !== undefined) next.rating = patch.rating;
  if (patch.score !== undefined) next.score = patch.score;
  // Rating or a score always implies the film has been watched.
  if ((patch.rating !== undefined && patch.rating !== null) || (patch.score !== undefined && patch.score !== null)) {
    next.watched = true;
  }
  if (patch.availability) {
    const availability = { ...next.availability };
    for (const [key, value] of Object.entries(patch.availability)) {
      const svcKey = key as keyof StreamingUrls;
      if (value == null) delete availability[svcKey];
      else availability[svcKey] = value;
    }
    next.availability = availability;
  }

  return next;
}

export function FilmsPage() {
  const { entries } = useAllEntries();
  const { t } = useLanguage();

  const [films, setFilms] = useState<AggregatedFilm[]>([]);
  const [loading, setLoading] = useState(true);
  const [textFilter, setTextFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>('all');
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>('all');
  const [panelOpen, setPanelOpen] = useState(false);
  const [sortMode, setSortMode] = useState<FilmSortMode>('date');
  // Per-filmKey monotonic counter so a slow/out-of-order PATCH response (success
  // or failure) can never clobber a newer patch already applied to that film.
  const patchSeqRef = useRef(new Map<string, number>());

  useEffect(() => {
    fetchFilms().then(setFilms).catch(() => setFilms([])).finally(() => setLoading(false));
  }, []);

  const stats: JournalStats = {
    totalEntries: entries.length,
    totalSongs: entries.reduce((acc, e) => acc + e.results.songs.length, 0),
    totalFilms: entries.reduce((acc, e) => acc + e.results.films.length, 0),
    totalNotes: entries.reduce((acc, e) => acc + (e.results.notes?.length || 0), 0),
  };

  const sortedFilms = useMemo(() => sortFilms(films, sortMode), [films, sortMode]);

  const genres = useMemo(() => collectGenres(sortedFilms), [sortedFilms]);
  const visible = useMemo(
    () =>
      filterFilms(sortedFilms, {
        genres: genreFilter,
        watched: watchedFilter,
        availability: availabilityFilter,
        text: textFilter,
      }),
    [sortedFilms, genreFilter, watchedFilter, availabilityFilter, textFilter]
  );

  function toggleGenre(genre: string) {
    setGenreFilter((prev) => (prev.includes(genre) ? prev.filter((g) => g !== genre) : [...prev, genre]));
  }

  function resetFilters() {
    setGenreFilter([]);
    setWatchedFilter('all');
    setAvailabilityFilter('all');
  }

  // Non-default filters count toward the "Filtri (n)" badge; text search is excluded on purpose.
  const activeFilterCount =
    genreFilter.length + (watchedFilter !== 'all' ? 1 : 0) + (availabilityFilter !== 'all' ? 1 : 0);

  // Optimistic patch: apply locally, PATCH, roll back on failure. Rollback and
  // the success write are both scoped to this one film's meta (never the whole
  // array) and guarded by a per-filmKey sequence number so a response that
  // arrives after a newer patch for the same film can't overwrite it.
  async function applyPatch(filmKey: string, patch: FilmMetaPatchBody) {
    const seq = (patchSeqRef.current.get(filmKey) ?? 0) + 1;
    patchSeqRef.current.set(filmKey, seq);
    const isLatest = () => patchSeqRef.current.get(filmKey) === seq;

    let previousMeta: FilmMetaRecord | null = null;
    setFilms((prev) =>
      prev.map((f) => {
        if (f.filmKey !== filmKey) return f;
        previousMeta = f.meta;
        return { ...f, meta: mergePatch(f.meta, filmKey, patch) };
      })
    );

    try {
      const serverMeta = await patchFilmMeta(filmKey, patch);
      if (!isLatest()) return; // superseded by a later patch for this film
      setFilms((prev) => prev.map((f) => (f.filmKey === filmKey ? { ...f, meta: serverMeta } : f)));
    } catch {
      if (!isLatest()) return; // a newer patch already replaced this state; don't roll back over it
      setFilms((prev) => prev.map((f) => (f.filmKey === filmKey ? { ...f, meta: previousMeta } : f)));
    }
  }

  // Shared success-path merge for handlers that just replace a film's meta
  // wholesale with whatever the server returned (refresh/lookup/download —
  // none of them have a meaningful optimistic state to apply beforehand).
  function applyServerMeta(filmKey: string, meta: FilmMetaRecord) {
    setFilms((prev) => prev.map((f) => (f.filmKey === filmKey ? { ...f, meta } : f)));
  }

  // On-demand streaming availability refresh. No optimistic change — nothing
  // local is known until the server responds — but still seq-guarded like
  // applyPatch so a slow response can't clobber a newer update for this film.
  async function refreshStreaming(filmKey: string) {
    const seq = (patchSeqRef.current.get(filmKey) ?? 0) + 1;
    patchSeqRef.current.set(filmKey, seq);
    const isLatest = () => patchSeqRef.current.get(filmKey) === seq;

    try {
      const serverMeta = await refreshFilmStreaming(filmKey);
      if (!isLatest()) return; // superseded by a later patch/refresh for this film
      applyServerMeta(filmKey, serverMeta);
    } catch (err) {
      // Not configured (503), no IMDb id (404), or a provider error (500) —
      // all silently no-op per the pipeline resilience convention.
      console.warn('refresh streaming availability failed', filmKey, err);
    }
  }

  // Manual per-film Internet Archive lookup/download. Same no-optimistic-state
  // shape as refreshStreaming; errors are logged and leave the card usable.
  async function archiveLookup(filmKey: string) {
    try {
      const serverMeta = await archiveLookupFilm(filmKey);
      applyServerMeta(filmKey, serverMeta);
    } catch (e) {
      console.error('archive lookup failed', e);
    }
  }

  async function archiveDownload(filmKey: string) {
    try {
      const serverMeta = await archiveDownloadFilm(filmKey);
      applyServerMeta(filmKey, serverMeta);
    } catch (e) {
      console.error('archive download failed', e);
    }
  }

  const watchedOptions: Array<{ key: WatchedFilter; label: string }> = [
    { key: 'all', label: t.filmsFilterAll },
    { key: 'watched', label: t.filmsFilterWatched },
    { key: 'unwatched', label: t.filmsFilterUnwatched },
  ];

  const availabilityOptions: Array<{ key: AvailabilityFilter; label: string }> = [
    { key: 'all', label: t.filmsFilterAll },
    { key: 'free', label: t.filmsFilterFree },
    { key: 'notfree', label: t.filmsFilterNotFree },
  ];

  const watchedLabel = watchedOptions.find((o) => o.key === watchedFilter)?.label ?? '';
  const availabilityLabel = availabilityOptions.find((o) => o.key === availabilityFilter)?.label ?? '';

  const filterSections: FilterSection[] = [
    { kind: 'chips', label: t.genreSectionLabel, options: genres, selected: genreFilter, onToggle: toggleGenre },
    { kind: 'radio', label: t.filmsWatchedFilterLabel, options: watchedOptions, value: watchedFilter, onChange: (v) => setWatchedFilter(v as WatchedFilter) },
    { kind: 'radio', label: t.filmsAvailabilityFilterLabel, options: availabilityOptions, value: availabilityFilter, onChange: (v) => setAvailabilityFilter(v as AvailabilityFilter) },
  ];

  return (
    <div className="list-page">
      <Header stats={stats} />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allFilms}</h1>
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
              <select
                className="sort-select"
                value={sortMode}
                aria-label={t.sortLabel}
                onChange={(e) => setSortMode(e.target.value as FilmSortMode)}
              >
                <option value="date">{t.sortByDate}</option>
                <option value="mentions">{t.sortByMentions}</option>
                <option value="director">{t.sortByDirector}</option>
              </select>
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
                {watchedFilter !== 'all' && (
                  <button type="button" className="genre-chip active" onClick={() => setWatchedFilter('all')}>
                    {watchedLabel} ×
                  </button>
                )}
                {availabilityFilter !== 'all' && (
                  <button type="button" className="genre-chip active" onClick={() => setAvailabilityFilter('all')}>
                    {availabilityLabel} ×
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
          <div className="list-page-empty">{t.noFilmsYet}</div>
        ) : sortMode === 'date' ? (
          <DateGroupedList
            items={visible}
            pageSize={50}
            getDate={(film) => (film.mentions[0] ? new Date(film.mentions[0].createdAt) : null)}
            renderItem={(film) => (
              <FilmCard
                key={film.filmKey}
                film={film}
                onPatch={(patch) => {
                  void applyPatch(film.filmKey, patch);
                }}
                onRefreshStreaming={() => refreshStreaming(film.filmKey)}
                onArchiveLookup={() => archiveLookup(film.filmKey)}
                onArchiveDownload={() => archiveDownload(film.filmKey)}
              />
            )}
          />
        ) : (
          visible.map((film) => (
            <FilmCard
              key={film.filmKey}
              film={film}
              onPatch={(patch) => {
                void applyPatch(film.filmKey, patch);
              }}
              onRefreshStreaming={() => refreshStreaming(film.filmKey)}
              onArchiveLookup={() => archiveLookup(film.filmKey)}
              onArchiveDownload={() => archiveDownload(film.filmKey)}
            />
          ))
        )}

        <div className="data-attribution">
          Streaming data by{' '}
          <a href="https://www.watchmode.com/" target="_blank" rel="noopener noreferrer">Watchmode</a>
          {' · '}
          <Link to="/licenses">{t.licensesLink}</Link>
        </div>
      </div>
    </div>
  );
}
