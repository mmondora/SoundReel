import { useState } from 'react';
import { interpolate, useLanguage } from '../../i18n';
import { platformLabel } from '../../utils/platformLabel';
import { relativeTime } from '../../utils/relativeTime';
import { CollectionChips } from '../CollectionChips';
import type { PostCardModel } from './postCard';

// The Bacheca (look and feel P3, board B of the mockups): a wall of cards, each post with its media in view. A card is a real button (keyboard,
// one tab stop, pressed state) that opens the detail of the post; where the detail goes (a panel that closes) is the page's business.
// A button holds only phrasing content, so everything inside a card is a span that the stylesheet lays out.

interface WallCardProps {
  post: PostCardModel;
  selected: boolean;
  onSelect: (id: string) => void;
}

function WallCard({ post, selected, onSelect }: WallCardProps) {
  const { t } = useLanguage();
  const [imgError, setImgError] = useState(false);
  const date = post.createdAt ? new Date(post.createdAt) : null;
  const label = platformLabel(post.platform);
  const moreSongs = post.songCount - post.songs.length;
  const moreFilms = post.filmCount - post.films.length;
  // a list that carries only counts (the summaries) shows them; one that puts the media in view does not repeat them
  const counts: string[] = [];
  if (post.songs.length === 0 && post.songCount > 0) counts.push(`🎵 ${post.songCount}`);
  if (post.films.length === 0 && post.filmCount > 0) counts.push(`🎬 ${post.filmCount}`);
  if (post.noteCount > 0) counts.push(`📝 ${post.noteCount}`);

  return (
    <button
      type="button"
      className={`wall-card${selected ? ' selected' : ''} ${post.status}`}
      aria-pressed={selected}
      onClick={() => onSelect(post.id)}
    >
      <span className="wall-media">
        {post.thumbnailUrl && !imgError ? (
          <img src={post.thumbnailUrl} alt="" className="wall-thumb" loading="lazy" onError={() => setImgError(true)} />
        ) : (
          <span className="wall-thumb-placeholder" aria-hidden="true">{label}</span>
        )}
        <span className="wall-platform">{label}</span>
      </span>
      <span className="wall-body">
        <span className="wall-meta">
          {date && <span className="wall-time">{relativeTime(date, t)}</span>}
          {post.status === 'processing' && <span className="wall-spinner" />}
          {post.status === 'error' && <span className="wall-failed" title={t.error}>⚠</span>}
        </span>
        <span className="wall-summary">{post.summary}</span>
        {post.songs.length > 0 && (
          <span className="wall-items">
            {post.songs.map((song, i) => (
              <span key={`${i}|${song.title}|${song.artist}`} className="wall-item">♪ {song.title} — {song.artist}</span>
            ))}
            {moreSongs > 0 && <span className="wall-more">{interpolate(t.wallMoreSongs, { count: moreSongs })}</span>}
          </span>
        )}
        {post.films.length > 0 && (
          <span className="wall-items">
            {post.films.map((film, i) => (
              <span key={`${i}|${film.title}`} className="wall-item">🎬 {film.title}{film.year ? ` (${film.year})` : ''}</span>
            ))}
            {moreFilms > 0 && <span className="wall-more">{interpolate(t.wallMoreFilms, { count: moreFilms })}</span>}
          </span>
        )}
        {(counts.length > 0 || post.tags.length > 0 || post.collections.length > 0) && (
          <span className="wall-chips">
            {counts.map((count) => <span key={count} className="wall-chip wall-count">{count}</span>)}
            <CollectionChips chips={post.collections} tags={post.tags} interactive={false} />
          </span>
        )}
      </span>
    </button>
  );
}

export interface WallProps {
  posts: PostCardModel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Another look for the same cards (the Home lays them in a row). */
  className?: string;
  /** The name of the list when «library posts» is not the right one. */
  label?: string;
}

export function Wall({ posts, selectedId, onSelect, className, label }: WallProps) {
  const { t } = useLanguage();
  if (posts.length === 0) return null;
  return (
    <ul className={className ? `wall ${className}` : 'wall'} aria-label={label ?? t.wallLabel}>
      {posts.map((post) => (
        <li key={post.id} className="wall-cell">
          <WallCard post={post} selected={post.id === selectedId} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}
