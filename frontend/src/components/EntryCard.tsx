import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { Entry, Note } from '../types';
import { SongItem } from './SongItem';
import { FilmItem } from './FilmItem';
import { ActionLog } from './ActionLog';
import { deleteEntry, retryEntry, enrichEntry } from '../services/api';
import { useLanguage } from '../i18n';

interface EntryCardProps {
  entry: Entry;
}

/**
 * Decode HTML entities in text (safety net for already saved entries)
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return _;
      }
    });
}

/**
 * Parse caption text and return JSX with highlighted URLs, @mentions, and #hashtags
 */
function renderCaptionWithLinks(text: string): ReactNode[] {
  const urlRegex = /(https?:\/\/[^\s,)]+)/g;
  const mentionRegex = /(@[\w.]+)/g;
  const hashtagRegex = /(#[\w\u00C0-\u024F]+)/g;

  // Combined regex to split on any of the three patterns
  const combined = /(https?:\/\/[^\s,)]+|@[\w.]+|#[\w\u00C0-\u024F]+)/g;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combined.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (urlRegex.test(token)) {
      parts.push(
        <a key={match.index} href={token} target="_blank" rel="noopener noreferrer" className="caption-link">
          {token}
        </a>
      );
    } else if (mentionRegex.test(token)) {
      parts.push(<span key={match.index} className="caption-mention">{token}</span>);
    } else if (hashtagRegex.test(token)) {
      parts.push(<span key={match.index} className="caption-hashtag">{token}</span>);
    } else {
      parts.push(token);
    }

    // Reset lastIndex of sub-regexes (they're used only for .test())
    urlRegex.lastIndex = 0;
    mentionRegex.lastIndex = 0;
    hashtagRegex.lastIndex = 0;

    lastIndex = match.index + token.length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    instagram: 'IG',
    tiktok: 'TT',
    youtube: 'YT',
    facebook: 'FB',
    twitter: 'X',
    threads: 'TH',
    snapchat: 'SC',
    pinterest: 'PIN',
    linkedin: 'LI',
    reddit: 'RD',
    vimeo: 'VM',
    twitch: 'TW',
    spotify: 'SP',
    soundcloud: 'SND'
  };
  return labels[platform] || 'WEB';
}

function getChannelIcon(channel: string): string {
  return channel === 'telegram' ? 'BOT' : 'WEB';
}

/**
 * Parse Firestore timestamp (can be object with _seconds or seconds, or string)
 */
function parseFirestoreDate(timestamp: unknown): Date | null {
  if (!timestamp) return null;

  // Firestore Timestamp object (from SDK)
  if (typeof timestamp === 'object' && timestamp !== null) {
    const ts = timestamp as Record<string, unknown>;
    const seconds = ts._seconds ?? ts.seconds;
    if (typeof seconds === 'number') {
      return new Date(seconds * 1000);
    }
  }

  // ISO string
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

/**
 * Extract dominant color from an image using a 1x1 canvas downscale
 */
function extractDominantColor(
  imgUrl: string,
  onColor: (color: string) => void
): void {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      onColor(`${r}, ${g}, ${b}`);
    } catch {
      // CORS or other canvas error — ignore
    }
  };
  img.src = imgUrl;
}

const NOTE_CATEGORY_LABELS: Record<Note['category'], { icon: string; key: keyof typeof import('../i18n/translations').translations.it }> = {
  place: { icon: '📍', key: 'notePlace' },
  event: { icon: '📅', key: 'noteEvent' },
  brand: { icon: '🏢', key: 'noteBrand' },
  book: { icon: '📖', key: 'noteBook' },
  product: { icon: '📦', key: 'noteProduct' },
  quote: { icon: '💬', key: 'noteQuote' },
  person: { icon: '👤', key: 'notePerson' },
  other: { icon: '📝', key: 'noteOther' }
};

