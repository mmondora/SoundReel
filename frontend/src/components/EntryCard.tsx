import { useState } from 'react';
import type { Entry, Note } from '../types';
import { SongItem } from './SongItem';
import { FilmItem } from './FilmItem';
import { ActionLog } from './ActionLog';
import { deleteEntry } from '../services/api';
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
  const { t, language } = useLanguage();
  const hasSongs = entry.results.songs.length > 0;
  const hasFilms = entry.results.films.length > 0;
  const hasNotes = (entry.results.notes?.length || 0) > 0;
  const hasLinks = (entry.results.links?.length || 0) > 0;
  const hasTags = (entry.results.tags?.length || 0) > 0;
  const hasContent = hasSongs || hasFilms || hasNotes || hasLinks || hasTags;
  const isCompact = !hasContent && entry.status === 'completed';

  const parsedDate = parseFirestoreDate(entry.createdAt);
  const dateLocale = language === 'it' ? 'it-IT' : 'en-US';

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

  return (
    <article className={`entry-card ${entry.status}${isCompact ? ' compact' : ''}`}>
      <header className="entry-header">
        <div className="entry-meta">
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

      {entry.caption && (
        <p className="entry-caption">{decodeHtmlEntities(entry.caption)}</p>
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

      {isCompact && (
        <p className="no-results">{t.noContentFound}</p>
      )}

      {!isCompact && <ActionLog log={entry.actionLog} />}
    </article>
  );
}
