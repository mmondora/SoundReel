import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { FilmCard } from '../components/FilmCard';
import { fetchFilms, patchFilmMeta, refreshFilmStreaming } from '../services/api';
import type { FilmMetaPatchBody } from '../services/api';
import { filterFilms, collectGenres } from '../utils/filmFilters';
import type { WatchedFilter, AvailabilityFilter } from '../utils/filmFilters';
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
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>('all');
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>('all');
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

  // Most recently mentioned film first (mentions are ordered newest-first by the backend).
  const sortedFilms = useMemo(() => {
    return [...films].sort((a, b) => {
      const aTime = a.mentions[0] ? new Date(a.mentions[0].createdAt).getTime() : 0;
      const bTime = b.mentions[0] ? new Date(b.mentions[0].createdAt).getTime() : 0;
      return bTime - aTime;
    });
  }, [films]);

  const genres = useMemo(() => collectGenres(sortedFilms), [sortedFilms]);
  const visible = useMemo(
    () => filterFilms(sortedFilms, { genres: genreFilter, watched: watchedFilter, availability: availabilityFilter }),
    [sortedFilms, genreFilter, watchedFilter, availabilityFilter]
  );

  function toggleGenre(genre: string) {
    setGenreFilter((prev) => (prev.includes(genre) ? prev.filter((g) => g !== genre) : [...prev, genre]));
  }

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
      setFilms((prev) => prev.map((f) => (f.filmKey === filmKey ? { ...f, meta: serverMeta } : f)));
    } catch (err) {
      // Not configured (503), no IMDb id (404), or a provider error (500) —
      // all silently no-op per the pipeline resilience convention.
      console.warn('refresh streaming availability failed', filmKey, err);
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

  return (
    <div className="list-page">
      <Header stats={stats} />
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.allFilms}</h1>
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
              <span className="filter-segment-label">{t.filmsWatchedFilterLabel}</span>
              <div className="filter-segment">
                {watchedOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={watchedFilter === opt.key ? 'active' : ''}
                    onClick={() => setWatchedFilter(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </span>
            <span className="filter-segment-group">
              <span className="filter-segment-label">{t.filmsAvailabilityFilterLabel}</span>
              <div className="filter-segment">
                {availabilityOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={availabilityFilter === opt.key ? 'active' : ''}
                    onClick={() => setAvailabilityFilter(opt.key)}
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
          <div className="list-page-empty">{t.noFilmsYet}</div>
        ) : (
          visible.map((film) => (
            <FilmCard
              key={film.filmKey}
              film={film}
              onPatch={(patch) => {
                void applyPatch(film.filmKey, patch);
              }}
              onRefreshStreaming={() => refreshStreaming(film.filmKey)}
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
