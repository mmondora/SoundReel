import { useEffect, useId, useState } from 'react';
import {
  addSongToPlaylist,
  createPlaylist,
  deletePlaylist,
  fetchPlaylist,
  renamePlaylist,
  removeSongFromPlaylist,
} from '../services/api';
import type { PlaylistDetail } from '../types';
import { useLanguage } from '../i18n';
import { usePlaylistList } from '../hooks/usePlaylistList';
import { PlaylistListControls } from './PlaylistListControls';
import { formatPlaylistDate, fullPlaylistDate } from '../utils/playlistDate';
import '../styles/player.css';

/** Whether the folded panel of the Songs page is open: remembered per browser, folded by default. */
export const PLAYLIST_PANEL_OPEN_KEY = 'soundreel-songs-playlists-open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(PLAYLIST_PANEL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(PLAYLIST_PANEL_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* private window or blocked storage: the choice is just not remembered */
  }
}

export interface PlaylistPanelProps {
  /** When set, browsing this playlist filters the Songs list. */
  activeId: string | null;
  onSelect: (playlist: PlaylistDetail | null) => void;
  /** Optional song to add via the "add to playlist" picker. */
  songToAdd?: string | null;
  onSongAdded?: () => void;
  /** Compact mode for embedding in the player. */
  compact?: boolean;
  /**
   * The Songs page shows the panel as ONE line («Playlist 59») that opens on a click, and its list scrolls in a box of its own:
   * with dozens of playlists (most of them automatic, ADR-0023) an always-open panel buried the songs under 30 rows. Folded by
   * default; the choice is remembered per browser; it stays open while a song is being added; choosing a playlist folds it again
   * (the page then shows that playlist's songs).
   */
  collapsible?: boolean;
}

