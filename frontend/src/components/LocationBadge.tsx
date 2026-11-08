import { useLanguage } from '../i18n';
import { locationBadge } from '../utils/songLocation';
import type { SongLocation } from '../types';
import '../styles/manager.css';

/**
 * Where the song's file lives (rule W2): FS = geekom's disk, MS = media server (Fritz), FS+MS = both. No badge
 * means streaming only (YouTube). The tooltip and the accessible name say it in words.
 */
export function LocationBadge({ location }: { location: SongLocation }) {
  const { t } = useLanguage();
  const kind = locationBadge(location);
  if (!kind) return null;
  const label = kind === 'FS' ? t.locFs : kind === 'MS' ? t.locMs : t.locFsMs;
  return (
    <span
      className={`loc-badge loc-badge-${kind === 'FS+MS' ? 'both' : kind.toLowerCase()}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {kind}
    </span>
  );
}
