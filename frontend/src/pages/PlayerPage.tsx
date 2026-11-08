import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { PlaylistPanel } from '../components/PlaylistPanel';
import { DownloadChip } from '../components/manager/DownloadChip';
import { LocationBadge } from '../components/LocationBadge';
import { ChoosePanel } from '../components/player/ChoosePanel';
import { PictureBox } from '../components/player/PictureBox';
import { PlayingFrom } from '../components/player/PlayingFrom';
import { SourceSwitch } from '../components/player/SourceSwitch';
import { useEntryThumbnail } from '../hooks/useEntryThumbnail';
import { fetchPlaylist, fetchPlaylists, fetchSongs } from '../services/api';
import { filterSongs } from '../utils/songFilters';
import {
  EMPTY_FILTERS,
  activeFilterCount,
  datasetFacets,
  enrichSongs,
  extraDatasetFacets,
  facetCounts,
  filterManagerSongs,
} from '../utils/managerSongs';
import type { FilterContext, ManagerFilters } from '../utils/managerSongs';
import { selectionLabel, shuffled } from '../utils/playerSelection';
import { scheduleYoutubeWarmUp } from '../player/preload';
import type { DownloadedFilter, ListenedFilter } from '../utils/songFilters';
import { interpolate, useLanguage } from '../i18n';
import { usePlayer } from '../player/PlayerContext';
import { coverCandidates } from '../player/mediaBox';
import { computeQueueWindow, windowItems } from '../player/queueWindow';
import { songLocationIn } from '../utils/songLocation';
import type { AggregatedSong, PlaylistDetail, PlaylistSummary } from '../types';
import '../styles/player.css';
import '../styles/choose.css';

