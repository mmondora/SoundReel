import { useEffect, useState } from 'react';
import {
  addSongToPlaylist,
  createPlaylist,
  deletePlaylist,
  fetchPlaylist,
  fetchPlaylists,
  renamePlaylist,
  removeSongFromPlaylist,
} from '../services/api';
import type { PlaylistDetail, PlaylistSummary } from '../types';
import { useLanguage } from '../i18n';
import '../styles/player.css';

export interface PlaylistPanelProps {
  /** When set, browsing this playlist filters the Songs list. */
  activeId: string | null;
  onSelect: (playlist: PlaylistDetail | null) => void;
  /** Optional song to add via the "add to playlist" picker. */
  songToAdd?: string | null;
  onSongAdded?: () => void;
  /** Compact mode for embedding in the player. */
  compact?: boolean;
}

export function PlaylistPanel({
  activeId,
  onSelect,
  songToAdd = null,
  onSongAdded,
  compact = false,
}: PlaylistPanelProps) {
  const { t } = useLanguage();
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameDraft, setNameDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const list = await fetchPlaylists();
      setPlaylists(list);
    } catch {
      setPlaylists([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

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

  return (
    <div className={`playlist-panel${compact ? ' compact' : ''}`}>
      <div className="playlist-panel-header">
        <h2>{t.playlistsTitle}</h2>
        {activeId && (
          <button type="button" className="playlist-clear" onClick={() => onSelect(null)}>
            {t.playlistShowAll}
          </button>
        )}
      </div>

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
      {loading && <p className="list-item-muted">{t.loading}</p>}

      <ul className="playlist-list">
        {playlists.map((pl) => {
          const active = activeId === pl.id;
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
                    onClick={() => void handleOpen(pl.id)}
                  >
                    <span className="playlist-name">{pl.name}</span>
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

      {!loading && playlists.length === 0 && (
        <p className="list-item-muted">{t.playlistEmpty}</p>
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