export function EntryCard({ entry }: EntryCardProps) {
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [needsToggle, setNeedsToggle] = useState(false);
  const [accentColor, setAccentColor] = useState<string | null>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const { t, language } = useLanguage();
  const hasSongs = entry.results.songs.length > 0;
  const hasFilms = entry.results.films.length > 0;
  const hasNotes = (entry.results.notes?.length || 0) > 0;
  const hasLinks = (entry.results.links?.length || 0) > 0;
  const hasTags = (entry.results.tags?.length || 0) > 0;
  const hasSummary = !!entry.results.summary;
  const hasEnrichments = (entry.results.enrichments?.length || 0) > 0;
  const hasContent = hasSongs || hasFilms || hasNotes || hasLinks || hasTags;
  const isCompact = !hasContent && entry.status === 'completed';

  const parsedDate = parseFirestoreDate(entry.createdAt);
  const dateLocale = language === 'it' ? 'it-IT' : 'en-US';

  // Extract accent color from thumbnail
  useEffect(() => {
    if (entry.thumbnailUrl) {
      extractDominantColor(entry.thumbnailUrl, setAccentColor);
    }
  }, [entry.thumbnailUrl]);

  // Check if caption needs expand/collapse toggle
  const checkCaptionOverflow = useCallback(() => {
    const el = captionRef.current;
    if (el && !captionExpanded) {
      setNeedsToggle(el.scrollHeight > el.clientHeight);
    }
  }, [captionExpanded]);

  useEffect(() => {
    checkCaptionOverflow();
    // Re-check on window resize
    window.addEventListener('resize', checkCaptionOverflow);
    return () => window.removeEventListener('resize', checkCaptionOverflow);
  }, [checkCaptionOverflow, entry.caption]);

  const handleDelete = async () => {
    if (!confirm(t.confirmDelete)) return;

    setDeleting(true);
    try {
      await deleteEntry(entry.id);
    } catch (err) {
      console.error('Error deleting:', err);
      alert(t.deleteError);
    } finally {
      setDeleting(false);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await retryEntry(entry.id, entry.sourceUrl);
    } catch (err) {
      console.error('Error retrying:', err);
      alert(t.retryError);
    } finally {
      setRetrying(false);
    }
  };

  const handleEnrich = async () => {
    setEnriching(true);
    try {
      await enrichEntry(entry.id);
    } catch (err) {
      console.error('Error enriching:', err);
      alert(t.enrichError);
    } finally {
      setEnriching(false);
    }
  };

  const cardStyle = accentColor
    ? { '--card-accent': accentColor } as React.CSSProperties
    : undefined;

  return (
    <article
      className={`entry-card ${entry.status}${isCompact ? ' compact' : ''}${accentColor ? ' has-accent' : ''}`}
      style={cardStyle}
    >
      <header className="entry-header">
        <div className="entry-meta">
          {entry.thumbnailUrl && (
            <img
              src={entry.thumbnailUrl}
              alt=""
              className="entry-thumbnail"
              loading="lazy"
            />
          )}
          <a
            href={entry.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="platform-badge"
            title={entry.sourceUrl}
          >
            {getPlatformLabel(entry.sourcePlatform)}
          </a>
          <span className="channel-badge">{getChannelIcon(entry.inputChannel)}</span>
          <time className="entry-date">
            {parsedDate ? parsedDate.toLocaleDateString(dateLocale, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit'
            }) : ''}
          </time>
        </div>
        <div className="entry-actions-header">
          {entry.status === 'processing' && (
            <span className="status-badge processing">{t.processing}</span>
          )}
          {entry.status === 'error' && (
            <span className="status-badge error">{t.error}</span>
          )}
          {entry.status === 'completed' && (
            <button
              className="retry-btn"
              onClick={handleRetry}
              disabled={retrying}
              title={t.retryEntry}
            >
              {retrying ? '...' : '↻'}
            </button>
          )}
          {entry.status === 'completed' && (hasContent || entry.caption) && (
            <button
              className="enrich-btn"
              onClick={handleEnrich}
              disabled={enriching}
              title={t.enrichEntry}
            >
              {enriching ? '...' : '🔍'}
            </button>
          )}
          <button
            className="delete-btn"
            onClick={handleDelete}
            disabled={deleting}
            title={t.deleteEntry}
          >
            {deleting ? '...' : '×'}
          </button>
        </div>
      </header>

      {hasSummary && (
        <p className="entry-summary">{entry.results.summary}</p>
      )}

      {entry.caption && (
        <div className="entry-caption-wrapper">
          <div
            ref={captionRef}
            className={`entry-caption${captionExpanded ? '' : ' collapsed'}`}
          >
            {renderCaptionWithLinks(decodeHtmlEntities(entry.caption))}
          </div>
          {(needsToggle || captionExpanded) && (
            <button
              className="caption-toggle"
              onClick={() => setCaptionExpanded(!captionExpanded)}
            >
              {captionExpanded ? t.showLess : t.showMore}
            </button>
          )}
        </div>
      )}

      {hasSongs && (
        <section className="entry-section songs">
          <h3 className="section-title">{t.songsSection}</h3>
          {entry.results.songs.map((song, index) => (
            <SongItem key={index} song={song} />
          ))}
        </section>
      )}

      {hasFilms && (
        <section className="entry-section films">
          <h3 className="section-title">{t.filmsSection}</h3>
          {entry.results.films.map((film, index) => (
            <FilmItem key={index} film={film} />
          ))}
        </section>
      )}

      {hasTags && (
        <div className="entry-tags">
          {entry.results.tags.map((tag, index) => (
            <span key={index} className="tag-badge">{tag}</span>
          ))}
        </div>
      )}

      {hasLinks && (
        <section className="entry-section links">
          <h3 className="section-title">{t.linksSection}</h3>
          <ul className="links-list">
            {entry.results.links.map((link, index) => (
              <li key={index} className="link-item">
                <span className="link-icon">🔗</span>
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="link-url">
                  {link.label || link.url}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasNotes && (
        <section className="entry-section notes">
          <h3 className="section-title">{t.notesSection}</h3>
          <ul className="notes-list">
            {entry.results.notes.map((note, index) => {
              const cat = NOTE_CATEGORY_LABELS[note.category] || NOTE_CATEGORY_LABELS.other;
              return (
                <li key={index} className="note-item">
                  <span className="note-icon">{cat.icon}</span>
                  <span className="note-text">{note.text}</span>
                  <span className="note-category">{t[cat.key]}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {hasEnrichments && (
        <section className="entry-section enrichments">
          <h3 className="section-title">{t.enrichmentsSection}</h3>
          {entry.results.enrichments!.map((item, index) => (
            <div key={index} className="enrichment-item">
              <span className="enrichment-label">{item.label}</span>
              <ul className="enrichment-links">
                {item.links.map((link, linkIndex) => (
                  <li key={linkIndex} className="enrichment-link">
                    <a href={link.url} target="_blank" rel="noopener noreferrer">
                      {link.title}
                    </a>
                    {link.snippet && (
                      <span className="enrichment-snippet">{link.snippet}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {isCompact && (
        <p className="no-results">{t.noContentFound}</p>
      )}

      {!isCompact && <ActionLog log={entry.actionLog} />}
    </article>
  );
}
