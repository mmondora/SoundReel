import type { Entry } from '../types';
import type { Translations } from '../i18n/translations';
import { useLanguage, interpolate } from '../i18n';

interface CompactCardProps {
  entry: Entry;
  selected: boolean;
  onSelect: (entry: Entry) => void;
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

function getRelativeTime(date: Date, t: Translations): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t.justNow;
  if (minutes < 60) return interpolate(t.minutesAgo, { count: minutes });
  if (hours < 24) return interpolate(t.hoursAgo, { count: hours });
  if (days === 1) return t.yesterday;
  if (days < 30) return interpolate(t.daysAgo, { count: days });

  return date.toLocaleDateString();
}

function getPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    instagram: 'IG', tiktok: 'TT', youtube: 'YT', facebook: 'FB',
    twitter: 'X', threads: 'TH', snapchat: 'SC', pinterest: 'PIN',
    linkedin: 'LI', reddit: 'RD', vimeo: 'VM', twitch: 'TW',
    spotify: 'SP', soundcloud: 'SND'
  };
  return labels[platform] || 'WEB';
}

export function CompactCard({ entry, selected, onSelect }: CompactCardProps) {
  const { t } = useLanguage();
  const parsedDate = parseFirestoreDate(entry.createdAt);
  const songCount = entry.results.songs.length;
  const filmCount = entry.results.films.length;
  const noteCount = entry.results.notes?.length || 0;
  const hasTranscript = !!(entry.results.transcript || entry.results.transcription);

  const summary = entry.results.summary
    || entry.caption?.substring(0, 80)
    || entry.sourceUrl;

  return (
    <div
      className={`compact-card ${selected ? 'selected' : ''} ${entry.status}`}
      onClick={() => onSelect(entry)}
    >
      {entry.thumbnailUrl && (
        <img
          src={entry.thumbnailUrl}
          alt=""
          className="compact-thumb"
          loading="lazy"
        />
      )}
      {!entry.thumbnailUrl && (
        <div className="compact-thumb-placeholder">
          {getPlatformLabel(entry.sourcePlatform)}
        </div>
      )}
      <div className="compact-content">
        <div className="compact-top">
          <span className="compact-platform">{getPlatformLabel(entry.sourcePlatform)}</span>
          {parsedDate && (
            <span className="compact-time">{getRelativeTime(parsedDate, t)}</span>
          )}
        </div>
        <p className="compact-summary">{summary}</p>
        <div className="compact-bottom">
          <div className="compact-counts">
            {songCount > 0 && <span className="compact-count">🎵 {songCount}</span>}
            {filmCount > 0 && <span className="compact-count">🎬 {filmCount}</span>}
            {noteCount > 0 && <span className="compact-count">📝 {noteCount}</span>}
            {hasTranscript && <span className="compact-count">💬</span>}
          </div>
          <span className={`compact-status ${entry.status}`}>
            {entry.status === 'processing' && <span className="compact-spinner" />}
            {entry.status === 'completed' && '●'}
            {entry.status === 'error' && '●'}
          </span>
        </div>
      </div>
    </div>
  );
}
