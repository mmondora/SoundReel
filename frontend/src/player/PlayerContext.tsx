import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AggregatedSong, NetworkKind, SongMetaRecord, SongStateLocation } from '../types';
import type { SongMetaPatchBody } from '../services/api';
import { fetchNetwork, fetchSongYoutube, fetchSongState, patchSongMeta, requestSongDownload, sendPlays } from '../services/api';
import {
  bindMediaSessionHandlers,
  setMediaSessionMetadata,
  setMediaSessionPlaybackState,
} from './mediaSession';
import {
  cycleRepeat,
  nextIndex,
  prevIndex,
  queueFromList,
  rebuildQueueFromKeys,
  shuffleKeepingCurrent,
  type RepeatMode,
} from './queueLogic';
import {
  loadYoutubeApi,
  YT_CUED,
  YT_ENDED,
  YT_PAUSED,
  YT_PLAYING,
  type YtPlayer,
} from './youtubeApi';
import { youtubeErrorMessage, youtubeErrorShouldSkip } from './youtubeErrors';
import { createDownloadTracker } from './songDownload';
import type { DownloadTracker, DownloadUiState } from './songDownload';
import { PlayTracker } from './playTracker';
import { PlayEventQueue, safeLocalStorage } from './playEventQueue';
import { isAtHome, locationFromState, locationOverridesFrom, resolveSongLocation } from '../utils/songLocation';
import { INITIAL_MEDIA_STATE, chooseMediaBox, mediaReducer, playingFrom as playingFromOf } from './mediaBox';
import type { MediaBoxMode } from './mediaBox';
import {
  effectiveSource,
  loadSourceMode,
  saveSourceMode,
  sourceChoiceFor,
} from './playbackSource';
import type { PlayFrom, SourceChoice, SourceMode } from './playbackSource';

/** How long the first play of a page waits for `GET /api/net` before treating the network as external. */
const NETWORK_WAIT_MS = 1500;

/**
 * A song that is starting shows "Sto caricando…" until it really plays. If nothing says so within this time (autoplay
 * refused, a stalled request) the state is cleared anyway, so the controls never stay waiting for ever.
 */
export const LOADING_MAX_MS = 12_000;

/** What the player knows about the network: still asking, answered, or the answer failed (counts as external). */
export type NetworkStatus = NetworkKind | 'pending' | 'failed';

const STORAGE_KEY = 'soundreel.player.v2';

interface PersistedPlayer {
  songKey: string | null;
  songKeys: string[];
  queueLabel: string | null;
  /** Playlist the queue started from (for the listening events). */
  playlistId?: string | null;
  shuffle: boolean;
  repeat: RepeatMode;
}

function loadPersisted(): PersistedPlayer {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
      ?? sessionStorage.getItem('soundreel.player.v1');
    if (!raw) {
      return { songKey: null, songKeys: [], queueLabel: null, shuffle: false, repeat: 'off' };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedPlayer>;
    return {
      songKey: parsed.songKey ?? null,
      songKeys: Array.isArray(parsed.songKeys) ? parsed.songKeys.filter((k): k is string => typeof k === 'string') : [],
      queueLabel: typeof parsed.queueLabel === 'string' ? parsed.queueLabel : null,
      playlistId: typeof parsed.playlistId === 'string' ? parsed.playlistId : null,
      shuffle: !!parsed.shuffle,
      repeat: parsed.repeat === 'one' || parsed.repeat === 'all' ? parsed.repeat : 'off',
    };
  } catch {
    return { songKey: null, songKeys: [], queueLabel: null, shuffle: false, repeat: 'off' };
  }
}

