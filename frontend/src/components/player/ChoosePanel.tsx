import { useId, useRef } from 'react';
import { PHONE_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useSheetFocus } from '../../hooks/useSheetFocus';
import { interpolate, useLanguage } from '../../i18n';
import type { PlaylistSummary } from '../../types';
import { activeFilterCount, countLabel, platformLabel } from '../../utils/managerSongs';
import type {
  DatasetFacets,
  ExtraDatasetFacets,
  FacetCounts,
  ManagerFilters,
  PlaceKind,
  StateFilter,
} from '../../utils/managerSongs';
import { NO_YEAR, decadeLabelFor } from '../../utils/songFacets';
import type { DecadeValue } from '../../utils/songFacets';
import { FacetGroup } from './FacetGroup';
import type { FacetOption } from './FacetGroup';
import '../../styles/choose.css';

export interface ChoosePanelProps {
  filters: ManagerFilters;
  onChange: (patch: Partial<ManagerFilters>) => void;
  onReset: () => void;
  /** Counts per value, each with every other filter applied (utils/managerSongs → facetCounts). */
  facets: FacetCounts;
  /** Which headings have any data at all (a heading nobody can fill is not drawn). */
  dataset: DatasetFacets & ExtraDatasetFacets;
  /** Songs the filters leave. */
  count: number;
  /** Songs before the filters (the shelf, or the playlist). */
  poolSize: number;
  playlists: readonly PlaylistSummary[];
  playlistId: string | null;
  onPlaylist: (id: string | null) => void;
  onPlay: () => void;
  onShuffle: () => void;
  /** Close the panel. On a phone it is a full-height sheet and also closes once a song is started. */
  onClose: () => void;
}

const toggled = <T,>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

const asOptions = (pairs: ReadonlyArray<readonly [string, number]>): FacetOption[] =>
  pairs.map(([label, count]) => ({ value: label, label, count }));

/**
 * "Scegli cosa suonare" (spec 2026-11-08-player-selection-and-filters-design.md X4): filters by type (genre), years
 * (decades: "Anni 80"), album and author — with the number of songs behind each — a search box, a playlist, and
 * further down source, tags, downloaded and FS / MS. The result is what "Suona" / "Mescola e suona" turn into the
 * queue. The counts and the filtering are the Playlist manager's own engine (utils/managerSongs).
 *
 * Built for the phone first (spec 2026-11-08-web-mobile-ux-design.md M2/M5): there it is a full-height sheet — title
 * and count on top, the filters scrolling in the middle, the actions fixed at the bottom, touch targets of 44 px and
 * more, text fields at 16 px, safe areas respected — and a dialog for the keyboard and the screen reader (focus goes
 * in, Tab stays in, Escape closes). From 641 px up it is the card above the queue it always was.
 */
