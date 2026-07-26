import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import { ratingFromScore } from '../utils/filmRating';
import type { AggregatedSong } from '../types';
import type { SongMetaPatchBody } from '../services/api';

interface SongCardProps {
  song: AggregatedSong;
  onPatch: (patch: SongMetaPatchBody) => void;
}

// A single shared <audio> element so starting one preview always stops
// whichever other song was playing — module-level because previews are a
// page-wide "only one at a time" concern, not something scoped to one card.
let sharedAudio: HTMLAudioElement | null = null;
let sharedAudioKey: string | null = null;

function youtubeSearchUrl(artist: string, title: string): string {
  return `https://youtube.com/results?search_query=${encodeURIComponent(`${artist} ${title}`)}`;
}

/** One deduplicated song row: cover art, genre badges, rating slider and quick actions. */
export function SongCard({ song, onPatch }: SongCardProps) {
  const { t } = useLanguage();
  const meta = song.meta;
  // Slider position while dragging; null when idle (shows the stored score).
  const [sliderDraft, setSliderDraft] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // Guards against a stray 'ended'/'pause' event from a stopped-and-discarded
  // audio element flipping this card's playing state after another card has
  // already taken over sharedAudio.
  const cardKeyRef = useRef(song.songKey);
  cardKeyRef.current = song.songKey;

  // If this card unmounts (filtered out, navigated away) while its own
  // preview is the one playing, stop it — otherwise it would keep playing
  // silently in the background with no visible control left to pause it.
  useEffect(() => {
    return () => {
      if (sharedAudioKey === cardKeyRef.current) {
        sharedAudio?.pause();
      }
    };
  }, []);

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

  function togglePreview() {
    const url = meta?.previewUrl;
    if (!url) return;

    if (playing && sharedAudioKey === song.songKey) {
      sharedAudio?.pause();
      return;
    }

    if (sharedAudio) {
      sharedAudio.pause();
      sharedAudio.onended = null;
      sharedAudio.onpause = null;
    }

    const audio = new Audio(url);
    sharedAudio = audio;
    sharedAudioKey = song.songKey;
    setPlaying(true);
    audio.onended = () => {
      if (sharedAudioKey === song.songKey) setPlaying(false);
    };
    audio.onpause = () => {
      if (sharedAudioKey === song.songKey) setPlaying(false);
    };
    void audio.play().catch(() => setPlaying(false));
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
          {meta?.previewUrl && (
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