function savePersisted(state: PersistedPlayer): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export interface PlayerContextValue {
  queue: AggregatedSong[];
  index: number;
  current: AggregatedSong | null;
  /** Human label for the sticky playback context (playlist / shelf name). */
  queueLabel: string | null;
  playing: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  currentTime: number;
  duration: number;
  loading: boolean;
  error: string | null;
  /**
   * First-play downloads of this session, by songKey: a song without a server-side MP3 plays through YouTube
   * while the server fetches it, so the next play uses the file (docs/mondrop-sync.md "Primo play").
   */
  downloadStates: Readonly<Record<string, DownloadUiState>>;
  /** Download state of the current song, if a first-play download was started for it. */
  currentDownload: DownloadUiState | null;
  /**
   * What this session learned about where files are (a finished first-play download = FS, with the addresses the
   * server sent), by songKey.
   */
  locationOverrides: Readonly<Record<string, Partial<SongStateLocation>>>;
  /** The "Sorgente" switch (rule W5): Auto (by network) · Internet · Media server. Remembered by this browser. */
  sourceMode: SourceMode;
  setSourceMode: (mode: SourceMode) => void;
  /** What `GET /api/net` said (rule W7). Auto uses it; a failed answer counts as external. */
  networkStatus: NetworkStatus;
  /** The switch with Auto resolved by the network: where the NEXT song will be taken from. */
  sourceChoice: SourceChoice;
  /** Where the current song is really playing from (media server, disk, YouTube); null while undecided or failed. */
  playingFrom: PlayFrom | null;
  /**
   * The switch was changed after the current song started: it applies from the next song (a running song is never
   * interrupted by the switch).
   */
  sourceChangePending: boolean;
  /**
   * What the picture box of the player page shows (rule W4): the video while the song really plays from the
   * YouTube fallback, the album cover when it plays from the local file or the video cannot start.
   */
  mediaBox: MediaBoxMode;
  /** Register the DOM node that hosts the YouTube iframe (PlayerPage slot). */
  setYoutubeMount: (el: HTMLElement | null) => void;
  /**
   * Start `songKey` and lock `list` as the sticky playback queue (Spotify-style).
   * Next/prev stay inside this list until another playSong call. `playlistId` is the playlist the queue comes
   * from (reported with the listening events): pass it (or null) when STARTING a queue, leave it out to keep
   * the current one (a song picked inside the queue that is already playing).
   */
  playSong: (songKey: string, list: AggregatedSong[], label?: string | null, playlistId?: string | null) => void;
  /** Rebuild the sticky queue from sessionStorage keys once the catalog is loaded. */
  hydrateQueue: (catalog: AggregatedSong[]) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
  patchCurrent: (patch: SongMetaPatchBody) => Promise<void>;
  updateSongInQueue: (songKey: string, meta: SongMetaRecord) => void;
  clearError: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const persisted = useRef(loadPersisted()).current;
  const playerRef = useRef<YtPlayer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountRef = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef<HTMLDivElement | null>(null);
  const loadSeqRef = useRef(0);
  const videoIdByKeyRef = useRef(new Map<string, string>());
  /** When set, playback is HTMLAudio from library MP3 (not YouTube). */
  const localFileModeRef = useRef(false);
  // Keep latest queue/index/repeat for YT event callbacks without rebinding the player.
  const queueRef = useRef<AggregatedSong[]>([]);
  const indexRef = useRef(0);
  const repeatRef = useRef<RepeatMode>('off');
  const shuffleRef = useRef(false);
  const autoplayRef = useRef(true);
  const loadVideoForSongRef = useRef<(song: AggregatedSong, autoplay: boolean) => Promise<void>>(async () => {});
  const nextTrackRef = useRef<() => void>(() => {});
  const consecutiveYtErrorsRef = useRef(0);
  const skipTimerRef = useRef<number | null>(null);
  /** Where files became available during this session (first-play downloads that finished), by songKey. */
  const readyLocationsRef = useRef<Record<string, Partial<SongStateLocation>>>({});
  /** The "Sorgente" switch, mirrored for the loader (it must read the current choice, not the one it closed over). */
  const sourceModeRef = useRef<SourceMode>('auto');
  /** `GET /api/net`, asked once per page load; null = failed (external). */
  const networkPromiseRef = useRef<Promise<NetworkKind | null> | null>(null);
  const networkSettledRef = useRef<{ done: boolean; value: NetworkKind | null }>({ done: false, value: null });
  /** Songs whose video id was already asked for ahead of time (once per song). */
  const prefetchedRef = useRef(new Set<string>());
  const downloadTrackerRef = useRef<DownloadTracker | null>(null);
  /** Listening sessions → events → offline-safe outbox (docs/mondrop-stats.md §1). */
  const playTrackerRef = useRef<PlayTracker | null>(null);
  const playQueueRef = useRef<PlayEventQueue | null>(null);
  const queuePlaylistIdRef = useRef<string | null>(persisted.playlistId ?? null);

  const [queue, setQueue] = useState<AggregatedSong[]>([]);
  const [index, setIndex] = useState(0);
  const [queueLabel, setQueueLabel] = useState<string | null>(persisted.queueLabel);
  const [playing, setPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(persisted.shuffle);
  const [repeat, setRepeat] = useState<RepeatMode>(persisted.repeat);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mountVersion, setMountVersion] = useState(0);
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadUiState>>({});
  const [sourceMode, setSourceModeState] = useState<SourceMode>(() => loadSourceMode());
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>('pending');
  /** The switch as it was resolved when the current song was loaded (to tell a pending change from a fallback). */
  const [loadedChoice, setLoadedChoice] = useState<SourceChoice | null>(null);
  // Picture box (rule W4): facts about WHAT is playing, per song; the decision itself is pure (player/mediaBox).
  const [media, dispatchMedia] = useReducer(mediaReducer, INITIAL_MEDIA_STATE);
  const hydratedRef = useRef(false);
  const queueLabelRef = useRef<string | null>(persisted.queueLabel);

  const current = queue[index] ?? null;

  useEffect(() => { sourceModeRef.current = sourceMode; }, [sourceMode]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { indexRef.current = index; }, [index]);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);
  useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);
  useEffect(() => { queueLabelRef.current = queueLabel; }, [queueLabel]);

  // Where is this browser? Asked once per page load (rule S5): Auto follows the answer, a failure counts as external.
  useEffect(() => {
    let cancelled = false;
    const asked = Promise.resolve()
      .then(() => fetchNetwork())
      .then((n): NetworkKind | null => n, (): NetworkKind | null => null);
    networkPromiseRef.current = asked;
    void asked.then((n) => {
      networkSettledRef.current = { done: true, value: n };
      if (!cancelled) setNetworkStatus(n ?? 'failed');
    });
    return () => { cancelled = true; };
  }, []);

  // Listening events: sessions of the player → offline-safe outbox → POST /api/plays. A failure here must never
  // reach the playback, so everything is wrapped and the transport only reports a status.
  useEffect(() => {
    const queue = new PlayEventQueue({
      storage: safeLocalStorage(),
      send: (events, opts) => sendPlays(events, opts),
    });
    const tracker = new PlayTracker({ onEvent: (event) => queue.enqueue(event) });
    playQueueRef.current = queue;
    playTrackerRef.current = tracker;
    queue.start();
    const onVisibility = () => {
      // Tab hidden: send what is already finished (a running song keeps playing, so its session stays open).
      if (document.visibilityState === 'hidden') void queue.flush({ keepalive: true });
    };
    const onPageHide = () => {
      tracker.finish();
      void queue.flush({ keepalive: true });
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      tracker.finish();
      queue.stop();
      void queue.flush({ keepalive: true });
      playTrackerRef.current = null;
      playQueueRef.current = null;
    };
  }, []);

  // First-play download: request + bounded polling. When a file turns up, mark the song local so the NEXT play
  // uses it; the playback that triggered the download is never interrupted.
  useEffect(() => {
    const tracker = createDownloadTracker({
      request: (songKey) => requestSongDownload(songKey, 'play'),
      poll: fetchSongState,
      onChange: (state) => {
        setDownloadStates((prev) => ({ ...prev, [state.songKey]: state }));
        if (state.phase === 'ready') {
          // The song in progress keeps playing from where it is: the picture box does not switch (W1/W4).
          dispatchMedia({ type: 'downloadReady', songKey: state.songKey });
          const learned = locationOverridesFrom({ [state.songKey]: state })[state.songKey];
          if (learned) readyLocationsRef.current[state.songKey] = learned;
          setQueue((q) => q.map((s) => (s.songKey === state.songKey ? { ...s, inLibrary: true } : s)));
        }
      },
    });
    downloadTrackerRef.current = tracker;
    return () => {
      tracker.dispose();
      downloadTrackerRef.current = null;
    };
  }, []);

  const persist = useCallback((
    songKey: string | null,
    nextShuffle: boolean,
    nextRepeat: RepeatMode,
    nextQueue: AggregatedSong[] = queueRef.current,
    nextLabel: string | null = queueLabelRef.current,
  ) => {
    savePersisted({
      songKey,
      songKeys: nextQueue.map((s) => s.songKey),
      queueLabel: nextLabel,
      playlistId: queuePlaylistIdRef.current,
      shuffle: nextShuffle,
      repeat: nextRepeat,
    });
  }, []);

  const setYoutubeMount = useCallback((el: HTMLElement | null) => {
    if (mountRef.current === el) return;
    mountRef.current = el;
    setMountVersion((v) => v + 1);
  }, []);

  const destroyPlayer = useCallback(() => {
    try {
      playerRef.current?.destroy();
    } catch {
      // ignore
    }
    playerRef.current = null;
  }, []);

  const hostElement = useCallback((): HTMLElement | null => {
    return mountRef.current ?? fallbackRef.current;
  }, []);

  const ensurePlayer = useCallback(async (): Promise<YtPlayer> => {
    await loadYoutubeApi();
    const host = hostElement();
    if (!host) throw new Error('YouTube mount missing');
    if (playerRef.current) return playerRef.current;

    const YT = window.YT;
    if (!YT?.Player) throw new Error('YouTube API unavailable');

    // YT.Player replaces the target node with an iframe — always give it a
    // fresh empty child so remounts (page ↔ mini fallback) keep working.
    host.replaceChildren();
    const target = document.createElement('div');
    target.className = 'sr-yt-target';
    host.appendChild(target);

    const player = await new Promise<YtPlayer>((resolve, reject) => {
      let settled = false;
      const p = new YT.Player(target, {
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          // Hide native YT chrome — Tesla users were only hitting the iframe Stop.
          controls: 0,
          fs: 0,
          disablekb: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (e) => {
            if (settled) return;
            settled = true;
            resolve(e.target);
          },
          onStateChange: (e) => {
            // Listening time (best effort): only PLAYING counts; pause, buffering, cue… stop the clock.
            const tracker = playTrackerRef.current;
            if (e.data === YT_PLAYING) {
              tracker?.playing();
              try { tracker?.setDuration((e.target.getDuration() || 0) * 1000); } catch { /* ignore */ }
            } else if (e.data === YT_ENDED) tracker?.ended();
            else tracker?.paused();
            // "Sto caricando…" lasts until the video plays (or is paused / cued / over): buffering and the
            // unstarted state that can come first do not end it.
            if (e.data === YT_PLAYING || e.data === YT_PAUSED || e.data === YT_ENDED || e.data === YT_CUED) setLoading(false);
            if (e.data === YT_PLAYING) {
              consecutiveYtErrorsRef.current = 0;
              setPlaying(true);
              setMediaSessionPlaybackState(true);
              setDuration(e.target.getDuration() || 0);
              setError(null);
            } else if (e.data === YT_PAUSED) {
              setPlaying(false);
              setMediaSessionPlaybackState(false);
            } else if (e.data === YT_ENDED) {
              const q = queueRef.current;
              const i = indexRef.current;
              const r = repeatRef.current;
              if (r === 'one') {
                e.target.seekTo(0, true);
                e.target.playVideo();
                return;
              }
              const ni = nextIndex(i, q.length, r);
              if (ni == null) {
                setPlaying(false);
                setMediaSessionPlaybackState(false);
                return;
              }
              const song = q[ni];
              if (!song) return;
              setIndex(ni);
              indexRef.current = ni;
              persist(song.songKey, shuffleRef.current, r);
              void loadVideoForSongRef.current(song, true);
            }
          },
          onError: (e) => {
            const code = typeof e.data === 'number' ? e.data : Number(e.data);
            const song = queueRef.current[indexRef.current];
            // Video cannot play (no such video, embed blocked…): the picture box goes back to the cover.
            if (song) dispatchMedia({ type: 'videoFailed', songKey: song.songKey });
            if (song && (code === 2 || code === 100)) {
              // Stale / bad id — force a fresh resolve next time.
              videoIdByKeyRef.current.delete(song.songKey);
            }
            setError(youtubeErrorMessage(code));
            setLoading(false);
            setPlaying(false);
            setMediaSessionPlaybackState(false);
            if (!youtubeErrorShouldSkip(code)) return;
            consecutiveYtErrorsRef.current += 1;
            // Avoid spinning the whole queue when Tesla HTML5 keeps failing.
            if (consecutiveYtErrorsRef.current > Math.min(8, Math.max(2, queueRef.current.length))) {
              setError(`${youtubeErrorMessage(code)} · stop auto-skip`);
              return;
            }
            if (skipTimerRef.current != null) window.clearTimeout(skipTimerRef.current);
            skipTimerRef.current = window.setTimeout(() => {
              skipTimerRef.current = null;
              nextTrackRef.current();
            }, 1200);
          },
        },
      });
      window.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('YouTube player ready timeout'));
        }
      }, 15000);
      void p;
    });

    playerRef.current = player;
    return player;
  }, [hostElement, persist]);

  const stopLocalAudio = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    localFileModeRef.current = false;
  }, []);

  /** The network, waiting a moment for `GET /api/net` on the very first play of a page. null = external. */
  const networkNow = useCallback(async (): Promise<NetworkKind | null> => {
    const settled = networkSettledRef.current;
    if (settled.done) return settled.value;
    const asked = networkPromiseRef.current;
    if (!asked) return null;
    let timer: number | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), NETWORK_WAIT_MS);
    });
    try {
      return await Promise.race([asked, timeout]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }, []);

  const loadVideoForSong = useCallback(async (song: AggregatedSong, autoplay: boolean) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    setCurrentTime(0);
    setDuration(0);
    autoplayRef.current = autoplay;
    // The previous song's listening session ends here; this one starts when playback really begins.
    playTrackerRef.current?.setSong({ songKey: song.songKey, playlistId: queuePlaylistIdRef.current });
    dispatchMedia({ type: 'songChanged', songKey: song.songKey });

    // 1. Where is the file? The flags that came with the list are trusted when they say "at home" (a download of
    //    this session counts). When they say "nowhere" the server is asked, fresh: a download may have finished
    //    since the list was loaded. `knownNotLocal` is true only when the server positively said "no file".
    let location = resolveSongLocation(song, readyLocationsRef.current[song.songKey]);
    let knownNotLocal = false;
    if (!isAtHome(location)) {
      try {
        location = locationFromState(await fetchSongState(song.songKey));
        knownNotLocal = !isAtHome(location);
      } catch {
        // The server cannot say: no file is assumed, no download is asked, the video plays.
      }
      if (seq !== loadSeqRef.current) return;
    }

    // 2. The "Sorgente" switch (rules W5–W7). Auto looks at the network; a slow or failed answer counts as external.
    const mode = sourceModeRef.current;
    const network = mode === 'auto' ? await networkNow() : null;
    if (seq !== loadSeqRef.current) return;
    const plan = effectiveSource(mode, network, location);
    setLoadedChoice(plan.choice);

    // 3. A file at home: the backend streams it (the media server first, geekom's disk if the Fritz does not have
    //    it yet) and never copies it. The picture box then shows the cover and the badge says where it comes from.
    if (plan.from !== 'youtube') {
      try {
        stopLocalAudio();
        try { playerRef.current?.pauseVideo(); } catch { /* ignore */ }
        localFileModeRef.current = true;
        dispatchMedia({ type: 'localStarted', songKey: song.songKey, from: plan.from });
        const a = audioRef.current ?? new Audio();
        audioRef.current = a;
        a.preload = 'auto'; // start as soon as the first bytes arrive: no IFrame, nothing else to wait for
        a.src = `/api/songs/${encodeURIComponent(song.songKey)}/file`;
        a.onended = () => { playTrackerRef.current?.ended(); nextTrackRef.current(); };
        a.ontimeupdate = () => setCurrentTime(a.currentTime || 0);
        a.onloadedmetadata = () => {
          setDuration(a.duration || 0);
          playTrackerRef.current?.setDuration((a.duration || 0) * 1000);
        };
        // Listening time: "playing" resumes the clock; pause, buffering and errors stop it (a seek changes nothing).
        a.onplaying = () => playTrackerRef.current?.playing();
        a.onwaiting = () => playTrackerRef.current?.paused();
        a.onplay = () => {
          setPlaying(true);
          setMediaSessionPlaybackState(true);
          setError(null);
        };
        a.onpause = () => {
          playTrackerRef.current?.paused();
          setPlaying(false);
          setMediaSessionPlaybackState(false);
        };
        a.onerror = () => {
          playTrackerRef.current?.paused();
          localFileModeRef.current = false;
          setError('Uffa — file locale non riproducibile, provo YouTube');
          // fall through to YouTube below by clearing and continuing
        };
        setMediaSessionMetadata(song);
        if (autoplay) {
          const giveUp = window.setTimeout(() => { if (seq === loadSeqRef.current) setLoading(false); }, LOADING_MAX_MS);
          try {
            await a.play();
            window.clearTimeout(giveUp);
            setLoading(false);
            consecutiveYtErrorsRef.current = 0;
            return;
          } catch {
            window.clearTimeout(giveUp);
            localFileModeRef.current = false;
          }
        } else {
          setLoading(false);
          return;
        }
      } catch {
        // The file could not be set up — the YouTube fallback below.
        localFileModeRef.current = false;
      }
      if (seq !== loadSeqRef.current) return;
    }

    // 4. Internet (YouTube): by choice, because the song is not at home, or because its file could not play.
    //    First play of a song that is on neither FS nor the media server: it starts through YouTube right now and,
    //    in parallel, the server fetches it (priority "play") and puts it on the media server. Once per song per
    //    session, WHATEVER the switch says (S6).
    if (plan.download && knownNotLocal && autoplay && seq === loadSeqRef.current) {
      downloadTrackerRef.current?.start(song.songKey);
    }

    stopLocalAudio();
    // From here the song plays from the video (the picture box shows it) unless the video turns out not to work.
    dispatchMedia({ type: 'videoRequested', songKey: song.songKey });
    let videoId = videoIdByKeyRef.current.get(song.songKey);
    if (!videoId) {
      try {
        const src = await fetchSongYoutube(song.songKey);
        videoId = src.videoId;
        videoIdByKeyRef.current.set(song.songKey, videoId);
      } catch {
        dispatchMedia({ type: 'videoFailed', songKey: song.songKey });
        if (seq !== loadSeqRef.current) return;
        setLoading(false);
        setPlaying(false);
        setError('YouTube non trovato per questo brano');
        return;
      }
    }

    if (seq !== loadSeqRef.current) return;

    try {
      // Remount may have destroyed the previous player.
      if (!playerRef.current || !hostElement()?.querySelector('iframe')) {
        destroyPlayer();
      }
      const player = await ensurePlayer();
      if (seq !== loadSeqRef.current) return;
      setMediaSessionMetadata(song);
      if (autoplay) {
        player.loadVideoById(videoId);
        player.playVideo();
        // still "Sto caricando…": the state change to PLAYING (or anything else but buffering) ends it
        window.setTimeout(() => { if (seq === loadSeqRef.current) setLoading(false); }, LOADING_MAX_MS);
      } else {
        player.cueVideoById(videoId);
        setLoading(false);
      }
    } catch {
      dispatchMedia({ type: 'videoFailed', songKey: song.songKey });
      if (seq !== loadSeqRef.current) return;
      setLoading(false);
      setPlaying(false);
      setError('Impossibile avviare YouTube');
    }
  }, [destroyPlayer, ensurePlayer, hostElement, networkNow, stopLocalAudio]);

  useEffect(() => {
    loadVideoForSongRef.current = loadVideoForSong;
  }, [loadVideoForSong]);

  // Recreate player when the mount node changes (PlayerPage slot ↔ hidden fallback).
  useEffect(() => {
    const song = queueRef.current[indexRef.current];
    const wasPlaying = playing;
    const t = playerRef.current ? (() => {
      try { return playerRef.current!.getCurrentTime(); } catch { return 0; }
    })() : 0;
    destroyPlayer();
    // A song that plays from the home file has no video to bring back (its id may be cached from a prefetch).
    if (song && !localFileModeRef.current && videoIdByKeyRef.current.has(song.songKey)) {
      void (async () => {
        try {
          const player = await ensurePlayer();
          const id = videoIdByKeyRef.current.get(song.songKey)!;
          if (wasPlaying) {
            player.loadVideoById(id, t);
            player.playVideo();
          } else {
            player.cueVideoById(id, t);
          }
        } catch {
          // ignore remount errors
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when mount host identity changes
  }, [mountVersion]);

  // While a song plays, ask for the video id of the NEXT one (once per song) — when it will play from YouTube. The id
  // lookup is what made starting a song slow (up to a few seconds when the server has to search); with it already in
  // `videoIdByKeyRef` the next song goes straight to the player. A song at home never needs it.
  const prefetchNextVideo = useCallback((fromIndex: number) => {
    if (repeatRef.current === 'one') return; // the same song again: its id (if any) is already there
    const q = queueRef.current;
    const ni = nextIndex(fromIndex, q.length, repeatRef.current);
    if (ni == null) return;
    const upcoming = q[ni];
    if (!upcoming || prefetchedRef.current.has(upcoming.songKey) || videoIdByKeyRef.current.has(upcoming.songKey)) return;
    const location = resolveSongLocation(upcoming, readyLocationsRef.current[upcoming.songKey]);
    if (effectiveSource(sourceModeRef.current, networkSettledRef.current.value, location).from !== 'youtube') return;
    prefetchedRef.current.add(upcoming.songKey);
    fetchSongYoutube(upcoming.songKey)
      .then((src) => { videoIdByKeyRef.current.set(upcoming.songKey, src.videoId); })
      .catch(() => { prefetchedRef.current.delete(upcoming.songKey); }); // not found now: the real play asks again
  }, []);

  // Only once the current song really plays (not while it is still starting: its own lookup goes first).
  useEffect(() => {
    if (playing && !loading) prefetchNextVideo(index);
  }, [playing, loading, index, queue, repeat, prefetchNextVideo]);

  // Poll currentTime while playing (YT has no timeupdate event).
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        setCurrentTime(p.getCurrentTime() || 0);
        const d = p.getDuration() || 0;
        if (d) setDuration(d);
      } catch {
        // ignore
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [playing]);

  const playSong = useCallback((songKey: string, list: AggregatedSong[], label: string | null = null, playlistId?: string | null) => {
    let { queue: nextQueue, index: nextIndexPos } = queueFromList(list, songKey);
    if (shuffle && nextQueue.length > 1) {
      const shuffled = shuffleKeepingCurrent(nextQueue, nextIndexPos);
      nextQueue = shuffled.queue;
      nextIndexPos = shuffled.index;
    }
    const nextLabel = label ?? queueLabelRef.current;
    if (playlistId !== undefined) queuePlaylistIdRef.current = playlistId;
    setQueueLabel(nextLabel);
    queueLabelRef.current = nextLabel;
    setQueue(nextQueue);
    queueRef.current = nextQueue;
    setIndex(nextIndexPos);
    indexRef.current = nextIndexPos;
    persist(songKey, shuffle, repeat, nextQueue, nextLabel);
    const song = nextQueue[nextIndexPos];
    if (song) void loadVideoForSong(song, true);
  }, [shuffle, repeat, persist, loadVideoForSong]);

  const hydrateQueue = useCallback((catalog: AggregatedSong[]) => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (queueRef.current.length > 0) return;
    const saved = loadPersisted();
    const rebuilt = rebuildQueueFromKeys(catalog, saved.songKeys, saved.songKey);
    if (!rebuilt) return;
    setQueueLabel(saved.queueLabel);
    queueLabelRef.current = saved.queueLabel;
    queuePlaylistIdRef.current = saved.playlistId ?? null;
    setQueue(rebuilt.queue);
    queueRef.current = rebuilt.queue;
    setIndex(rebuilt.index);
    indexRef.current = rebuilt.index;
    persist(saved.songKey, saved.shuffle, saved.repeat, rebuilt.queue, saved.queueLabel);
  }, [persist]);

  const toggle = useCallback(() => {
    if (!current) return;
    if (localFileModeRef.current && audioRef.current) {
      const a = audioRef.current;
      if (a.paused) void a.play();
      else a.pause();
      return;
    }
    const p = playerRef.current;
    // After a YT error the iframe is often dead — reload instead of only Stop.
    if (!p || error) {
      void loadVideoForSong(current, true);
      return;
    }
    try {
      const state = p.getPlayerState();
      if (state === YT_PLAYING) {
        p.pauseVideo();
      } else {
        p.playVideo();
      }
    } catch {
      void loadVideoForSong(current, true);
    }
  }, [current, error, loadVideoForSong]);

  const goToIndex = useCallback((next: number | null, autoplay: boolean) => {
    if (next == null) {
      try { playerRef.current?.pauseVideo(); } catch { /* ignore */ }
      setPlaying(false);
      setMediaSessionPlaybackState(false);
      return;
    }
    setIndex(next);
    indexRef.current = next;
    const song = queueRef.current[next];
    if (song) {
      persist(song.songKey, shuffleRef.current, repeatRef.current);
      void loadVideoForSong(song, autoplay);
    }
  }, [persist, loadVideoForSong]);

  const next = useCallback(() => {
    if (skipTimerRef.current != null) {
      window.clearTimeout(skipTimerRef.current);
      skipTimerRef.current = null;
    }
    const advanceRepeat: RepeatMode = repeatRef.current === 'one' ? 'all' : repeatRef.current;
    goToIndex(nextIndex(indexRef.current, queueRef.current.length, advanceRepeat), true);
  }, [goToIndex]);

  useEffect(() => {
    nextTrackRef.current = next;
  }, [next]);

  const previous = useCallback(() => {
    if (skipTimerRef.current != null) {
      window.clearTimeout(skipTimerRef.current);
      skipTimerRef.current = null;
    }
    const p = playerRef.current;
    try {
      if (p && p.getCurrentTime() > 3) {
        p.seekTo(0, true);
        setCurrentTime(0);
        return;
      }
    } catch { /* ignore */ }
    const advanceRepeat: RepeatMode = repeatRef.current === 'one' ? 'all' : repeatRef.current;
    goToIndex(prevIndex(indexRef.current, queueRef.current.length, advanceRepeat), true);
  }, [goToIndex]);

  const seek = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds)) return;
    if (localFileModeRef.current && audioRef.current) {
      audioRef.current.currentTime = Math.max(0, seconds);
      setCurrentTime(seconds);
      return;
    }
    const p = playerRef.current;
    if (!p) return;
    try {
      p.seekTo(Math.max(0, seconds), true);
      setCurrentTime(seconds);
    } catch { /* ignore */ }
  }, []);

  const toggleShuffle = useCallback(() => {
    setShuffle((prev) => {
      const nextShuffle = !prev;
      if (nextShuffle && queue.length > 1) {
        const { queue: shuffled, index: newIndex } = shuffleKeepingCurrent(queue, index);
        setQueue(shuffled);
        queueRef.current = shuffled;
        setIndex(newIndex);
        indexRef.current = newIndex;
      }
      persist(current?.songKey ?? null, nextShuffle, repeat);
      return nextShuffle;
    });
  }, [queue, index, current, repeat, persist]);

  const cycleRepeatMode = useCallback(() => {
    setRepeat((prev) => {
      const nextMode = cycleRepeat(prev);
      persist(current?.songKey ?? null, shuffle, nextMode);
      return nextMode;
    });
  }, [current, shuffle, persist]);

  const patchCurrent = useCallback(async (patch: SongMetaPatchBody) => {
    if (!current) return;
    const songKey = current.songKey;
    setQueue((q) =>
      q.map((s) => {
        if (s.songKey !== songKey) return s;
        const base = s.meta ?? {
          songKey,
          deezerId: null,
          itunesId: null,
          genres: [],
          album: null,
          coverUrl: null,
          previewUrl: null,
          deezerUrl: null,
          itunesUrl: null,
          enrichedAt: null,
          listened: false,
          favorite: false,
          downloaded: false,
          rating: null,
          score: null,
        };
        const meta: SongMetaRecord = { ...base };
        if (patch.listened !== undefined) meta.listened = patch.listened;
        if (patch.favorite !== undefined) meta.favorite = patch.favorite;
        if (patch.downloaded !== undefined) meta.downloaded = patch.downloaded;
        if (patch.rating !== undefined) meta.rating = patch.rating;
        if (patch.score !== undefined) meta.score = patch.score;
        if (
          (patch.rating !== undefined && patch.rating !== null) ||
          (patch.score !== undefined && patch.score !== null)
        ) {
          meta.listened = true;
        }
        return { ...s, meta };
      }),
    );
    try {
      await patchSongMeta(songKey, patch);
    } catch {
      setError('Salvataggio preferito/rate fallito');
    }
  }, [current]);

  const updateSongInQueue = useCallback((songKey: string, meta: SongMetaRecord) => {
    setQueue((q) => q.map((s) => (s.songKey === songKey ? { ...s, meta } : s)));
  }, []);

  useEffect(() => {
    bindMediaSessionHandlers({
      play: () => { try { playerRef.current?.playVideo(); } catch { /* ignore */ } },
      pause: () => { try { playerRef.current?.pauseVideo(); } catch { /* ignore */ } },
      next,
      previous,
      seek,
    });
    setMediaSessionMetadata(current);
  }, [current, next, previous, seek]);

  const locationOverrides = useMemo(() => locationOverridesFrom(downloadStates), [downloadStates]);

  const setSourceMode = useCallback((mode: SourceMode) => {
    sourceModeRef.current = mode;
    setSourceModeState(mode);
    saveSourceMode(mode);
  }, []);
  const sourceChoice = sourceChoiceFor(
    sourceMode,
    networkStatus === 'internal' || networkStatus === 'external' ? networkStatus : null,
  );
  const sourceChangePending = current !== null && loadedChoice !== null && loadedChoice !== sourceChoice;

  const value = useMemo<PlayerContextValue>(() => ({
    queue,
    index,
    current,
    queueLabel,
    playing,
    shuffle,
    repeat,
    currentTime,
    duration,
    loading,
    error,
    downloadStates,
    currentDownload: current ? (downloadStates[current.songKey] ?? null) : null,
    locationOverrides,
    mediaBox: chooseMediaBox(media),
    sourceMode,
    setSourceMode,
    networkStatus,
    sourceChoice,
    playingFrom: playingFromOf(media),
    sourceChangePending,
    setYoutubeMount,
    playSong,
    hydrateQueue,
    toggle,
    next,
    previous,
    seek,
    toggleShuffle,
    cycleRepeatMode,
    patchCurrent,
    updateSongInQueue,
    clearError: () => setError(null),
  }), [
    queue, index, current, queueLabel, playing, shuffle, repeat, currentTime, duration,
    loading, error, downloadStates, locationOverrides, media, sourceMode, setSourceMode, networkStatus, sourceChoice,
    sourceChangePending, setYoutubeMount, playSong, hydrateQueue, toggle, next, previous, seek,
    toggleShuffle, cycleRepeatMode, patchCurrent, updateSongInQueue,
  ]);

  return (
    <PlayerContext.Provider value={value}>
      {children}
      {/* Hidden fallback host so playback can continue off /player (mini-player). */}
      <div
        ref={fallbackRef}
        className="sr-yt-fallback"
        aria-hidden
      />
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
