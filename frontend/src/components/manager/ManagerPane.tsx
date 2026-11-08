import { useEffect, useState } from 'react';
import type { MouseEvent, Ref } from 'react';
import { interpolate, useLanguage } from '../../i18n';
import { OTHER_PANE } from '../../hooks/usePlaylistManager';
import type { LiveSongState, PaneId, PlaylistManager } from '../../hooks/usePlaylistManager';
import { SOURCE_LABEL_KEY, countLabel, isSongDownloaded, isSongPreparing, platformLabel } from '../../utils/managerSongs';
import type { LibrarySortMode, ManagerSong } from '../../utils/managerSongs';
import type { PaneLocation } from '../../utils/managerPermissions';
import { LocationBadge } from '../LocationBadge';
import { useRuleLabels } from '../../hooks/useRuleLabels';
import { describeRule } from '../../utils/dynamicRule';
import { resolveSongLocation, resolveSongPlace } from '../../utils/songLocation';
import { ManagerFilterPanel } from './ManagerFilterPanel';
import { SongWhere } from './SongWhere';

export interface ManagerPaneProps {
  manager: PlaylistManager;
  paneId: PaneId;
  paneLabel: string;
  live: LiveSongState;
  listRef: Ref<HTMLUListElement>;
  onPlay: (paneId: PaneId, songKey: string) => void;
  /** "Mostra percorsi" (rule W8): a detail line under each song with its path / URL / YouTube link. */
  showPaths?: boolean;
  onTogglePaths?: () => void;
}

/** Marks dynamic playlists in the pickers. */
const DYNAMIC_GLYPH = '◷';

/**
 * "Tutti i brani" is EVERYTHING SoundReel knows (the journal and the files of geekom and the NAS: thousands of songs), so only the
 * first rows are drawn and «Mostra altri» adds more. The cursor is always drawn, so moving with the keyboard never loses it.
 */
const ROWS_AT_FIRST = 300;
const ROWS_STEP = 300;
const ROWS_AFTER_CURSOR = 40;

const locationValue = (loc: PaneLocation): string => (loc.kind === 'library' ? 'library' : `playlist:${loc.id}`);
const parseLocation = (value: string): PaneLocation =>
  value.startsWith('playlist:') ? { kind: 'playlist', id: value.slice('playlist:'.length) } : { kind: 'library' };

