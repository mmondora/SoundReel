import type { PlaylistFilter, PlaylistSort } from '../types';
import type { PlaylistListControls as Controls } from '../hooks/usePlaylistList';
import { useLanguage } from '../i18n';

const FILTERS: PlaylistFilter[] = ['all', 'auto', 'mine', 'shared', 'dynamic'];
const SORTS: PlaylistSort[] = ['created', 'updated', 'name', 'size'];

export interface PlaylistListControlsProps {
  controls: Controls;
  onQ: (q: string) => void;
  onFilter: (filter: PlaylistFilter) => void;
  onSort: (sort: PlaylistSort) => void;
  onToggleOrder: () => void;
  /** The pickers (a sheet to add a song) only need the search. */
  searchOnly?: boolean;
  /** The dialog that holds the controls puts the focus on the search when it opens. */
  autoFocusSearch?: boolean;
}

/** Search, «show», sort by date (or name, or size) and its direction: the controls of a long list of playlists (ADR-0023). */
export function PlaylistListControls({ controls, onQ, onFilter, onSort, onToggleOrder, searchOnly = false, autoFocusSearch = false }: PlaylistListControlsProps) {
  const { t } = useLanguage();
  const filterLabel: Record<PlaylistFilter, string> = {
    all: t.playlistFilterAll,
    auto: t.playlistFilterAuto,
    mine: t.playlistFilterMine,
    shared: t.playlistFilterShared,
    dynamic: t.playlistFilterDynamic,
  };
  const sortLabel: Record<PlaylistSort, string> = {
    created: t.playlistSortCreated,
    updated: t.playlistSortUpdated,
    name: t.playlistSortName,
    size: t.playlistSortSize,
  };
  return (
    <div className="playlist-controls">
      <input
        type="search"
        className="filter-search playlist-search"
        placeholder={t.playlistSearchPlaceholder}
        aria-label={t.playlistSearchPlaceholder}
        value={controls.q}
        data-autofocus={autoFocusSearch ? '' : undefined}
        onChange={(e) => onQ(e.target.value)}
      />
      {!searchOnly && (
        <>
          <div className="playlist-filters" role="group" aria-label={t.playlistFilterLabel}>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={`genre-chip${controls.filter === f ? ' active' : ''}`}
                aria-pressed={controls.filter === f}
                onClick={() => onFilter(f)}
              >
                {filterLabel[f]}
              </button>
            ))}
          </div>
          <div className="playlist-sort">
            <select
              className="playlist-sort-select"
              aria-label={t.playlistSortLabel}
              value={controls.sort}
              onChange={(e) => onSort(e.target.value as PlaylistSort)}
            >
              {SORTS.map((s) => (
                <option key={s} value={s}>{sortLabel[s]}</option>
              ))}
            </select>
            <button
              type="button"
              className="playlist-order-btn"
              aria-label={controls.order === 'desc' ? t.playlistOrderDesc : t.playlistOrderAsc}
              title={controls.order === 'desc' ? t.playlistOrderDesc : t.playlistOrderAsc}
              onClick={onToggleOrder}
            >
              {controls.order === 'desc' ? '↓' : '↑'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
