import { useState } from 'react';
import { addSongToPlaylist, createPlaylist } from '../services/api';
import type { PlaylistDetail } from '../types';
import { useLanguage } from '../i18n';
import { usePlaylistList } from '../hooks/usePlaylistList';
import { PlaylistListControls } from './PlaylistListControls';
import { formatPlaylistDate, fullPlaylistDate } from '../utils/playlistDate';
import '../styles/player.css';

export interface AddToPlaylistModalProps {
  songKey: string;
  songLabel?: string;
  onClose: () => void;
  /** Called after a successful add or create-with-song. */
  onDone?: (playlist: PlaylistDetail) => void;
}

/**
 * Touch-friendly sheet: pick an existing playlist or create a new one,
 * then add `songKey` to it.
 */
export function AddToPlaylistModal({
  songKey,
  songLabel,
  onClose,
  onDone,
}: AddToPlaylistModalProps) {
  const { t, language } = useLanguage();
  // The playlists come a page at a time, the newest first, with a search (ADR-0023): the sheet stays usable with many of them.
  const list = usePlaylistList();
  const playlists = list.items;
  const loading = list.loading;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  async function pick(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await addSongToPlaylist(id, songKey);
      onDone?.(updated);
      onClose();
    } catch {
      setError(t.playlistError);
    } finally {
      setBusy(false);
    }
  }

  async function createNew() {
    if (!nameDraft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createPlaylist(nameDraft.trim(), [songKey]);
      onDone?.(created);
      onClose();
    } catch {
      setError(t.playlistError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="playlist-picker-backdrop"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        className="playlist-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t.playlistAddSong}
      >
        <div className="playlist-picker-header">
          <h2>{t.playlistAddSong}</h2>
          <button
            type="button"
            className="playlist-picker-close"
            onClick={onClose}
            disabled={busy}
            aria-label={t.playlistCancel}
          >
            ✕
          </button>
        </div>

        {songLabel && (
          <p className="playlist-picker-song">{songLabel}</p>
        )}

        {error && <p className="player-error" role="alert">{error}</p>}

        <PlaylistListControls
          searchOnly
          controls={list.controls}
          onQ={list.setQ}
          onFilter={list.setFilter}
          onSort={list.setSort}
          onToggleOrder={list.toggleOrder}
        />

        {loading && <p className="list-item-muted">{t.loading}</p>}

        {!loading && (
          <ul className="playlist-picker-list">
            {playlists.map((pl) => (
              <li key={pl.id}>
                <button
                  type="button"
                  className="playlist-picker-item"
                  disabled={busy}
                  onClick={() => void pick(pl.id)}
                >
                  <span className="playlist-name">{pl.name}</span>
                  <span className="playlist-date" title={fullPlaylistDate(pl.createdAt, language)}>
                    {formatPlaylistDate(pl.createdAt, language, t)}
                  </span>
                  <span className="playlist-count">{pl.songCount}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!loading && playlists.length === 0 && !creating && (
          <p className="list-item-muted">{list.narrowed ? t.playlistNoMatch : t.playlistEmpty}</p>
        )}

        {list.hasMore && (
          <button type="button" className="playlist-more" disabled={list.loadingMore} onClick={list.more}>
            {t.playlistShowMore} ({t.playlistShownOf.replace('{shown}', String(playlists.length)).replace('{total}', String(list.total))})
          </button>
        )}

        {creating ? (
          <div className="playlist-create-row playlist-picker-create">
            <input
              type="text"
              className="filter-search"
              placeholder={t.playlistNamePlaceholder}
              value={nameDraft}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createNew(); }}
            />
            <button
              type="button"
              className="playlist-create-btn"
              disabled={busy || !nameDraft.trim()}
              onClick={() => void createNew()}
            >
              {t.playlistCreate}
            </button>
            <button
              type="button"
              className="playlist-picker-cancel-create"
              disabled={busy}
              onClick={() => { setCreating(false); setNameDraft(''); }}
            >
              {t.playlistCancel}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="playlist-picker-new"
            disabled={busy}
            onClick={() => setCreating(true)}
          >
            ＋ {t.playlistCreateNew}
          </button>
        )}
      </div>
    </div>
  );
}