export function ManagerPane({ manager, paneId, paneLabel, live, listRef, onPlay, showPaths = false, onTogglePaths }: ManagerPaneProps) {
  const { t, language } = useLanguage();
  const ruleLabels = useRuleLabels();
  const model = manager.models[paneId];
  const isActive = manager.active === paneId;
  const other = manager.models[OTHER_PANE[paneId]];
  const { playlists, viewer } = manager;

  const mine = playlists.filter((p) => !viewer || (p.ownerUser ?? viewer.user) === viewer.user);
  const shared = playlists.filter((p) => !mine.includes(p));
  const playlist = model.playlist;
  const heading = playlist ? playlist.name : t.mgrLibrary;
  const ownerId = playlist?.ownerUser ?? viewer?.user ?? '';
  const cursorIndex = model.cursor !== null ? model.visibleKeys.indexOf(model.cursor) : -1;
  const cursorId = cursorIndex >= 0 ? `mgr-${paneId}-row-${cursorIndex}` : undefined;

  // How many rows are drawn; a new place, sort or filter starts again from the first ones.
  const [limit, setLimit] = useState(ROWS_AT_FIRST);
  const placeKey = locationValue(model.state.location);
  useEffect(() => {
    setLimit(ROWS_AT_FIRST);
  }, [placeKey, model.state.filters, model.state.sort]);
  const drawn = Math.min(model.rows.length, Math.max(limit, cursorIndex >= 0 ? cursorIndex + 1 + ROWS_AFTER_CURSOR : 0));
  const drawnRows = drawn < model.rows.length ? model.rows.slice(0, drawn) : model.rows;

  // Keep the cursor row on screen while moving with the keyboard.
  useEffect(() => {
    if (!isActive || !cursorId) return;
    document.getElementById(cursorId)?.scrollIntoView?.({ block: 'nearest' });
  }, [isActive, cursorId]);

  function onRowClick(e: MouseEvent<HTMLLIElement>, key: string) {
    manager.setActive(paneId);
    const onMark = (e.target as HTMLElement).closest('[data-mark]') !== null;
    if (e.shiftKey) manager.markRange(paneId, key);
    else if (onMark || e.ctrlKey || e.metaKey) manager.toggleMark(paneId, key, false);
    else manager.setCursor(paneId, key);
  }

  function rowBadges(song: ManagerSong) {
    // a song that is only a file has no post: no type, no platform; it says what it is instead
    if (song.libraryOnly) {
      return (
        <span className="mgr-badges">
          <span className="mgr-badge mgr-badge-file" title={t.mgrFileOnlyHint}>{t.mgrFileOnly}</span>
        </span>
      );
    }
    const type = song.sources[0];
    const platform = song.platforms[0];
    const extraTypes = song.sources.length - 1;
    const extraPlatforms = song.platforms.length - 1;
    return (
      <span className="mgr-badges">
        {type && <span className="mgr-badge mgr-badge-type" title={t[SOURCE_LABEL_KEY[type]] as string}>{t[SOURCE_LABEL_KEY[type]] as string}{extraTypes > 0 ? ` +${extraTypes}` : ''}</span>}
        {platform && <span className="mgr-badge mgr-badge-source">{platformLabel(platform)}{extraPlatforms > 0 ? ` +${extraPlatforms}` : ''}</span>}
      </span>
    );
  }

  function dot(song: ManagerSong) {
    if (song.placeholder) return { glyph: '?', cls: 'unknown', label: t.mgrMissingSong };
    if (isSongDownloaded(song, live)) return { glyph: '●', cls: 'yes', label: t.mgrDownloaded };
    if (isSongPreparing(song, live)) return { glyph: '◐', cls: 'wip', label: t.mgrPreparing };
    return { glyph: '○', cls: 'no', label: t.mgrNotDownloaded };
  }

  const sharedNames = model.sharedWith?.map((id) => manager.familyName(id)).join(', ') ?? '';

  return (
    <section
      className={`mgr-pane${isActive ? ' is-active' : ''}`}
      aria-label={`${paneLabel} — ${heading}`}
      aria-current={isActive ? 'true' : undefined}
      data-pane={paneId}
      onMouseDown={() => manager.setActive(paneId)}
    >
      <header className="mgr-pane-head">
        <div className="mgr-pane-top">
          <span className="mgr-pane-tag">{paneLabel}</span>
          <select
            className="mgr-select"
            aria-label={`${t.mgrLocationLabel} (${paneLabel})`}
            value={locationValue(model.state.location)}
            onChange={(e) => manager.selectLocation(paneId, parseLocation(e.target.value))}
          >
            <option value="library">{t.mgrLibrary} ({manager.songs.length})</option>
            {mine.length > 0 && (
              <optgroup label={t.mgrMine}>
                {mine.map((p) => (
                  <option key={p.id} value={`playlist:${p.id}`}>{p.kind === 'dynamic' ? `${DYNAMIC_GLYPH} ` : ''}{p.name} ({p.songCount})</option>
                ))}
              </optgroup>
            )}
            {shared.length > 0 && (
              <optgroup label={t.mgrSharedWithMe}>
                {shared.map((p) => (
                  <option key={p.id} value={`playlist:${p.id}`}>
                    {p.kind === 'dynamic' ? `${DYNAMIC_GLYPH} ` : ''}{p.name} ({p.songCount}) · {interpolate(t.mgrOwnerOf, { name: manager.familyName(p.ownerUser ?? '') })}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {model.state.location.kind === 'library' && (
            <select
              className="mgr-select mgr-select-sort"
              aria-label={`${t.mgrSort} (${paneLabel})`}
              value={model.state.sort}
              onChange={(e) => manager.setSort(paneId, e.target.value as LibrarySortMode)}
            >
              <option value="date">{t.sortByDate}</option>
              <option value="artist">{t.sortByArtist}</option>
              <option value="title">{t.sortByTitle}</option>
            </select>
          )}
        </div>

        {playlist && (
          <p className="mgr-owner" data-testid={`owner-${paneId}`}>
            <span className={`mgr-pill${model.perms.isOwner ? ' mine' : ''}`}>
              {model.perms.isOwner ? t.mgrOwnerYou : interpolate(t.mgrOwnerOf, { name: manager.familyName(ownerId) })}
            </span>
            {model.isDynamic && <span className="mgr-pill dyn">{DYNAMIC_GLYPH} {t.mgrDynamicPill}</span>}
            {!model.perms.canEdit && <span className="mgr-pill ro">🔒 {t.mgrReadOnly}</span>}
            {model.perms.isOwner && model.sharedWith !== null && (
              <span className="mgr-owner-shares">
                {model.sharedWith.length > 0 ? interpolate(t.mgrSharedWith, { names: sharedNames }) : t.mgrNotShared}
              </span>
            )}
          </p>
        )}

        {playlist && model.isDynamic && (
          <div className="mgr-dynamic" data-testid={`dynamic-${paneId}`}>
            <p className="mgr-dynamic-rule">
              {model.ruleSummary ?? (model.rule ? describeRule(model.rule, ruleLabels) : '')}
            </p>
            <div className="mgr-dynamic-meta">
              <span>{countLabel(model.detail?.songKeys.length ?? playlist.songCount, t.mgrItems, t.mgrItemOne)}</span>
              <span>
                {model.evaluatedAt
                  ? interpolate(t.mgrDynamicEvaluated, {
                      time: new Date(model.evaluatedAt).toLocaleTimeString(language === 'it' ? 'it-IT' : 'en-GB', { hour: '2-digit', minute: '2-digit' }),
                    })
                  : t.mgrDynamicNever}
              </span>
              <button type="button" className="mgr-btn mgr-btn-small" onClick={() => void manager.refreshDynamic(paneId)}>
                ↻ {t.mgrDynamicRefresh}
              </button>
            </div>
          </div>
        )}

        <div className="mgr-filter-bar">
          <input
            className="mgr-input mgr-search"
            type="search"
            placeholder={t.mgrFilterText}
            aria-label={`${t.mgrFilterText} (${paneLabel})`}
            value={model.state.filters.text}
            onChange={(e) => manager.setFilters(paneId, { text: e.target.value })}
          />
          <button
            type="button"
            className={`mgr-btn mgr-btn-filters${model.state.filtersOpen ? ' on' : ''}`}
            aria-expanded={model.state.filtersOpen}
            onClick={() => manager.toggleFilters(paneId)}
          >
            {t.mgrFilters}{model.filterCount > 0 ? ` (${model.filterCount})` : ''}
          </button>
          {onTogglePaths && (
            <button
              type="button"
              className={`mgr-btn mgr-btn-paths${showPaths ? ' on' : ''}`}
              aria-pressed={showPaths}
              aria-label={`${t.mgrShowPaths} (${paneLabel})`}
              title={t.mgrShowPathsHint}
              onClick={onTogglePaths}
            >
              {t.mgrShowPaths}
            </button>
          )}
        </div>

        {model.state.filtersOpen && model.facets && (
          <ManagerFilterPanel
            filters={model.state.filters}
            onChange={(patch) => manager.setFilters(paneId, patch)}
            onReset={() => manager.resetFilters(paneId)}
            facets={model.facets}
            dataset={model.dataset}
            otherIsPlaylist={other.state.location.kind === 'playlist'}
          />
        )}
      </header>

      <ul
        ref={listRef}
        className="mgr-list"
        role="listbox"
        aria-multiselectable="true"
        aria-label={`${paneLabel} — ${heading}`}
        aria-activedescendant={model.cursor !== null ? cursorId : undefined}
        tabIndex={0}
        data-mgr-list
        data-pane={paneId}
        onFocus={() => manager.setActive(paneId)}
      >
        {drawnRows.map((song, index) => {
          const marked = model.marked.has(song.songKey);
          const isCursor = model.cursor === song.songKey;
          const d = dot(song);
          return (
            <li
              key={song.songKey}
              id={`mgr-${paneId}-row-${index}`}
              role="option"
              aria-selected={marked}
              className={`mgr-row${isCursor ? ' is-cursor' : ''}${marked ? ' is-marked' : ''}${song.placeholder ? ' is-missing' : ''}`}
              data-key={song.songKey}
              onClick={(e) => onRowClick(e, song.songKey)}
              onDoubleClick={() => onPlay(paneId, song.songKey)}
            >
              <span className="mgr-mark" data-mark aria-hidden>{marked ? '■' : '□'}</span>
              <span className="mgr-dl-wrap">
                <span className={`mgr-dl mgr-dl-${d.cls}`} role="img" aria-label={d.label} title={d.label}>{d.glyph}</span>
                {!song.placeholder && <LocationBadge location={resolveSongLocation(song, live.locations?.[song.songKey])} />}
              </span>
              <span className="mgr-main">
                <span className="mgr-title">{song.title}</span>
                <span className="mgr-artist"> — {song.artist || '—'}</span>
                {song.meta?.favorite && <span className="mgr-fav" role="img" aria-label={t.mgrFavorite}> ⭐</span>}
              </span>
              <span className="mgr-album">{song.album ?? song.meta?.album ?? ''}</span>
              {rowBadges(song)}
              {showPaths && !song.placeholder && (
                <SongWhere song={song} place={resolveSongPlace(song, live.locations?.[song.songKey])} />
              )}
            </li>
          );
        })}
        {model.loadingDetail && <li className="mgr-empty" role="presentation">{t.loading}</li>}
        {!model.loadingDetail && model.rows.length === 0 && (
          <li className="mgr-empty" role="presentation">
            {model.filtered || model.allRows.length > 0 ? t.mgrNoSongs : playlist ? t.mgrEmptyPlaylist : t.mgrNoSongs}
          </li>
        )}
      </ul>

      <footer className="mgr-pane-foot">
        <span>{countLabel(model.rows.length, t.mgrItems, t.mgrItemOne)}{model.filtered ? ` / ${model.allRows.length}` : ''}</span>
        {drawn < model.rows.length && (
          <>
            <span data-testid={`shown-${paneId}`}>{interpolate(t.mgrShowing, { shown: drawn, total: model.rows.length })}</span>
            <button
              type="button"
              className="mgr-btn mgr-btn-small"
              onClick={() => setLimit(drawn + ROWS_STEP)}
            >
              {interpolate(t.mgrShowMore, { n: Math.min(ROWS_STEP, model.rows.length - drawn) })}
            </button>
          </>
        )}
        {model.marked.size > 0 && <span className="mgr-foot-marked">{interpolate(t.mgrMarked, { n: model.marked.size })}</span>}
        {model.missingCount > 0 && <span className="mgr-foot-missing">⚠ {countLabel(model.missingCount, t.mgrItems, t.mgrItemOne)} {t.mgrMissingSong}</span>}
      </footer>
    </section>
  );
}