type ShelfFilter = 'all' | 'favorites' | 'liked' | 'unlistened' | 'downloaded';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function PlayerPage() {
  const { t, language } = useLanguage();
  const player = usePlayer();

  const [songs, setSongs] = useState<AggregatedSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [shelf, setShelf] = useState<ShelfFilter>('all');
  const [activePlaylist, setActivePlaylist] = useState<PlaylistDetail | null>(null);
  const [showPlaylists, setShowPlaylists] = useState(false);
  const [songToAdd, setSongToAdd] = useState<string | null>(null);
  /** When true, the list shows the shelf/playlist browse view; tap a song to lock it as sticky queue. */
  const [browsing, setBrowsing] = useState(true);
  // "Scegli cosa suonare": the filters (type, years, album, author…) that narrow what the browse list offers.
  const [filters, setFilters] = useState<ManagerFilters>(EMPTY_FILTERS);
  const [chooseOpen, setChooseOpen] = useState(false);
  const chooseToggle = useRef<HTMLButtonElement>(null);
  const chooseWasOpen = useRef(false);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const playlistsAsked = useRef(false);

  useEffect(() => {
    fetchSongs()
      .then((list) => {
        setSongs(list);
        player.hydrateQueue(list);
      })
      .catch(() => setSongs([]))
      .finally(() => setLoading(false));
    // hydrate once when catalog arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (player.queue.length > 0) setBrowsing(false);
  }, [player.queue.length]);

  // The YouTube side (preconnect + the IFrame API) is warmed up once, when the page is idle, so that the first song
  // that needs it does not wait for it. A song at home never does.
  useEffect(() => scheduleYoutubeWarmUp(), []);

  // When the panel closes (its own close button, Escape, a song started) the focus goes back to the button that
  // opened it — a click on a button does not focus it on every browser (Safari), so it is done here, not remembered.
  useEffect(() => {
    if (!chooseOpen && chooseWasOpen.current) chooseToggle.current?.focus();
    chooseWasOpen.current = chooseOpen;
  }, [chooseOpen]);

  useEffect(() => {
    if (!chooseOpen || playlistsAsked.current) return;
    playlistsAsked.current = true;
    fetchPlaylists().then(setPlaylists).catch(() => setPlaylists([]));
  }, [chooseOpen]);

  const setYtMount = useCallback((el: HTMLDivElement | null) => {
    player.setYoutubeMount(el);
  }, [player.setYoutubeMount]);

  useEffect(() => {
    return () => player.setYoutubeMount(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clear mount on leave
  }, []);

  // What the shelf tab or the chosen playlist offers…
  const shelfList = useMemo(() => {
    if (activePlaylist) {
      const byKey = new Map(songs.map((s) => [s.songKey, s]));
      return activePlaylist.songKeys
        .map((k) => byKey.get(k))
        .filter((s): s is AggregatedSong => !!s);
    }
    const listened: ListenedFilter = shelf === 'unlistened' ? 'unlistened' : 'all';
    const downloaded: DownloadedFilter = shelf === 'downloaded' ? 'yes' : 'all';
    return filterSongs(songs, {
      genres: [],
      listened,
      favorite: shelf === 'favorites',
      liked: shelf === 'liked',
      downloaded,
    });
  }, [songs, shelf, activePlaylist]);

  // …narrowed by "Scegli cosa suonare": the Playlist manager's own filters and facet counts (utils/managerSongs).
  const pool = useMemo(() => enrichSongs(shelfList), [shelfList]);
  const filterCtx = useMemo<FilterContext>(() => {
    const readyKeys = new Set<string>();
    const preparingKeys = new Set<string>();
    for (const st of Object.values(player.downloadStates ?? {})) {
      if (st.phase === 'ready') readyKeys.add(st.songKey);
      else if (st.phase === 'requesting' || st.phase === 'downloading') preparingKeys.add(st.songKey);
    }
    return { readyKeys, preparingKeys };
  }, [player.downloadStates]);
  const browseList = useMemo(() => filterManagerSongs(pool, filters, filterCtx), [pool, filters, filterCtx]);
  const facets = useMemo(
    () => (chooseOpen ? facetCounts(pool, filters, filterCtx) : null),
    [chooseOpen, pool, filters, filterCtx],
  );
  const dataset = useMemo(() => ({ ...datasetFacets(pool), ...extraDatasetFacets(pool) }), [pool]);
  const filtersActive = activeFilterCount(filters) + (filters.text.trim() ? 1 : 0);

  const shelfLabel = useMemo(() => {
    if (activePlaylist) return activePlaylist.name;
    switch (shelf) {
      case 'favorites': return `⭐ ${t.songsFilterFavorites}`;
      case 'liked': return `👍 ${t.playerFilterLiked}`;
      case 'unlistened': return t.songsFilterUnlistened;
      case 'downloaded': return t.songsFilterDownloaded;
      default: return t.playerFilterAll;
    }
  }, [activePlaylist, shelf, t]);

  // The queue a selection becomes is named after it ("Anni 80 · Elettronica"), else after the shelf or playlist.
  const browseLabel = useMemo(
    () => selectionLabel(
      filters,
      { language, noYear: t.chNoYear, search: (q) => interpolate(t.chQueueSearch, { q }) },
      activePlaylist?.name ?? null,
    ) ?? shelfLabel,
    [filters, language, t, activePlaylist, shelfLabel],
  );

  // Sticky Spotify-style queue while playing; browse list only when picking a new context.
  const queueMode = !browsing && player.queue.length > 0;
  // Rule W3: a queue of more than 20 songs shows at most 20, starting from the one in play (the played ones drop
  // out of the top). Presentation only: next / previous / shuffle / repeat work on the FULL queue. The browse list
  // (picking a shelf or playlist) is never cut.
  const queueWindow = queueMode
    ? computeQueueWindow(player.queue.length, player.index, { wrap: player.repeat !== 'off' })
    : null;
  const listSongs = queueMode && queueWindow ? windowItems(player.queue, queueWindow) : browseList;
  const listLabel = queueMode
    ? (player.queueLabel || t.playerQueue)
    : browseLabel;

  const current = player.current;
  // Rule W4 cover order: the song's own cover → the thumbnail of the entry that mentions it → neutral placeholder.
  const entryThumbnail = useEntryThumbnail(current?.mentions[0]?.entryId, !!current && !current.meta?.coverUrl);
  const covers = coverCandidates(current?.meta?.coverUrl, entryThumbnail);
  const videoTitle = current
    ? interpolate(t.playerVideoTitle, { title: current.title, artist: current.artist || '—' })
    : t.playerVideoIdle;
  const windowStatus = queueWindow?.windowed
    ? [
        interpolate(t.playerWindowStatus, { shown: queueWindow.shown, total: queueWindow.total }),
        queueWindow.hiddenPlayed > 0
          ? (queueWindow.hiddenPlayed === 1 ? t.playerWindowHiddenOne : interpolate(t.playerWindowHidden, { n: queueWindow.hiddenPlayed }))
          : null,
      ].filter(Boolean).join(' · ')
    : null;

  function startBrowseShelf(next: ShelfFilter) {
    setActivePlaylist(null);
    setShelf(next);
    setBrowsing(true);
  }

  function handlePlaylistSelect(playlist: PlaylistDetail | null) {
    setActivePlaylist(playlist);
    if (playlist) setShelf('all');
    setBrowsing(true);
  }

  /** `playlistId`: the playlist a NEW queue comes from (or null); leave it out to stay in the queue that is playing. */
  function playFrom(songKey: string, list: AggregatedSong[], label: string, playlistId?: string | null) {
    player.playSong(songKey, list, label, playlistId);
    setBrowsing(false);
  }

  function changeFilters(patch: Partial<ManagerFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setBrowsing(true); // show what the filters leave, not the queue that is playing
  }

  async function choosePlaylist(id: string | null) {
    if (!id) {
      handlePlaylistSelect(null);
      return;
    }
    try {
      handlePlaylistSelect(await fetchPlaylist(id));
    } catch {
      // the list stays as it was
    }
  }

  /** The result of the filters becomes the queue — in order, or shuffled ("Mescola e suona"). */
  function playSelection(mix: boolean) {
    if (browseList.length === 0) return;
    const list = mix ? shuffled(browseList) : browseList;
    playFrom(list[0].songKey, list, browseLabel, activePlaylist?.id ?? null);
  }

  function playBrowse() {
    if (browseList.length === 0) return;
    const startKey = current && browseList.some((s) => s.songKey === current.songKey)
      ? current.songKey
      : browseList[0].songKey;
    playFrom(startKey, browseList, browseLabel, activePlaylist?.id ?? null);
  }

  const repeatLabel =
    player.repeat === 'one' ? t.playerRepeatOne
      : player.repeat === 'all' ? t.playerRepeatAll
        : t.playerRepeatOff;

  const shelfTabs: Array<{ key: ShelfFilter; label: string }> = [
    { key: 'all', label: t.playerFilterAll },
    { key: 'favorites', label: '⭐' },
    { key: 'liked', label: '👍' },
    { key: 'unlistened', label: t.songsFilterUnlistened },
    { key: 'downloaded', label: '⬇' },
  ];

  return (
    <div className="player-car">
      <header className="player-car-top">
        <Link to="/songs" className="player-car-back">
          ← {t.songs}
        </Link>
        <div className="player-car-shelves" role="tablist" aria-label="Filtri player">
          {shelfTabs.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={browsing && !activePlaylist && shelf === key}
              className={`player-car-chip${browsing && !activePlaylist && shelf === key ? ' active' : ''}`}
              onClick={() => startBrowseShelf(key)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={browsing && (!!activePlaylist || showPlaylists)}
            className={`player-car-chip${browsing && (activePlaylist || showPlaylists) ? ' active' : ''}`}
            onClick={() => {
              setShowPlaylists((v) => !v);
              setBrowsing(true);
            }}
          >
            {t.playlistsTitle}
            {activePlaylist && browsing ? `: ${activePlaylist.name}` : ''}
          </button>
          {player.queue.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={!browsing}
              className={`player-car-chip${!browsing ? ' active' : ''}`}
              onClick={() => {
                setShowPlaylists(false);
                setBrowsing(false);
              }}
            >
              ▶ {player.queueLabel || t.playerQueue}
            </button>
          )}
        </div>
      </header>

      <div className="player-car-choose-bar">
        <button
          ref={chooseToggle}
          type="button"
          className={`player-car-choose-toggle${filtersActive > 0 ? ' has-filters' : ''}`}
          aria-expanded={chooseOpen}
          aria-controls="player-choose-panel"
          onClick={() => setChooseOpen((v) => !v)}
        >
          🎚 {t.chOpen}{filtersActive > 0 ? ` · ${interpolate(t.chActive, { n: filtersActive })}` : ''}
        </button>
      </div>

      {chooseOpen && facets && (
        <div id="player-choose-panel">
          <ChoosePanel
            filters={filters}
            onChange={changeFilters}
            onReset={() => changeFilters(EMPTY_FILTERS)}
            facets={facets}
            dataset={dataset}
            count={browseList.length}
            poolSize={pool.length}
            playlists={playlists}
            playlistId={activePlaylist?.id ?? null}
            onPlaylist={(id) => void choosePlaylist(id)}
            onPlay={() => playSelection(false)}
            onShuffle={() => playSelection(true)}
            onClose={() => setChooseOpen(false)}
          />
        </div>
      )}

      {showPlaylists && (
        <div className="player-car-playlists">
          <PlaylistPanel
            compact
            activeId={activePlaylist?.id ?? null}
            onSelect={(pl) => {
              handlePlaylistSelect(pl);
              if (pl) setShowPlaylists(false);
            }}
          />
        </div>
      )}

      {songToAdd && (
        <AddToPlaylistModal
          songKey={songToAdd}
          songLabel={
            current && current.songKey === songToAdd
              ? `${current.title} — ${current.artist || '—'}`
              : undefined
          }
          onClose={() => setSongToAdd(null)}
          onDone={(pl) => {
            if (activePlaylist?.id === pl.id) setActivePlaylist(pl);
          }}
        />
      )}

      <section className="player-car-stage" aria-label={t.playerNowPlaying}>
        <div className="player-car-media">
          <PictureBox
            mode={player.mediaBox}
            candidates={covers}
            songKey={current?.songKey ?? null}
            videoTitle={videoTitle}
            onYtMount={setYtMount}
          />
        </div>

        <div className="player-car-main">
          <div className="player-car-meta">
            <div className="player-car-title">{current?.title ?? '—'}</div>
            <div className="player-car-artist">{current?.artist || '—'}</div>
            <div className="player-car-where">
              {current && <LocationBadge location={songLocationIn(current, player.locationOverrides)} />}
              <PlayingFrom />
              <DownloadChip state={player.currentDownload ?? undefined} />
              <span className="player-car-loading" role="status">
                {player.loading ? (<><span className="player-car-loading-dot" aria-hidden /> {t.playerLoading}</>) : null}
              </span>
            </div>
            {player.queueLabel && (
              <div className="player-car-context">{player.queueLabel}</div>
            )}
          </div>

          {player.error && (
            <p className="player-car-error" role="alert">
              {player.error}
              <span className="player-car-error-hint"> · passo al successivo…</span>
              {' '}
              <button type="button" className="player-car-error-skip" onClick={player.next}>
                ⏭ Ora
              </button>
            </p>
          )}

          <div className="player-car-dock">
            <div className="player-car-seek">
              <span className="player-car-time">{formatTime(player.currentTime)}</span>
              <input
                type="range"
                className="player-car-seek-range"
                min={0}
                max={Math.max(player.duration, 0.1)}
                step={0.1}
                value={Math.min(player.currentTime, player.duration || 0)}
                aria-label="Seek"
                onChange={(e) => player.seek(Number(e.target.value))}
              />
              <span className="player-car-time">{formatTime(player.duration)}</span>
            </div>

            <div className="player-car-controls">
              <button
                type="button"
                className={`player-car-ctrl${player.shuffle ? ' active' : ''}`}
                aria-pressed={player.shuffle}
                aria-label={t.playerShuffle}
                onClick={player.toggleShuffle}
              >
                🔀
              </button>
              <button
                type="button"
                className="player-car-ctrl player-car-ctrl-skip"
                aria-label="Previous"
                onClick={player.previous}
              >
                ⏮
              </button>
              <button
                type="button"
                className="player-car-ctrl player-car-ctrl-play"
                aria-label={player.playing ? 'Pause' : 'Play'}
                aria-busy={player.loading}
                disabled={!current && browseList.length === 0 && player.queue.length === 0}
                onClick={() => {
                  if (!current) playBrowse();
                  else player.toggle();
                }}
              >
                {player.loading ? '…' : player.playing ? '⏸' : '▶'}
              </button>
              <button
                type="button"
                className="player-car-ctrl player-car-ctrl-skip"
                aria-label="Next"
                onClick={player.next}
              >
                ⏭
              </button>
              <button
                type="button"
                className={`player-car-ctrl${player.repeat !== 'off' ? ' active' : ''}`}
                aria-label={repeatLabel}
                onClick={player.cycleRepeatMode}
              >
                {player.repeat === 'one' ? '🔂' : '🔁'}
              </button>
            </div>

            <div className="player-car-source">
              <SourceSwitch />
            </div>

            {current && (
              <div className="player-car-actions">
                <button
                  type="button"
                  className={`player-car-action${current.meta?.favorite ? ' active' : ''}`}
                  aria-pressed={!!current.meta?.favorite}
                  aria-label={t.songsMarkFavorite}
                  onClick={() => void player.patchCurrent({ favorite: !current.meta?.favorite })}
                >
                  {current.meta?.favorite ? '⭐' : '☆'}
                </button>
                <button
                  type="button"
                  className={`player-car-action${current.meta?.rating === 'like' ? ' active' : ''}`}
                  aria-pressed={current.meta?.rating === 'like'}
                  aria-label={t.songsMarkLike}
                  onClick={() => void player.patchCurrent({
                    rating: current.meta?.rating === 'like' ? null : 'like',
                    score: current.meta?.rating === 'like' ? null : 90,
                  })}
                >
                  👍
                </button>
                <button
                  type="button"
                  className={`player-car-action${current.meta?.rating === 'dislike' ? ' active' : ''}`}
                  aria-pressed={current.meta?.rating === 'dislike'}
                  aria-label={t.songsMarkDislike}
                  onClick={() => void player.patchCurrent({
                    rating: current.meta?.rating === 'dislike' ? null : 'dislike',
                    score: current.meta?.rating === 'dislike' ? null : 10,
                  })}
                >
                  👎
                </button>
                <button
                  type="button"
                  className={`player-car-action${songToAdd === current.songKey ? ' active' : ''}`}
                  aria-label={t.playlistAddSong}
                  title={t.playlistAddSong}
                  onClick={() => setSongToAdd(current.songKey)}
                >
                  ＋
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="player-car-queue" aria-label={t.playerQueue}>
        <div className="player-car-queue-bar">
          <h2>{listLabel}</h2>
          <span className="player-car-count">{queueWindow ? queueWindow.total : listSongs.length}</span>
          {browsing && (
            <span className="player-car-browse-hint">{t.playerBrowseHint}</span>
          )}
          {browsing && browseList.length > 0 && (
            <button type="button" className="player-car-queue-btn" onClick={playBrowse}>
              ▶
            </button>
          )}
        </div>

        {windowStatus && (
          <p className="player-car-window" role="status" data-testid="queue-window">{windowStatus}</p>
        )}

        {loading && <p className="player-car-empty">{t.loading}</p>}
        {!loading && listSongs.length === 0 && (
          <div className="player-car-empty">
            <p>{t.playerEmpty}</p>
            <p className="player-car-empty-hint">{t.playerEmptyHint}</p>
          </div>
        )}

        <ul className="player-car-tracks">
          {listSongs.map((song) => {
            const active = current?.songKey === song.songKey;
            return (
              <li key={song.songKey}>
                <button
                  type="button"
                  className={`player-car-track${active ? ' active' : ''}`}
                  onClick={() => {
                    if (browsing) playFrom(song.songKey, browseList, browseLabel, activePlaylist?.id ?? null);
                    else playFrom(song.songKey, player.queue, player.queueLabel || t.playerQueue);
                  }}
                >
                  <span className="player-car-track-art" aria-hidden>
                    {song.meta?.coverUrl ? <img src={song.meta.coverUrl} alt="" /> : '🎵'}
                  </span>
                  <span className="player-car-track-text">
                    <span className="player-car-track-title">{song.title}</span>
                    <span className="player-car-track-artist">{song.artist || '—'}</span>
                  </span>
                  <LocationBadge location={songLocationIn(song, player.locationOverrides)} />
                  {song.meta?.favorite && <span className="player-car-track-fav" aria-label="favorite">⭐</span>}
                  {active && player.playing && <span className="player-car-track-eq" aria-hidden>♪</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
