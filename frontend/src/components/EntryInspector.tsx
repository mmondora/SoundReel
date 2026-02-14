import { useState, type ReactNode } from 'react';
import type { Entry, Note } from '../types';
import { SongItem } from './SongItem';
import { FilmItem } from './FilmItem';
import { ActivityTimeline } from './ActivityTimeline';
import { deleteEntry, retryEntry, enrichEntry } from '../services/api';
import { useLanguage } from '../i18n';

interface EntryInspectorProps {
  entry: Entry;
  onBack?: () => void;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return _; }
    });
}

function renderCaptionWithLinks(text: string): ReactNode[] {
  const combined = /(https?:\/\/[^\s,)]+|@[\w.]+|#[\w\u00C0-\u024F]+)/g;
  const urlRegex = /(https?:\/\/[^\s,)]+)/g;
  const mentionRegex = /(@[\w.]+)/g;
  const hashtagRegex = /(#[\w\u00C0-\u024F]+)/g;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combined.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (urlRegex.test(token)) {
      parts.push(<a key={match.index} href={token} target="_blank" rel="noopener noreferrer" className="caption-link">{token}</a>);
    } else if (mentionRegex.test(token)) {
      parts.push(<span key={match.index} className="caption-mention">{token}</span>);
    } else if (hashtagRegex.test(token)) {
      parts.push(<span key={match.index} className="caption-hashtag">{token}</span>);
    } else {
      parts.push(token);
    }
    urlRegex.lastIndex = 0;
    mentionRegex.lastIndex = 0;
    hashtagRegex.lastIndex = 0;
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook',
    twitter: 'X', threads: 'Threads', snapchat: 'Snapchat', pinterest: 'Pinterest',
    linkedin: 'LinkedIn', reddit: 'Reddit', vimeo: 'Vimeo', twitch: 'Twitch',
    spotify: 'Spotify', soundcloud: 'SoundCloud'
  };
  return labels[platform] || 'Web';
}

function parseFirestoreDate(timestamp: unknown): Date | null {
  if (!timestamp) return null;
  if (typeof timestamp === 'object' && timestamp !== null) {
    const ts = timestamp as Record<string, unknown>;
    const seconds = ts._seconds ?? ts.seconds;
    if (typeof seconds === 'number') return new Date(seconds * 1000);
  }
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) return date;
  }
  return null;
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

