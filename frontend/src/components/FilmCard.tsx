import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import type { AggregatedFilm, AvailabilityStatus, StreamingUrls } from '../types';
import type { FilmMetaPatchBody } from '../services/api';

interface FilmCardProps {
  film: AggregatedFilm;
  /** Whether the score input is currently open for this film. */
  scoreEditing: boolean;
  onStartScoreEdit: () => void;
  onStopScoreEdit: () => void;
  onPatch: (patch: FilmMetaPatchBody) => void;
}

const SERVICES: Array<{ key: keyof StreamingUrls; label: string; className: string }> = [
  { key: 'netflix', label: 'Netflix', className: 'netflix' },
  { key: 'primeVideo', label: 'Prime', className: 'prime' },
  { key: 'raiPlay', label: 'Rai', className: 'raiplay' },
  { key: 'now', label: 'NOW', className: 'now' },
  { key: 'disneyPlus', label: 'D+', className: 'disney' },
  { key: 'appleTv', label: 'TV', className: 'appletv' },
];

const AVAILABILITY_CYCLE: Array<AvailabilityStatus | null> = [null, 'free', 'paid', 'absent'];

/** One deduplicated film row: poster, TMDb metadata, ratings and streaming availability. */
export function FilmCard({ film, scoreEditing, onStartScoreEdit, onStopScoreEdit, onPatch }: FilmCardProps) {
  const { t } = useLanguage();
  const meta = film.meta;
  const [scoreDraft, setScoreDraft] = useState('');
  // Enter/blur both try to commit; guards against double-handling when the
  // input unmounts (React can fire blur right after a keydown-triggered close).
  const handledRef = useRef(false);

  useEffect(() => {
    if (scoreEditing) {
      handledRef.current = false;
      setScoreDraft(meta?.score != null ? String(meta.score) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreEditing]);

  function finishScoreEdit(commit: boolean) {
    if (handledRef.current) return;
    handledRef.current = true;
    if (commit) {
      const trimmed = scoreDraft.trim();
      const parsed = Number(trimmed);
      if (trimmed !== '' && Number.isFinite(parsed)) {
        const clamped = Math.max(0, Math.min(100, Math.round(parsed)));
        if (clamped !== meta?.score) onPatch({ score: clamped });
      }
    }
    onStopScoreEdit();
  }

  return (
    <div className="list-item-row">
      {film.posterUrl ? (
        <img src={film.posterUrl} alt="" className="list-item-poster" loading="lazy" />
      ) : (
        <div className="list-item-icon">🎬</div>
      )}
      <div className="list-item-content">
        <div className="list-item-title">
          {film.title}
          {meta?.tmdbScore != null && (
            <span className="film-score" title={t.filmsTmdbScore}>★ {meta.tmdbScore.toFixed(1)}</span>
          )}
        </div>
        <div className="list-item-subtitle">
          {film.director && <span>{t.director}: {film.director}</span>}
          {film.year && <span className="list-item-muted"> ({film.year})</span>}
        </div>

        {meta && meta.genres.length > 0 && (
          <div className="list-item-badges">
            {meta.genres.map((g) => (
              <span key={g} className="genre-badge">{g}</span>
            ))}
          </div>
        )}

        {meta?.overview && <p className="film-overview">{meta.overview}</p>}
        {meta && meta.cast.length > 0 && <div className="film-cast">{meta.cast.join(', ')}</div>}

        <div className="film-controls">
          <button
            type="button"
            className={`rating-btn ${meta?.rating === 'fresh' ? 'active' : ''}`}
            title={t.filmsMarkFresh}
            onClick={() => onPatch({ rating: meta?.rating === 'fresh' ? null : 'fresh' })}
          >
            🍅
          </button>
          <button
            type="button"
            className={`rating-btn ${meta?.rating === 'rotten' ? 'active' : ''}`}
            title={t.filmsMarkRotten}
            onClick={() => onPatch({ rating: meta?.rating === 'rotten' ? null : 'rotten' })}
          >
            🤢
          </button>
          <button
            type="button"
            className={`rating-btn ${meta?.watched ? 'active' : ''}`}
            title={t.filmsMarkWatched}
            onClick={() => onPatch({ watched: !(meta?.watched ?? false) })}
          >
            👁
          </button>

          {meta?.rating && (
            scoreEditing ? (
              <input
                type="number"
                className="score-input"
                min={0}
                max={100}
                autoFocus
                value={scoreDraft}
                placeholder={t.filmsScorePlaceholder}
                onChange={(e) => setScoreDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') finishScoreEdit(true);
                  else if (e.key === 'Escape') finishScoreEdit(false);
                }}
                onBlur={() => finishScoreEdit(true)}
              />
            ) : (
              <button type="button" className="score-btn" onClick={onStartScoreEdit}>
                {meta.score != null ? `${meta.score}${t.filmsScorePlaceholder}` : t.filmsScorePlaceholder}
              </button>
            )
          )}
        </div>

        <div className="list-item-badges">
          {film.imdbUrl && (
            <a href={film.imdbUrl} target="_blank" rel="noopener noreferrer" className="badge-link imdb">
              IMDb
            </a>
          )}
          {SERVICES.map((svc) => {
            const href = film.streamingUrls?.[svc.key];
            if (!href) return null;
            const status = meta?.availability?.[svc.key] ?? null;
            return (
              <span key={svc.key} className="film-service">
                <a href={href} target="_blank" rel="noopener noreferrer" className={`badge-link ${svc.className}`}>
                  {svc.label}
                </a>
                <button
                  type="button"
                  className={`avail-dot ${status ?? 'unknown'}`}
                  title={t.filmsAvailabilityHint}
                  onClick={() => {
                    const current = meta?.availability?.[svc.key] ?? null;
                    const idx = AVAILABILITY_CYCLE.indexOf(current);
                    const next = AVAILABILITY_CYCLE[(idx + 1) % AVAILABILITY_CYCLE.length];
                    onPatch({ availability: { [svc.key]: next } });
                  }}
                />
              </span>
            );
          })}
        </div>
      </div>

      <Link to={`/?entry=${film.mentions[0].entryId}`} className="list-item-action">
        ×{film.mentions.length} {t.filmsMentions}
      </Link>
    </div>
  );
}
