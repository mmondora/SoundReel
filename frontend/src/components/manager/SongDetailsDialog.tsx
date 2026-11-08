import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../i18n';
import { fetchSongState } from '../../services/api';
import type { SongStateLocation } from '../../types';
import { SOURCE_LABEL_KEY, platformLabel } from '../../utils/managerSongs';
import type { ManagerSong } from '../../utils/managerSongs';
import { resolveSongPlace, youtubeLink } from '../../utils/songLocation';
import { CopyButton } from './CopyButton';
import { DialogFrame } from './DialogFrame';

export interface SongDetailsDialogProps {
  song: ManagerSong;
  downloaded: boolean;
  preparing: boolean;
  /** Names of the loaded playlists that contain the song. */
  inPlaylists: string[];
  /** What this session learned about where the file is (a finished first-play download), if anything. */
  locationOverride?: Partial<SongStateLocation> | null;
  onClose: () => void;
}

const MAX_MENTION_LINKS = 6;

/** F3: everything the manager knows about one song. */
export function SongDetailsDialog({ song, downloaded, preparing, inPlaylists, locationOverride, onClose }: SongDetailsDialogProps) {
  const { t } = useLanguage();
  const genres = song.meta?.genres ?? [];
  const album = song.album ?? song.meta?.album ?? null;

  // The list already knows FS / MS and the paths; the song state adds the YouTube address and is fresher. A failed
  // call just leaves what the list had.
  const [fresh, setFresh] = useState<SongStateLocation | null>(null);
  useEffect(() => {
    if (song.placeholder) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => fetchSongState(song.songKey))
      .then((res) => {
        if (!cancelled && res.location) setFresh(res.location);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [song.songKey, song.placeholder]);
  const place = resolveSongPlace(song, { ...locationOverride, ...fresh });
  const youtube = youtubeLink(song, place.streamUrl);

  return (
    <DialogFrame title={t.mgrDetailsTitle} onClose={onClose}>
      <h3 className="mgr-details-title">{song.title}</h3>
      <p className="mgr-details-artist">{song.artist || '—'}</p>

      {song.placeholder ? (
        <p className="mgr-help">{t.mgrDetailsPlaceholder}</p>
      ) : (
        <dl className="mgr-details">
          {album && (<><dt>{t.mgrDetailsAlbum}</dt><dd>{album}</dd></>)}
          {genres.length > 0 && (<><dt>{t.mgrDetailsGenres}</dt><dd>{genres.join(', ')}</dd></>)}
          {song.sources.length > 0 && (
            <><dt>{t.mgrDetailsType}</dt><dd>{song.sources.map((k) => t[SOURCE_LABEL_KEY[k]] as string).join(', ')}</dd></>
          )}
          {song.platforms.length > 0 && (
            <><dt>{t.mgrDetailsSource}</dt><dd>{song.platforms.map(platformLabel).join(', ')}</dd></>
          )}
          {song.tags.length > 0 && (<><dt>{t.mgrDetailsTags}</dt><dd>{song.tags.join(' ')}</dd></>)}
          <dt>{t.mgrDetailsFile}</dt>
          <dd>
            {downloaded ? t.mgrDownloaded : preparing ? t.mgrPreparing : t.mgrDetailsFileMissing}
            {downloaded && <span className="mgr-details-note"> · {t.mgrDetailsFilePresent}</span>}
          </dd>
          <dt>{t.mgrDetailsWhere}</dt>
          <dd>
            <ul className="mgr-where-list" data-testid="where-list">
              <li className="mgr-where-item" data-where="fs">
                <span className="mgr-where-k">{t.mgrWhereFs}</span>
                {place.fs && place.fsPath ? (
                  <>
                    <span className="mgr-where-value">{place.fsPath}</span>
                    <CopyButton value={place.fsPath} what={t.mgrWhereFs} />
                  </>
                ) : (
                  <span className="mgr-where-value mgr-where-none">{place.fs ? t.mgrWhereNoPath : t.mgrWhereNone}</span>
                )}
              </li>
              <li className="mgr-where-item" data-where="ms">
                <span className="mgr-where-k">{t.mgrWhereMs}</span>
                {place.mediaServer && place.mediaUrl ? (
                  <>
                    <span className="mgr-where-value">{place.mediaUrl}</span>
                    <CopyButton value={place.mediaUrl} what={t.mgrWhereMs} />
                  </>
                ) : (
                  <span className="mgr-where-value mgr-where-none">{place.mediaServer ? t.mgrWhereNoPath : t.mgrWhereNone}</span>
                )}
              </li>
              <li className="mgr-where-item" data-where="youtube">
                <span className="mgr-where-k">{t.mgrWhereYoutube}</span>
                <a className="mgr-where-value" href={youtube.url} target="_blank" rel="noopener noreferrer">{youtube.url}</a>
                <CopyButton value={youtube.url} what={t.mgrWhereYoutube} />
                {!youtube.exact && <span className="mgr-where-note">{t.mgrWhereSearch}</span>}
              </li>
            </ul>
          </dd>
          {inPlaylists.length > 0 && (<><dt>{t.playlistsTitle}</dt><dd>{inPlaylists.join(', ')}</dd></>)}
          {song.mentions.length > 0 && (
            <>
              <dt>{t.mgrDetailsMentions}</dt>
              <dd>
                {song.mentions.length}
                {' · '}
                {song.mentions.slice(0, MAX_MENTION_LINKS).map((m, i) => (
                  <Link key={m.entryId} to={`/?entry=${encodeURIComponent(m.entryId)}`} onClick={onClose} className="mgr-details-link">
                    {t.mgrDetailsOpen} #{i + 1}
                  </Link>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}

      <div className="mgr-dialog-foot-inline">
        <button type="button" className="mgr-btn mgr-btn-primary" data-autofocus onClick={onClose}>
          {t.mgrClose}
        </button>
      </div>
    </DialogFrame>
  );
}