export function PlaylistPanel({
  activeId,
  onSelect,
  songToAdd = null,
  onSongAdded,
  compact = false,
  collapsible = false,
}: PlaylistPanelProps) {
  const { t, language } = useLanguage();
  // The list is asked to the server a page at a time, with search, filter and sort by date (ADR-0023).
  const list = usePlaylistList();
  const playlists = list.items;
  const loading = list.loading;
  const bodyId = useId();
  const [stored, setStored] = useState<boolean>(() => (collapsible ? readOpen() : true));
  // an open picker for a song needs the list in front of the person
  const open = !collapsible || stored || Boolean(songToAdd);
  const setOpen = (next: boolean) => {
    setStored(next);
    writeOpen(next);
  };
  // The count on the folded line is that of ALL the playlists, so it keeps the last answer that was not narrowed by a search or a filter.
  const [overall, setOverall] = useState<number | null>(null);
  useEffect(() => {
    if (!list.loading && !list.failed && !list.narrowed) setOverall(list.total);
  }, [list.loading, list.failed, list.narrowed, list.total]);
  const [nameDraft, setNameDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => list.reload();

  async function handleCreate() {
    if (!nameDraft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // New playlists always start empty: songs are added/removed by the user.
      const created = await createPlaylist(nameDraft);
      setNameDraft('');
      await reload();
      onSelect(created);
    } catch {
      setError(t.playlistError);
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(id: string) {
    if (!renameDraft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await renamePlaylist(id, renameDraft);
      setRenamingId(null);
      await reload();
      if (activeId === id) onSelect(updated);
    } catch {
      setError(t.playlistError);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (busy) return;
    if (!window.confirm(t.playlistDeleteConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      await deletePlaylist(id);
      await reload();
      if (activeId === id) onSelect(null);
    } catch {
      setError(t.playlistError);
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen(id: string) {
    setBusy(true);
    setError(null);
    try {
      const detail = await fetchPlaylist(id);
      onSelect(detail);
      // the page now shows that playlist's songs: fold the list so they are in front
      if (collapsible) setOpen(false);
    } catch {
      setError(t.playlistError);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddTo(id: string) {
    if (!songToAdd || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await addSongToPlaylist(id, songToAdd);
      await reload();
      if (activeId === id) onSelect(updated);
      onSongAdded?.();
    } catch {
      setError(t.playlistError);
    } finally {
      setBusy(false);
    }
  }

  const rows = (
    <ul className="playlist-list">
      {playlists.map((pl) => {
        const active = activeId === pl.id;
        const dynamic = pl.kind === 'dynamic';
        return (
          <li key={pl.id} className={`playlist-row${active ? ' active' : ''}`}>
            {renamingId === pl.id ? (
              <div className="playlist-rename-row">
                <input
                  type="text"
                  className="filter-search"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleRename(pl.id); }}
                />
                <button type="button" onClick={() => void handleRename(pl.id)} disabled={busy}>
                  {t.playlistSave}
                </button>
                <button type="button" onClick={() => setRenamingId(null)}>{t.playlistCancel}</button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="playlist-open"
                  title={dynamic && pl.ruleSummary ? pl.ruleSummary : undefined}
                  onClick={() => void handleOpen(pl.id)}
                >
                  {/* the name has the whole width and may wrap; the badges and the date go on a line of their own */}
                  <span className="playlist-main">
                    <span className="playlist-name">{pl.name}</span>
                    <span className="playlist-meta">
                      {pl.origin === 'auto' && <span className="playlist-auto">{t.playlistAutoBadge}</span>}
                      {dynamic && <span className="playlist-dynamic">{t.mgrDynamicPill}</span>}
                      <span className="playlist-date" title={fullPlaylistDate(pl.createdAt, language)}>
                        {formatPlaylistDate(pl.createdAt, language, t)}
                      </span>
                    </span>
                    {dynamic && pl.ruleSummary && <span className="playlist-rule">{pl.ruleSummary}</span>}
                  </span>
                  <span className="playlist-count">{pl.songCount}</span>
                </button>
                <div className="playlist-actions">
                  {songToAdd && (
                    <button
                      type="button"
                      title={t.playlistAddSong}
                      onClick={() => void handleAddTo(pl.id)}
                      disabled={busy}
                    >
                      ＋
                    </button>
                  )}
                  <button
                    type="button"
                    title={t.playlistRename}
                    onClick={() => {
                      setRenamingId(pl.id);
                      setRenameDraft(pl.name);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    title={t.playlistDelete}
                    onClick={() => void handleDelete(pl.id)}
                    disabled={busy}
                  >
                    🗑
                  </button>
                </div>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className={`playlist-panel${compact ? ' compact' : ''}${collapsible ? ' collapsible' : ''}${collapsible && !open ? ' collapsed' : ''}`}>
      <div className="playlist-panel-header">
        {collapsible ? (
          <h2 className="playlist-heading">
            <button
              type="button"
              className="playlist-toggle"
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              title={open ? t.playlistPanelHide : t.playlistPanelShow}
              // forced open while a song is being added: closing it would hide the «＋» buttons
              disabled={Boolean(songToAdd)}
              onClick={() => setOpen(!open)}
            >
              <span className="playlist-toggle-title">{t.playlistsTitle}</span>
              {overall !== null && <span className="playlist-toggle-count">{overall}</span>}
              <span className="playlist-toggle-chevron" aria-hidden="true" />
            </button>
          </h2>
        ) : (
          <h2>{t.playlistsTitle}</h2>
        )}
        {activeId && (
          <button type="button" className="playlist-clear" onClick={() => onSelect(null)}>
            {t.playlistShowAll}
          </button>
        )}
      </div>

      {open && (
        <div id={bodyId} className="playlist-body">
          {songToAdd && (
            <p className="playlist-add-hint">{t.playlistAddHint}</p>
          )}

          <div className="playlist-create-row">
            <input
              type="text"
              className="filter-search"
              placeholder={t.playlistNamePlaceholder}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
            />
            <button
              type="button"
              className="playlist-create-btn"
              disabled={busy || !nameDraft.trim()}
              onClick={() => void handleCreate()}
            >
              {t.playlistCreate}
            </button>
          </div>

          {error && <p className="player-error" role="alert">{error}</p>}

          <PlaylistListControls
            controls={list.controls}
            onQ={list.setQ}
            onFilter={list.setFilter}
            onSort={list.setSort}
            onToggleOrder={list.toggleOrder}
          />

          {loading && <p className="list-item-muted">{t.loading}</p>}

          {/* on the Songs page a long list scrolls in a box of its own instead of pushing the songs down the page */}
          {collapsible ? <div className="playlist-list-scroll">{rows}</div> : rows}

          {!loading && playlists.length === 0 && (
            <p className="list-item-muted">{list.narrowed ? t.playlistNoMatch : t.playlistEmpty}</p>
          )}

          {list.hasMore && (
            <button type="button" className="playlist-more" disabled={list.loadingMore} onClick={list.more}>
              {t.playlistShowMore} ({t.playlistShownOf.replace('{shown}', String(playlists.length)).replace('{total}', String(list.total))})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Helper used by SongsPage when removing a song from the active playlist. */
export async function removeFromActivePlaylist(
  playlistId: string,
  songKey: string,
): Promise<PlaylistDetail> {
  return removeSongFromPlaylist(playlistId, songKey);
}
