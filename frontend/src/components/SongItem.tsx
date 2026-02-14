import type { Song } from '../types';
import { useLanguage } from '../i18n';

interface SongItemProps {
  song: Song;
}

export function SongItem({ song }: SongItemProps) {
  const { t } = useLanguage();

  return (
    <div className="song-item">
      <div className="song-info">
        <span className="song-title">{song.title}</span>
        <span className="song-artist">{song.artist}</span>
        {song.album && <span className="song-album">{song.album}</span>}
      </div>
      <div className="song-actions">
        {song.spotifyUrl && (
          <a
            href={song.spotifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="action-link spotify"
            title={t.openOnSpotify}
          >
            <span className="icon">S</span>
          </a>
        )}
        {song.youtubeUrl && (
          <a
            href={song.youtubeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="action-link youtube"
            title={t.searchOnYoutube}
          >
            <span className="icon">Y</span>
          </a>
        )}
        {song.soundcloudUrl && (
          <a
            href={song.soundcloudUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="action-link soundcloud"
            title={t.searchOnSoundcloud}
          >
            <span className="icon">SC</span>
          </a>
        )}
        {song.addedToPlaylist && (
          <span className="playlist-badge" title={t.addedToPlaylist}>
            +
          </span>
        )}
      </div>
    </div>
  );
}
