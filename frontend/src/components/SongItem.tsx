import type { Song } from '../types';

interface SongItemProps {
  song: Song;
}

export function SongItem({ song }: SongItemProps) {
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
            title="Apri su Spotify"
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
            title="Cerca su YouTube"
          >
            <span className="icon">Y</span>
          </a>
        )}
        {song.addedToPlaylist && (
          <span className="playlist-badge" title="Aggiunta alla playlist">
            +
          </span>
        )}
      </div>
    </div>
  );
}
