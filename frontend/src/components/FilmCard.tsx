import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import type { Translations } from '../i18n';
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
export function streamBadgeClass(type: StreamingPlatformOption['type']): string {
  if (type === 'FREE') return 'stream-free';
  if (type === 'SUBSCRIPTION') return 'stream-sub';
  return 'stream-paid'; // RENTAL / PURCHASE
}

/** Localized badge title, by type. */
export function streamTypeLabel(type: StreamingPlatformOption['type'], t: Translations): string {
  if (type === 'FREE') return t.filmsStreamFree;
  if (type === 'SUBSCRIPTION') return t.filmsStreamSub;
  if (type === 'RENTAL') return t.filmsStreamRent;
  return t.filmsStreamBuy; // PURCHASE
}

// Explicit per-service alias lists (not the short display labels in SERVICES,
// which are too ambiguous to substring-match against real API platform names:
// 'D+' never appears in "Disney Plus"/"Disney+", and 'TV' false-positives on
// "Rakuten TV" / "ITVX"). Matching a display label is a UI concern; matching a
// real-world platform name is a data concern, and they diverge.
const SERVICE_ALIASES: Record<keyof StreamingUrls, string[]> = {
  netflix: ['netflix'],
  primeVideo: ['prime video', 'amazon prime', 'prime'],
  raiPlay: ['raiplay', 'rai play'],
  now: ['now tv', 'now'],
  disneyPlus: ['disney plus', 'disney+', 'disney'],
  appleTv: ['apple tv', 'itunes'],
};

// Flattened (service, alias) pairs, longest alias first, so a more specific
// alias ("now tv", "amazon prime") is checked before a shorter one that could
// otherwise over-match ("now", "prime") on an unrelated platform name.
const ALIAS_ENTRIES: Array<{ key: keyof StreamingUrls; alias: string }> = (
  Object.entries(SERVICE_ALIASES) as Array<[keyof StreamingUrls, string[]]>
)
  .flatMap(([key, aliases]) => aliases.map((alias) => ({ key, alias })))
  .sort((a, b) => b.alias.length - a.alias.length);

// True when `alias` occurs in `lower` as a whole word/phrase — not merely as
// a substring. Plain `.includes()` over-matches badly: 'now' inside
// "Snowpiercer TV" ('s-now-piercer'), or 'prime' inside "Primetime Channel".
// We can't use `\b` here because '+' (as in "disney+"/"paramount+") is a
// non-word character, so `\bdisney\+\b` doesn't behave predictably around
// it; an explicit non-alphanumeric-or-edge boundary class handles both plain
// words and aliases ending in '+' the same way.
function aliasMatches(lower: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(lower);
}

/**
 * Best-effort match between an API platform name (e.g. "Amazon Prime Video")
 * and one of our known manual-dot services, so the existing manual override
 * dot can still be placed next to the right API badge. Platforms that don't
 * resemble any known service (e.g. "Rakuten TV", "Paramount+", "Snowpiercer
 * TV", "Primetime Channel") return `undefined` — by design, they render a
 * badge with no adjacent dot.
 */
export function matchService(platform: string): keyof StreamingUrls | undefined {
  const lower = platform.toLowerCase();
  return ALIAS_ENTRIES.find(({ alias }) => aliasMatches(lower, alias))?.key;
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
                const matchedKey = matchService(option.platform);
                const status = matchedKey ? meta?.availability?.[matchedKey] ?? null : null;
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
                      title={streamTypeLabel(option.type, t)}
                    >
                      {option.platform}
                      {priceSuffix}
                    </a>
                    {matchedKey && (
                      <button
                        type="button"
                        className={`avail-dot ${status ?? 'unknown'}`}
                        title={t.filmsAvailabilityHint}
                        onClick={() => {
                          const current = meta?.availability?.[matchedKey] ?? null;
                          const cycleIdx = AVAILABILITY_CYCLE.indexOf(current);
                          const next = AVAILABILITY_CYCLE[(cycleIdx + 1) % AVAILABILITY_CYCLE.length];
                          onPatch({ availability: { [matchedKey]: next } });
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
