import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import { ratingFromScore } from '../utils/filmRating';
import type { AggregatedSong } from '../types';
import type { SongMetaPatchBody } from '../services/api';
import { fetchSongPreview } from '../services/api';

interface SongCardProps {
  song: AggregatedSong;
  onPatch: (patch: SongMetaPatchBody) => void;
}

// A single shared <audio> element so starting one preview always stops
// whichever other song was playing — module-level because previews are a
// page-wide "only one at a time" concern, not something scoped to one card.
// `playing` state is *derived* from this (via useSyncExternalStore below)
// rather than mirrored into per-card useState: a card's own onpause/onended
// closures raced the key reassignment when switching cards directly, so
// card A could still be showing ⏸ after B took over playback. Deriving from
// the single source of truth on every notify() removes that whole class of
// bug instead of patching around it.
let sharedAudio: HTMLAudioElement | null = null;
let sharedAudioKey: string | null = null;
const listeners = new Set<() => void>();

// Guards the async gap in togglePreview (below): resolving a preview URL is
// an `await fetchSongPreview(...)` round-trip, and a newer click — on this
// card or any other — can land while an older one is still in flight. Since
// resolution latency isn't ordered (a Deezer live-resolve can be slower than
// a stored-iTunes-URL lookup), the *later* click can finish first; without a
// guard, an older click's continuation would then run anyway and stomp
// whatever the later click already started playing. Every togglePreview
// invocation claims the next value before its first await; after every
// subsequent await it checks whether it's still current before touching
// shared state, so only the most recent click ever gets to act.
let previewRequestSeq = 0;

function notify(): void {
  listeners.forEach((l) => l());
}

/**
 * Pure form of the snapshot check, taking the active key/audio explicitly
 * instead of reading module state — exported so the logic is unit-testable
 * without a DOM `<audio>` element or a render harness. `ended` is checked
 * separately from `paused`: a finished HTMLAudioElement reports
 * `paused === true` too, but relying on that alone is fragile — checking
 * `ended` explicitly makes the "playback finished" case unambiguous instead
 * of piggybacking on a side-effect of how the browser happens to report it.
 */
export function computeIsPlaying(
  songKey: string,
  activeKey: string | null,
  audio: { paused: boolean; ended: boolean } | null
): boolean {
  return activeKey === songKey && !!audio && !audio.paused && !audio.ended;
}

/** Snapshot of "is this song's preview currently the one playing", read from module state. */
export function isPreviewPlaying(songKey: string): boolean {
  return computeIsPlaying(songKey, sharedAudioKey, sharedAudio);
}

/**
 * Clears shared-audio ownership when `key` currently holds it, and notifies
 * subscribers. Used on unmount (below), and — critically — after a rejected
 * `play()` or a failed preview-URL fetch: without releasing ownership there,
 * `sharedAudioKey` would keep pointing at a song whose audio never actually
 * started, so the next ▶ click would hit the "this song owns the key, so
 * pause it" branch and call `.pause()` on an already-silent element instead
 * of retrying — the button would look inert forever.
 */
function releaseSharedAudioIfOwner(key: string): void {
  if (sharedAudioKey === key) {
    sharedAudio = null;
    sharedAudioKey = null;
    notify();
  }
}

/** Test-only: seeds module state directly so releaseSharedAudioIfOwner is
 * unit-testable without a DOM `<audio>` element or a render harness. */
export function _setSharedAudioForTest(key: string | null, audio: { paused: boolean } | null): void {
  sharedAudioKey = key;
  sharedAudio = audio as HTMLAudioElement | null;
}

/** Test-only: reads back the module-private owner key. */
export function _getSharedAudioKeyForTest(): string | null {
  return sharedAudioKey;
}

/** Test-only: exposes releaseSharedAudioIfOwner for direct unit testing. */
export function _releaseSharedAudioIfOwnerForTest(key: string): void {
  releaseSharedAudioIfOwner(key);
}

