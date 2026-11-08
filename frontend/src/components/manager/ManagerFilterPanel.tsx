import { useId } from 'react';
import { useLanguage } from '../../i18n';
import { SOURCE_KINDS, SOURCE_LABEL_KEY, countLabel, platformLabel } from '../../utils/managerSongs';
import type {
  DatasetFacets,
  ExtraDatasetFacets,
  FacetCounts,
  ManagerFilters,
  MembershipFilter,
  SongSourceKind,
  StateFilter,
} from '../../utils/managerSongs';
import { withPicked } from '../../utils/facetOptions';
import { NO_YEAR, decadeLabelFor } from '../../utils/songFacets';
import type { DecadeValue } from '../../utils/songFacets';
import type { ListenedFilter } from '../../utils/songFilters';

export interface ManagerFilterPanelProps {
  filters: ManagerFilters;
  onChange: (patch: Partial<ManagerFilters>) => void;
  onReset: () => void;
  facets: FacetCounts;
  dataset: DatasetFacets & Partial<ExtraDatasetFacets>;
  /** The other pane shows a playlist: "already / not yet in it" is meaningful. */
  otherIsPlaylist: boolean;
}

interface ChipOption {
  value: string;
  label: string;
  count: number;
}

function ChipGroup({
  legend,
  options,
  selected,
  onToggle,
  labelOf,
}: {
  legend: string;
  options: ChipOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  /** Words for a picked value the counts no longer mention. */
  labelOf?: (value: string) => string;
}) {
  // A value with no match under the other filters disappears, unless it is currently picked (so it can be undone):
  // a picked value the counts no longer list is added back, with a 0.
  const visible = withPicked(options, selected, labelOf).filter((o) => o.count > 0 || selected.includes(o.value));
  if (visible.length === 0) return null;
  return (
    <fieldset className="mgr-facet">
      <legend>{legend}</legend>
      <div className="mgr-chips">
        {visible.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className={`mgr-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onToggle(o.value)}
            >
              {o.label} <span className="mgr-chip-count">{o.count}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="mgr-facet">
      <legend>{legend}</legend>
      <div className="mgr-radios">
        {options.map((o) => (
          <label key={o.value} className="mgr-radio">
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const toggled = <T extends string>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const byCountThenLabel = (a: ChipOption, b: ChipOption): number => b.count - a.count || a.label.localeCompare(b.label);

/** Per-pane filter drawer: tipo, fonte, genere, tag, stato, autore, album, ascolto, preferiti, membership. */
export function ManagerFilterPanel({ filters, onChange, onReset, facets, dataset, otherIsPlaylist }: ManagerFilterPanelProps) {
  const { t, language } = useLanguage();
  const uid = useId();
  const artistListId = `${uid}-artists`;

  const typeOptions: ChipOption[] = SOURCE_KINDS.map((k) => ({
    value: k,
    label: t[SOURCE_LABEL_KEY[k]] as string,
    count: facets.types.get(k) ?? 0,
  }));
  const platformOptions: ChipOption[] = [...facets.platforms.entries()]
    .map(([value, count]) => ({ value, label: platformLabel(value), count }))
    .sort(byCountThenLabel);
  const genreOptions: ChipOption[] = [...facets.genres.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort(byCountThenLabel);
  const tagOptions: ChipOption[] = [...facets.tags.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort(byCountThenLabel);

  // "Anni": the decades the songs fall in, in the order of time, with "Senza anno" last (value "none").
  const decadeOptions: ChipOption[] = facets.decades.map((d) => ({
    value: String(d.value),
    label: d.value === NO_YEAR ? t.mgrNoYear : decadeLabelFor(d.value, language),
    count: d.count,
  }));
  const toggleDecade = (raw: string) => {
    const value: DecadeValue = raw === NO_YEAR ? NO_YEAR : Number(raw);
    onChange({ decades: filters.decades.includes(value) ? filters.decades.filter((v) => v !== value) : [...filters.decades, value] });
  };

  const stateOptions: Array<{ value: StateFilter; label: string }> = [
    { value: 'all', label: t.mgrStateAll },
    { value: 'downloaded', label: `${t.songsFilterDownloaded} (${facets.state.downloaded})` },
    { value: 'notDownloaded', label: `${cap(t.mgrNotDownloaded)} (${facets.state.notDownloaded})` },
    { value: 'preparing', label: `${cap(t.mgrPreparing)} (${facets.state.preparing})` },
  ];
  const listenedOptions: Array<{ value: ListenedFilter; label: string }> = [
    { value: 'all', label: t.mgrStateAll },
    { value: 'listened', label: t.songsFilterListened },
    { value: 'unlistened', label: t.songsFilterUnlistened },
  ];
  const membershipOptions: Array<{ value: MembershipFilter; label: string }> = [
    { value: 'all', label: t.mgrMembershipAll },
    { value: 'in', label: t.mgrMembershipIn },
    { value: 'notIn', label: t.mgrMembershipNotIn },
  ];

  return (
    <div className="mgr-filters" role="group" aria-label={t.mgrFilters}>
      <div className="mgr-filter-row">
        <label className="mgr-field">
          <span>{t.mgrFilterArtist}</span>
          <input
            className="mgr-input"
            type="text"
            list={artistListId}
            value={filters.artist}
            onChange={(e) => onChange({ artist: e.target.value })}
          />
          <datalist id={artistListId}>
            {facets.artists.slice(0, 40).map(([name, n]) => (
              <option key={name} value={name}>{countLabel(n, t.mgrItems, t.mgrItemOne)}</option>
            ))}
          </datalist>
        </label>
        <label className="mgr-field">
          <span>{t.mgrFilterAlbum}</span>
          <input
            className="mgr-input"
            type="text"
            value={filters.album}
            onChange={(e) => onChange({ album: e.target.value })}
          />
        </label>
        <label className="mgr-check">
          <input type="checkbox" checked={filters.favorite} onChange={(e) => onChange({ favorite: e.target.checked })} />
          <span>⭐ {t.mgrFilterFavorites}</span>
        </label>
      </div>

      <div className="mgr-filter-row">
        <RadioGroup
          legend={t.mgrFilterState}
          name={`${uid}-state`}
          value={filters.state}
          options={stateOptions}
          onChange={(state) => onChange({ state })}
        />
        <RadioGroup
          legend={t.mgrFilterListened}
          name={`${uid}-listened`}
          value={filters.listened}
          options={listenedOptions}
          onChange={(listened) => onChange({ listened })}
        />
        {otherIsPlaylist && (
          <RadioGroup
            legend={t.mgrFilterMembership}
            name={`${uid}-membership`}
            value={filters.membership}
            options={membershipOptions}
            onChange={(membership) => onChange({ membership })}
          />
        )}
      </div>

      {dataset.genres && (
        <ChipGroup
          legend={t.mgrFilterGenre}
          options={genreOptions}
          selected={filters.genres}
          onToggle={(v) => onChange({ genres: toggled(filters.genres, v) })}
        />
      )}
      {dataset.decades && (
        <ChipGroup
          legend={t.mgrFilterYears}
          options={decadeOptions}
          selected={filters.decades.map(String)}
          onToggle={toggleDecade}
          labelOf={(raw) => (raw === NO_YEAR ? t.mgrNoYear : decadeLabelFor(Number(raw), language))}
        />
      )}
      {dataset.types && (
        <ChipGroup
          legend={t.mgrFilterType}
          options={typeOptions}
          selected={filters.types}
          onToggle={(v) => onChange({ types: toggled(filters.types, v as SongSourceKind) })}
        />
      )}
      {dataset.platforms && (
        <ChipGroup
          legend={t.mgrFilterSource}
          options={platformOptions}
          selected={filters.platforms}
          onToggle={(v) => onChange({ platforms: toggled(filters.platforms, v) })}
        />
      )}
      {dataset.tags && (
        <ChipGroup
          legend={t.mgrFilterTags}
          options={tagOptions}
          selected={filters.tags}
          onToggle={(v) => onChange({ tags: toggled(filters.tags, v) })}
        />
      )}

      <div className="mgr-filter-foot">
        <button type="button" className="mgr-btn" onClick={onReset}>{t.mgrFiltersReset}</button>
      </div>
    </div>
  );
}
