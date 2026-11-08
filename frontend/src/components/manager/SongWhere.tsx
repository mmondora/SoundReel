import { useLanguage } from '../../i18n';
import type { SongPlace } from '../../types';
import { youtubeLink } from '../../utils/songLocation';
import type { AggregatedSong } from '../../types';

/**
 * The detail line under a song row of the manager (rule W8, "Mostra percorsi"): the path of the file on geekom's
 * disk (FS), the URL of the file on the media server (MS) and, for a song that is only streamed, the YouTube link.
 * Plain selectable text: copying is in the song details dialog.
 */
export function SongWhere({ song, place }: { song: Pick<AggregatedSong, 'artist' | 'title' | 'youtubeUrl'>; place: SongPlace }) {
  const { t } = useLanguage();
  const lines: Array<{ id: string; tag: string; tagClass: string; tagLabel: string; text: string; href?: string }> = [];

  if (place.fs) {
    lines.push({ id: 'fs', tag: 'FS', tagClass: 'fs', tagLabel: t.locFs, text: place.fsPath ?? t.mgrWhereNoPath });
  }
  if (place.mediaServer) {
    lines.push({ id: 'ms', tag: 'MS', tagClass: 'ms', tagLabel: t.locMs, text: place.mediaUrl ?? t.mgrWhereNoPath });
  }
  if (!place.fs && !place.mediaServer) {
    const link = youtubeLink(song, place.streamUrl);
    lines.push({
      id: 'yt',
      tag: 'YT',
      tagClass: 'yt',
      tagLabel: t.locYoutube,
      text: link.exact ? link.url : t.mgrWhereSearch,
      href: link.url,
    });
  }

  return (
    <span className="mgr-where" data-testid="song-where">
      {lines.map((line) => (
        <span key={line.id} className={`mgr-where-line mgr-where-${line.id}`}>
          <span className={`loc-badge loc-badge-${line.tagClass}`} role="img" aria-label={line.tagLabel} title={line.tagLabel}>{line.tag}</span>
          {line.href ? (
            <a className="mgr-where-text" href={line.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              {line.text}
            </a>
          ) : (
            <span className="mgr-where-text">{line.text}</span>
          )}
        </span>
      ))}
    </span>
  );
}
