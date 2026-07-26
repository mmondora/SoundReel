import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { FilmCard } from '../components/FilmCard';
import { fetchFilms, patchFilmMeta } from '../services/api';
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
  };
}

/** Applies a patch to a film's local meta the same way the backend would, for optimistic updates. */
function mergePatch(meta: FilmMetaRecord | null, filmKey: string, patch: FilmMetaPatchBody): FilmMetaRecord {
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
  const [scoreEditing, setScoreEditing] = useState<string | null>(null);

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

  // Optimistic patch: apply locally, PATCH, roll back on failure.
  async function applyPatch(filmKey: string, patch: FilmMetaPatchBody) {
    const snapshot = films;
    setFilms((prev) =>
      prev.map((f) => (f.filmKey === filmKey ? { ...f, meta: mergePatch(f.meta, filmKey, patch) } : f))
    );

    try {
      const serverMeta = await patchFilmMeta(filmKey, patch);
      setFilms((prev) => prev.map((f) => (f.filmKey === filmKey ? { ...f, meta: serverMeta } : f)));
    } catch {
      setFilms(snapshot);
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
                className={`genre-chip ${genreFilter.includes(genre) ? 'active' : ''}`}
                onClick={() => toggleGenre(genre)}
              >
                {genre}
              </button>
            ))}
            <div className="filter-segment">
              {watchedOptions.map((opt) => (
                <button
                  key={opt.key}
                  className={watchedFilter === opt.key ? 'active' : ''}
                  onClick={() => setWatchedFilter(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="filter-segment">
              {availabilityOptions.map((opt) => (
                <button
                  key={opt.key}
                  className={availabilityFilter === opt.key ? 'active' : ''}
                  onClick={() => setAvailabilityFilter(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
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
              scoreEditing={scoreEditing === film.filmKey}
              onStartScoreEdit={() => setScoreEditing(film.filmKey)}
              onStopScoreEdit={() => setScoreEditing(null)}
              onPatch={(patch) => {
                void applyPatch(film.filmKey, patch);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
