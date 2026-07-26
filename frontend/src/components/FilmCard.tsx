import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import { ratingFromScore } from '../utils/filmRating';
import type { AggregatedFilm, AvailabilityStatus, StreamingPlatformOption, StreamingUrls } from '../types';
import type { FilmMetaPatchBody } from '../services/api';

interface FilmCardProps {
  film: AggregatedFilm;
  onPatch: (patch: FilmMetaPatchBody) => void;
  onRefreshStreaming: () => Promise<void>;
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

/** Badge color class for an API-reported streaming option, by type. */
function streamBadgeClass(type: StreamingPlatformOption['type']): string {
  if (type === 'FREE') return 'stream-free';
  if (type === 'SUBSCRIPTION') return 'stream-sub';
  return 'stream-paid'; // RENTAL / PURCHASE
}

/**
 * Best-effort match between an API platform name (e.g. "Prime Video") and one
 * of our known manual-dot services (e.g. label "Prime"), so the existing
 * manual override dot can still be placed next to the right API badge.
 */
function matchService(platform: string): (typeof SERVICES)[number] | undefined {
  const lower = platform.toLowerCase();
  return SERVICES.find((svc) => lower.includes(svc.label.toLowerCase()));
}

/** One deduplicated film row: poster, TMDb metadata, ratings and streaming availability. */
export function FilmCard({ film, onPatch, onRefreshStreaming }: FilmCardProps) {
  const { t } = useLanguage();
  const meta = film.meta;
  // Slider position while dragging; null when idle (shows the stored score).
  const [sliderDraft, setSliderDraft] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const sliderValue = sliderDraft ?? meta?.score ?? 50;

  async function handleRefreshStreaming() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshStreaming();
    } finally {
      setRefreshing(false);
    }
  }

  function commitSlider() {
    if (sliderDraft == null) return;
    const value = sliderDraft;
    setSliderDraft(null);
    if (value === meta?.score) return;
    // Explicit 🍅/🤢 clicks win; the slider only derives a rating in its
    // outer zones (<20 rotten, >80 fresh) — mid-range keeps the current one.
    const derived = ratingFromScore(value);
    const patch: FilmMetaPatchBody = { score: value };
    if (derived) patch.rating = derived;
    onPatch(patch);
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
          <button
            type="button"
            className={`watched-toggle ${meta?.watched ? 'active' : ''}`}
            title={t.filmsMarkWatched}
            onClick={() => onPatch({ watched: !(meta?.watched ?? false) })}
          >
            👁
          </button>
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
            className={`rating-btn ${meta?.rating === 'rotten' ? 'active' : ''}`}
            title={t.filmsMarkRotten}
            onClick={() => onPatch({ rating: meta?.rating === 'rotten' ? null : 'rotten' })}
          >
            🤢
          </button>
          <input
            type="range"
            className="rating-slider"
            min={0}
            max={100}
            step={1}
            value={sliderValue}
            aria-label={t.filmsMarkFresh}
            onChange={(e) => setSliderDraft(Number(e.target.value))}
            onPointerUp={commitSlider}
            onKeyUp={commitSlider}
            onBlur={commitSlider}
          />
          <button
            type="button"
            className={`rating-btn ${meta?.rating === 'fresh' ? 'active' : ''}`}
            title={t.filmsMarkFresh}
            onClick={() => onPatch({ rating: meta?.rating === 'fresh' ? null : 'fresh' })}
          >
            🍅
          </button>
          <span className={`rating-score-label ${meta?.score == null && sliderDraft == null ? 'unset' : ''}`}>
            {sliderDraft ?? meta?.score ?? '—'}
            {(sliderDraft != null || meta?.score != null) && '%'}
          </span>
        </div>

        <div className="list-item-badges">
          {film.imdbUrl && (
            <a href={film.imdbUrl} target="_blank" rel="noopener noreferrer" className="badge-link imdb">
              IMDb
            </a>
          )}
          {meta?.streamingOptions && meta.streamingOptions.length > 0
            ? meta.streamingOptions.map((option, idx) => {
                const matchedSvc = matchService(option.platform);
                const status = matchedSvc ? meta?.availability?.[matchedSvc.key] ?? null : null;
                const overrideClass = status ? `manual-override-${status}` : '';
                const priceSuffix =
                  (option.type === 'RENTAL' || option.type === 'PURCHASE') && option.price != null
                    ? ` € ${option.price.toFixed(2)}`
                    : '';
                return (
                  <span key={`${option.platform}-${option.type}-${idx}`} className="film-service">
                    <a
                      href={option.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`badge-link ${streamBadgeClass(option.type)} ${overrideClass}`.trim()}
                      title={option.type}
                    >
                      {option.platform}
                      {priceSuffix}
                    </a>
                    {matchedSvc && (
                      <button
                        type="button"
                        className={`avail-dot ${status ?? 'unknown'}`}
                        title={t.filmsAvailabilityHint}
                        onClick={() => {
                          const current = meta?.availability?.[matchedSvc.key] ?? null;
                          const cycleIdx = AVAILABILITY_CYCLE.indexOf(current);
                          const next = AVAILABILITY_CYCLE[(cycleIdx + 1) % AVAILABILITY_CYCLE.length];
                          onPatch({ availability: { [matchedSvc.key]: next } });
                        }}
                      />
                    )}
                  </span>
                );
              })
            : SERVICES.map((svc) => {
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
          <button
            type="button"
            className="stream-refresh"
            title={t.filmsRefreshStreaming}
            disabled={refreshing}
            onClick={() => void handleRefreshStreaming()}
          >
            ↻
          </button>
        </div>
      </div>

      <Link to={`/?entry=${film.mentions[0].entryId}`} className="list-item-action">
        ×{film.mentions.length} {t.filmsMentions}
      </Link>
    </div>
  );
}