/**
 * Pure form of togglePreview's post-await staleness check: `myReq` is the
 * sequence number a call claimed right before its first await; `currentSeq`
 * is the live module counter at the point the continuation is about to
 * touch shared state. A mismatch means a newer call (this card or another)
 * has since claimed the counter, so this continuation must no-op instead of
 * resurrecting/stomping whatever the newer call already did.
 */
export function isPreviewRequestStale(myReq: number, currentSeq: number): boolean {
  return myReq !== currentSeq;
}

/** Test-only: reads the module-private preview-request sequence counter. */
export function _getPreviewRequestSeqForTest(): number {
  return previewRequestSeq;
}

/** Test-only: simulates a togglePreview call claiming the next sequence
 * number (mirrors `++previewRequestSeq` in the real code), returning it. */
export function _bumpPreviewRequestSeqForTest(): number {
  return ++previewRequestSeq;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

/** Exported for unit testing the leading-space trim when `artist` is empty. */
export function youtubeSearchUrl(artist: string, title: string): string {
  return `https://youtube.com/results?search_query=${encodeURIComponent(`${artist} ${title}`.trim())}`;
}

/** One deduplicated song row: cover art, genre badges, rating slider and quick actions. */
export function SongCard({ song, onPatch }: SongCardProps) {
  const { t } = useLanguage();
  const meta = song.meta;
  // Slider position while dragging; null when idle (shows the stored score).
  const [sliderDraft, setSliderDraft] = useState<number | null>(null);
  const playing = useSyncExternalStore(subscribe, () => isPreviewPlaying(song.songKey));

  // If this card unmounts (filtered out, navigated away) while its own
  // preview is the one playing, stop it and release ownership — otherwise
  // it would keep playing silently in the background with no visible
  // control left to pause it.
  useEffect(() => {
    return () => {
      if (sharedAudioKey === song.songKey) {
        sharedAudio?.pause();
        sharedAudio = null;
        sharedAudioKey = null;
        notify();
      }
    };
  }, [song.songKey]);

  const sliderValue = sliderDraft ?? meta?.score ?? 50;
  const youtubeUrl = song.youtubeUrl || youtubeSearchUrl(song.artist, song.title);

  function commitSlider() {
    if (sliderDraft == null) return;
    const value = sliderDraft;
    setSliderDraft(null);
    if (value === meta?.score) return;
    // Explicit 👍/👎 clicks win; the slider only derives a rating in its
    // outer zones (<20 dislike, >80 like) — mid-range keeps the current one.
    const derived = ratingFromScore(value);
    const patch: SongMetaPatchBody = { score: value };
    if (derived) patch.rating = derived === 'fresh' ? 'like' : 'dislike';
    onPatch(patch);
  }

  async function togglePreview() {
    if (!meta || (!meta.previewUrl && !meta.deezerId)) return;

    if (sharedAudioKey === song.songKey && sharedAudio) {
      // Bump the sequence so a still-in-flight fetch from an earlier click
      // can't resurrect playback after the user just paused it.
      previewRequestSeq++;
      sharedAudio.pause(); // onpause below calls notify()
      return;
    }

    // Claim this call's sequence number before the first await. If a newer
    // call (this card or another — the counter is module-level/shared)
    // claims a higher number while we're awaiting, `myReq` goes stale and
    // every check below no-ops instead of stomping the newer call's state.
    const myReq = ++previewRequestSeq;

    // Always resolve through the backend rather than trusting a locally
    // cached URL: a Deezer-backed preview expires ~14min after issue, so it
    // has to be re-resolved live on every play-press. The iTunes-backed
    // case is durable — the backend just echoes the stored value back — so
    // there's no need to special-case it here; it's one tiny call either way.
    let resolvedUrl: string;
    try {
      resolvedUrl = await fetchSongPreview(song.songKey);
    } catch {
      if (isPreviewRequestStale(myReq, previewRequestSeq)) return;
      releaseSharedAudioIfOwner(song.songKey);
      return;
    }

    if (isPreviewRequestStale(myReq, previewRequestSeq)) return;

    if (sharedAudio) {
      sharedAudio.pause();
      sharedAudio.onended = null;
      sharedAudio.onpause = null;
    }

    const audio = new Audio(resolvedUrl);
    sharedAudio = audio;
    sharedAudioKey = song.songKey;
    audio.onended = () => notify();
    audio.onpause = () => notify();
    void audio.play().catch(() => releaseSharedAudioIfOwner(song.songKey));
    notify();
  }

  return (
    <div className="list-item-row">
      {meta?.coverUrl ? (
        <img src={meta.coverUrl} alt="" className="song-cover" loading="lazy" />
      ) : (
        <div className="list-item-icon">🎵</div>
      )}
      <div className="list-item-content">
        <div className="list-item-title">
          {song.title}
          <button
            type="button"
            className={`watched-toggle ${meta?.listened ? 'active' : ''}`}
            title={t.songsMarkListened}
            onClick={() => onPatch({ listened: !(meta?.listened ?? false) })}
          >
            👂
          </button>
          <button
            type="button"
            className={`watched-toggle ${meta?.favorite ? 'active' : ''}`}
            title={t.songsMarkFavorite}
            onClick={() => onPatch({ favorite: !(meta?.favorite ?? false) })}
          >
            ⭐
          </button>
        </div>
        <div className="list-item-subtitle">
          {song.artist || t.unknownArtist}
          {(meta?.album || song.album) && <span className="list-item-muted"> — {meta?.album || song.album}</span>}
        </div>

        {meta && meta.genres.length > 0 && (
          <div className="list-item-badges">
            {meta.genres.map((g) => (
              <span key={g} className="genre-badge">{g}</span>
            ))}
          </div>
        )}

        <div className="film-controls">
          <button
            type="button"
            className={`rating-btn ${meta?.rating === 'dislike' ? 'active' : ''}`}
            title={t.songsMarkDislike}
            onClick={() => onPatch({ rating: meta?.rating === 'dislike' ? null : 'dislike' })}
          >
            👎
          </button>
          <input
            type="range"
            className="rating-slider"
            min={0}
            max={100}
            step={1}
            value={sliderValue}
            aria-label={t.songsMarkLike}
            onChange={(e) => setSliderDraft(Number(e.target.value))}
            onPointerUp={commitSlider}
            onKeyUp={commitSlider}
            onBlur={commitSlider}
          />
          <button
            type="button"
            className={`rating-btn ${meta?.rating === 'like' ? 'active' : ''}`}
            title={t.songsMarkLike}
            onClick={() => onPatch({ rating: meta?.rating === 'like' ? null : 'like' })}
          >
            👍
          </button>
          <span className={`rating-score-label ${meta?.score == null && sliderDraft == null ? 'unset' : ''}`}>
            {sliderDraft ?? meta?.score ?? '—'}
            {(sliderDraft != null || meta?.score != null) && '%'}
          </span>
          <button
            type="button"
            className={`watched-toggle ${meta?.downloaded ? 'active' : ''}`}
            title={t.songsMarkDownloaded}
            onClick={() => onPatch({ downloaded: !(meta?.downloaded ?? false) })}
          >
            ⬇
          </button>
        </div>

        <div className="list-item-badges">
          {meta?.deezerUrl && (
            <a href={meta.deezerUrl} target="_blank" rel="noopener noreferrer" className="badge-link deezer">
              Deezer
            </a>
          )}
          {meta?.itunesUrl && (
            <a href={meta.itunesUrl} target="_blank" rel="noopener noreferrer" className="badge-link applemusic">
              Apple Music
            </a>
          )}
          <a href={youtubeUrl} target="_blank" rel="noopener noreferrer" className="badge-link youtube">
            YouTube
          </a>
          {meta && (meta.previewUrl || meta.deezerId) && (
            <button
              type="button"
              className={`song-preview-btn ${playing ? 'playing' : ''}`}
              title={t.songsPreview}
              onClick={togglePreview}
            >
              {playing ? '⏸' : '▶'}
            </button>
          )}
        </div>
      </div>

      <Link to={`/?entry=${song.mentions[0].entryId}`} className="list-item-action">
        ×{song.mentions.length} {t.songsMentions}
      </Link>
    </div>
  );
}