export function ChoosePanel({
  filters, onChange, onReset, facets, dataset, count, poolSize, playlists, playlistId, onPlaylist, onPlay, onShuffle,
  onClose,
}: ChoosePanelProps) {
  const { t, language } = useLanguage();
  const uid = useId();
  const titleId = `${uid}-title`;
  const phone = useMediaQuery(PHONE_QUERY);
  const root = useRef<HTMLElement>(null);
  const onKeyDown = useSheetFocus(root, phone, onClose);
  const active = activeFilterCount(filters) + (filters.text.trim() ? 1 : 0);

  const genreOptions = [...facets.genres.entries()].map(([label, n]) => ({ value: label, label, count: n }));
  const decadeOptions: FacetOption[] = facets.decades.map((d) => ({
    value: String(d.value),
    label: d.value === NO_YEAR ? t.chNoYear : decadeLabelFor(d.value, language),
    count: d.count,
  }));
  const decadeWords = (raw: string): string => (raw === NO_YEAR ? t.chNoYear : decadeLabelFor(Number(raw), language));
  const toggleDecade = (raw: string) => {
    const value: DecadeValue = raw === NO_YEAR ? NO_YEAR : Number(raw);
    onChange({ decades: toggled<DecadeValue>(filters.decades, value) });
  };
  const platformOptions: FacetOption[] = [...facets.platforms.entries()]
    .map(([value, n]) => ({ value, label: platformLabel(value), count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const tagOptions: FacetOption[] = [...facets.tags.entries()]
    .map(([value, n]) => ({ value, label: value, count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const placeOptions: FacetOption[] = [
    { value: 'fs', label: 'FS', count: facets.locations.fs },
    { value: 'ms', label: 'MS', count: facets.locations.ms },
  ];
  const stateOptions: Array<{ value: StateFilter; label: string }> = [
    { value: 'all', label: t.chDlAll },
    { value: 'downloaded', label: `${t.chDlYes} (${facets.state.downloaded})` },
    { value: 'notDownloaded', label: `${t.chDlNo} (${facets.state.notDownloaded})` },
  ];

  const play = (mix: boolean) => {
    (mix ? onShuffle : onPlay)();
    if (phone) onClose(); // the sheet covers the player: once a song starts, it gets out of the way
  };

  return (
    <section
      ref={root}
      className="ch-panel"
      role={phone ? 'dialog' : 'region'}
      aria-modal={phone ? true : undefined}
      aria-labelledby={titleId}
      tabIndex={phone ? -1 : undefined}
      onKeyDown={phone ? onKeyDown : undefined}
      data-testid="choose-panel"
      data-sheet={phone ? 'true' : 'false'}
    >
      <header className="ch-head">
        <h2 id={titleId}>{t.chOpen}</h2>
        <span className="ch-count" role="status">
          {countLabel(count, t.mgrItems, t.mgrItemOne)}
          {active > 0 ? ` ${interpolate(t.chOf, { n: poolSize })}` : ''}
        </span>
        <button type="button" className="ch-close" aria-label={t.mgrClose} onClick={onClose}>
          <span aria-hidden>×</span>
        </button>
      </header>

      <div className="ch-body">
        <p className="ch-hint">{t.chHint}</p>

        <div className="ch-fields">
          <label className="ch-field ch-field-wide">
            <span>{t.chSearchLabel}</span>
            <input
              type="search"
              className="ch-input"
              placeholder={t.mgrFilterText}
              value={filters.text}
              onChange={(e) => onChange({ text: e.target.value })}
            />
          </label>
          <label className="ch-field">
            <span>{t.chPlaylist}</span>
            <select className="ch-select" value={playlistId ?? ''} onChange={(e) => onPlaylist(e.target.value || null)}>
              <option value="">{t.chAllSongs}</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.songCount})</option>
              ))}
            </select>
          </label>
        </div>

        {dataset.genres && (
          <FacetGroup
            legend={t.chGenre}
            options={genreOptions}
            selected={filters.genres}
            onToggle={(v) => onChange({ genres: toggled(filters.genres, v) })}
          />
        )}
        {dataset.decades && (
          <FacetGroup
            legend={t.chYears}
            options={decadeOptions}
            selected={filters.decades.map(String)}
            onToggle={toggleDecade}
            limit={20}
            labelOf={decadeWords}
          />
        )}
        {dataset.albums && (
          <FacetGroup
            legend={t.chAlbum}
            options={asOptions(facets.albums)}
            selected={filters.albums}
            onToggle={(v) => onChange({ albums: toggled(filters.albums, v) })}
            limit={6}
          />
        )}
        {dataset.artists && (
          <FacetGroup
            legend={t.chArtist}
            options={asOptions(facets.artists)}
            selected={filters.artists}
            onToggle={(v) => onChange({ artists: toggled(filters.artists, v) })}
            limit={6}
          />
        )}

        <details className="ch-more">
          <summary>{t.chMoreFilters}</summary>
          {dataset.platforms && (
            <FacetGroup
              legend={t.chSource}
              options={platformOptions}
              selected={filters.platforms}
              onToggle={(v) => onChange({ platforms: toggled(filters.platforms, v) })}
              limit={8}
            />
          )}
          {dataset.tags && (
            <FacetGroup
              legend={t.chTags}
              options={tagOptions}
              selected={filters.tags}
              onToggle={(v) => onChange({ tags: toggled(filters.tags, v) })}
              limit={8}
            />
          )}
          <FacetGroup
            legend={t.chWhere}
            options={placeOptions}
            selected={filters.locations}
            onToggle={(v) => onChange({ locations: toggled<PlaceKind>(filters.locations, v as PlaceKind) })}
          />
          <fieldset className="ch-facet">
            <legend>{t.chDownloaded}</legend>
            <div className="ch-radios">
              {stateOptions.map((o) => (
                <label key={o.value} className="ch-radio">
                  <input
                    type="radio"
                    name={`${uid}-state`}
                    checked={filters.state === o.value}
                    onChange={() => onChange({ state: o.value })}
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="ch-check">
            <input type="checkbox" checked={filters.favorite} onChange={(e) => onChange({ favorite: e.target.checked })} />
            <span>⭐ {t.chFavorites}</span>
          </label>
        </details>

      </div>

      <footer className="ch-foot">
        {count === 0 && <p className="ch-none" role="note">{t.chNone}</p>}
        <div className="ch-actions">
          <button type="button" className="ch-btn ch-btn-primary" onClick={() => play(false)} disabled={count === 0}>
            ▶ {t.chPlay} · {count}
          </button>
          <button type="button" className="ch-btn" onClick={() => play(true)} disabled={count === 0}>
            🔀 {t.chShuffle}
          </button>
          <button type="button" className="ch-btn ch-btn-quiet" onClick={onReset} disabled={active === 0}>
            {t.chReset}
          </button>
        </div>
      </footer>
    </section>
  );
}
