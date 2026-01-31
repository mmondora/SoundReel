import { useState } from 'react';
import type { Entry } from '../types';
import { SongItem } from './SongItem';
import { FilmItem } from './FilmItem';
import { ActionLog } from './ActionLog';
import { deleteEntry } from '../services/api';

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

export function EntryCard({ entry }: EntryCardProps) {
  const [deleting, setDeleting] = useState(false);
  const hasSongs = entry.results.songs.length > 0;
  const hasFilms = entry.results.films.length > 0;
  const hasContent = hasSongs || hasFilms;
  const isCompact = !hasContent && entry.status === 'completed';

  const parsedDate = parseFirestoreDate(entry.createdAt);

  const handleDelete = async () => {
    if (!confirm('Sei sicuro di voler eliminare questa entry?')) return;

    setDeleting(true);
    try {
      await deleteEntry(entry.id);
    } catch (err) {
      console.error('Errore eliminazione:', err);
      alert('Errore durante l\'eliminazione');
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
            {parsedDate ? parsedDate.toLocaleDateString('it-IT', {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit'
            }) : ''}
          </time>
        </div>
        <div className="entry-actions-header">
          {entry.status === 'processing' && (
            <span className="status-badge processing">In elaborazione...</span>
          )}
          {entry.status === 'error' && (
            <span className="status-badge error">Errore</span>
          )}
          <button
            className="delete-btn"
            onClick={handleDelete}
            disabled={deleting}
            title="Elimina entry"
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
          <h3 className="section-title">Canzoni</h3>
          {entry.results.songs.map((song, index) => (
            <SongItem key={index} song={song} />
          ))}
        </section>
      )}

      {hasFilms && (
        <section className="entry-section films">
          <h3 className="section-title">Film</h3>
          {entry.results.films.map((film, index) => (
            <FilmItem key={index} film={film} />
          ))}
        </section>
      )}

      {isCompact && (
        <p className="no-results">Nessun contenuto trovato</p>
      )}

      {!isCompact && <ActionLog log={entry.actionLog} />}
    </article>
  );
}