export function EntryInspector({ entry, onBack }: EntryInspectorProps) {
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const { t, language } = useLanguage();

  const dateLocale = language === 'it' ? 'it-IT' : 'en-US';
  const parsedDate = parseFirestoreDate(entry.createdAt);

  const hasSongs = entry.results.songs.length > 0;
  const hasFilms = entry.results.films.length > 0;
  const hasNotes = (entry.results.notes?.length || 0) > 0;
  const hasLinks = (entry.results.links?.length || 0) > 0;
  const hasTags = (entry.results.tags?.length || 0) > 0;
  const hasEnrichments = (entry.results.enrichments?.length || 0) > 0;
  const transcript = entry.results.transcript || entry.results.transcription || null;
  const hasTranscript = !!transcript;

  const handleDelete = async () => {
    if (!confirm(t.confirmDelete)) return;
    setDeleting(true);
    try { await deleteEntry(entry.id); } catch { alert(t.deleteError); }
    finally { setDeleting(false); }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try { await retryEntry(entry.id, entry.sourceUrl); } catch { alert(t.retryError); }
    finally { setRetrying(false); }
  };

  const handleEnrich = async () => {
    setEnriching(true);
    try { await enrichEntry(entry.id); } catch { alert(t.enrichError); }
    finally { setEnriching(false); }
  };

  const handleCopyUrl = async () => {
    await navigator.clipboard.writeText(entry.sourceUrl);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 2000);
  };

  // Truncated transcript preview (3 lines ~ 200 chars)
  const transcriptPreview = transcript && transcript.length > 200
    ? transcript.substring(0, 200) + '...'
    : transcript;

  return (
    <div className="inspector">
      {/* Mobile back button */}
      {onBack && (
        <button className="inspector-back" onClick={onBack}>{t.back}</button>
      )}

      {/* Header */}
      <div className="inspector-header">
        {entry.thumbnailUrl && (
          <img src={entry.thumbnailUrl} alt="" className="inspector-thumb" loading="lazy" />
        )}
        <div className="inspector-header-info">
          {entry.caption && (
            <p className="inspector-caption">
              {decodeHtmlEntities(entry.caption).substring(0, 140)}
              {entry.caption.length > 140 ? '...' : ''}
            </p>
          )}
          <div className="inspector-meta">
            <span className="inspector-platform-badge">{getPlatformLabel(entry.sourcePlatform)}</span>
            <span className={`inspector-status-badge ${entry.status}`}>
              {entry.status === 'processing' ? t.processing : entry.status === 'error' ? t.error : 'completed'}
            </span>
            {parsedDate && (
              <time className="inspector-date">
                {parsedDate.toLocaleDateString(dateLocale, {
                  day: 'numeric', month: 'long', year: 'numeric',
                  hour: '2-digit', minute: '2-digit'
                })}
              </time>
            )}
          </div>
          <div className="inspector-actions">
            <button className="inspector-action-btn" onClick={handleRetry} disabled={retrying} title={t.retryEntry}>
              {retrying ? '...' : '↻'}
            </button>
            <button className="inspector-action-btn" onClick={handleEnrich} disabled={enriching} title={t.enrichEntry}>
              {enriching ? '...' : '🔍'}
            </button>
            <button className="inspector-action-btn danger" onClick={handleDelete} disabled={deleting} title={t.deleteEntry}>
              {deleting ? '...' : '🗑'}
            </button>
            <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer" className="inspector-action-btn" title={t.openOriginal}>
              ↗
            </a>
            <button className="inspector-action-btn" onClick={handleCopyUrl} title={t.copyUrl}>
              {urlCopied ? '✓' : '📋'}
            </button>
          </div>
        </div>
      </div>

      {/* Summary */}
      {entry.results.summary && (
        <section className="inspector-section">
          <p className="inspector-summary">{entry.results.summary}</p>
        </section>
      )}

      {/* Transcript */}
      {hasTranscript && (
        <section className="inspector-section">
          <h3 className="inspector-section-title" onClick={() => setTranscriptExpanded(!transcriptExpanded)} style={{ cursor: 'pointer' }}>
            {t.transcript} {transcriptExpanded ? '▾' : '▸'}
          </h3>
          <p className="inspector-transcript">
            {transcriptExpanded ? transcript : transcriptPreview}
          </p>
          {transcript && transcript.length > 200 && (
            <button className="caption-toggle" onClick={() => setTranscriptExpanded(!transcriptExpanded)}>
              {transcriptExpanded ? t.showLess : t.showMore}
            </button>
          )}
        </section>
      )}

      {/* Caption full */}
      {entry.caption && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">Caption</h3>
          <div className="inspector-caption-full">
            {renderCaptionWithLinks(decodeHtmlEntities(entry.caption))}
          </div>
        </section>
      )}

      {/* Songs */}
      {hasSongs && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.songsSection}</h3>
          {entry.results.songs.map((song, i) => (
            <SongItem key={i} song={song} />
          ))}
        </section>
      )}

      {/* Films */}
      {hasFilms && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.filmsSection}</h3>
          {entry.results.films.map((film, i) => (
            <FilmItem key={i} film={film} />
          ))}
        </section>
      )}

      {/* Notes grouped by category */}
      {hasNotes && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.notesSection}</h3>
          {(() => {
            const grouped: Record<string, Note[]> = {};
            entry.results.notes.forEach(note => {
              const cat = note.category || 'other';
              if (!grouped[cat]) grouped[cat] = [];
              grouped[cat].push(note);
            });
            return Object.entries(grouped).map(([cat, notes]) => {
              const catInfo = NOTE_CATEGORY_LABELS[cat as Note['category']] || NOTE_CATEGORY_LABELS.other;
              return (
                <div key={cat} className="inspector-note-group">
                  <span className="inspector-note-category">{catInfo.icon} {t[catInfo.key]}</span>
                  <ul className="inspector-note-list">
                    {notes.map((note, i) => (
                      <li key={i} className="inspector-note-item">{note.text}</li>
                    ))}
                  </ul>
                </div>
              );
            });
          })()}
        </section>
      )}

      {/* Links */}
      {hasLinks && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.linksSection}</h3>
          <ul className="inspector-links">
            {entry.results.links.map((link, i) => (
              <li key={i}>
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="inspector-link">
                  {link.label || link.url}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Tags */}
      {hasTags && (
        <section className="inspector-section">
          <div className="inspector-tags">
            {entry.results.tags.map((tag, i) => (
              <span key={i} className="tag-badge">{tag}</span>
            ))}
          </div>
        </section>
      )}

      {/* Enrichments */}
      {hasEnrichments && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.enrichmentsSection}</h3>
          {entry.results.enrichments!.map((item, i) => (
            <div key={i} className="enrichment-item">
              <span className="enrichment-label">{item.label}</span>
              <ul className="enrichment-links">
                {item.links.map((link, li) => (
                  <li key={li} className="enrichment-link">
                    <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a>
                    {link.snippet && <span className="enrichment-snippet">{link.snippet}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {/* Deep Search prompt if no enrichments */}
      {!hasEnrichments && entry.status === 'completed' && (
        <section className="inspector-section">
          <button className="inspector-deepsearch-btn" onClick={handleEnrich} disabled={enriching}>
            {enriching ? t.enriching : t.runDeepSearch}
          </button>
        </section>
      )}

      {/* Activity Timeline */}
      {entry.actionLog.length > 0 && (
        <section className="inspector-section inspector-activity">
          <ActivityTimeline
            actionLog={entry.actionLog}
            isProcessing={entry.status === 'processing'}
          />
        </section>
      )}
    </div>
  );
}
