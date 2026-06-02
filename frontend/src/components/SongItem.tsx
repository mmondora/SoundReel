import { useState } from 'react';
import type { Song } from '../types';
import { searchSpotifyTracks, addSongToSpotify } from '../services/api';
import type { SpotifyTrack } from '../services/api';
import { useLanguage } from '../i18n';

type SearchState = 'idle' | 'loading' | 'results' | 'adding' | 'done' | 'error';

interface SongItemProps {
  song: Song;
  entryId?: string;
  songIndex?: number;
}

export function SongItem({ song, entryId, songIndex }: SongItemProps) {
  const { t } = useLanguage();
  const [state, setState] = useState<SearchState>(
    song.addedToPlaylist ? 'done' : 'idle'
  );
  const [results, setResults] = useState<SpotifyTrack[]>([]);
  const [addingUri, setAddingUri] = useState<string | null>(null);
  const [query, setQuery] = useState(`${song.artist} ${song.title}`);

  const canManualAdd = !!entryId && songIndex !== undefined && !song.addedToPlaylist;

  const handleSearch = async (): Promise<void> => {
    setState('loading');
    try {
      const tracks = await searchSpotifyTracks(query);
      setResults(tracks);
      setState('results');
    } catch {
      setState('error');
    }
  };

  const handleAdd = async (track: SpotifyTrack): Promise<void> => {
    if (!entryId || songIndex === undefined) return;
    setAddingUri(track.uri);
    setState('adding');
    try {
      await addSongToSpotify(entryId, songIndex, track);
      setState('done');
    } catch {
      setAddingUri(null);
      setState('error');
    }
  };

  return (
    <div className="song-item">
      <div className="song-info">
        <span className="song-title">{song.title}</span>
        <span className="song-artist">{song.artist}</span>
        {song.album && <span className="song-album">{song.album}</span>}
      </div>

      <div className="song-actions">
        {song.spotifyUrl && (
          <a href={song.spotifyUrl} target="_blank" rel="noopener noreferrer"
             className="action-link spotify" title={t.openOnSpotify}>
            <span className="icon">S</span>
          </a>
        )}
        {song.youtubeUrl && (
          <a href={song.youtubeUrl} target="_blank" rel="noopener noreferrer"
             className="action-link youtube" title={t.searchOnYoutube}>
            <span className="icon">Y</span>
          </a>
        )}
        {song.soundcloudUrl && (
          <a href={song.soundcloudUrl} target="_blank" rel="noopener noreferrer"
             className="action-link soundcloud" title={t.searchOnSoundcloud}>
            <span className="icon">SC</span>
          </a>
        )}
        {(state === 'done') && (
          <span className="playlist-badge" title={t.addedToPlaylist}>+</span>
        )}
        {canManualAdd && state === 'idle' && (
          <button className="action-btn spotify-search-btn"
                  onClick={() => void handleSearch()}
                  title={t.searchOnSpotify}>
            S+
          </button>
        )}
        {state === 'loading' && <span className="compact-spinner" />}
        {state === 'error' && (
          <button className="action-btn spotify-search-btn"
                  onClick={() => void handleSearch()}
                  title={t.errorGeneric}>
            ↺
          </button>
        )}
      </div>

      {(state === 'results' || state === 'adding') && (
        <div className="spotify-results">
          <div className="spotify-results-query">
            <input
              className="spotify-results-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
            />
            <button className="action-btn" onClick={() => void handleSearch()}>🔍</button>
          </div>
          {results.length === 0 ? (
            <p className="spotify-no-results">{t.noSpotifyResults}</p>
          ) : (
            results.map((track) => (
              <div key={track.uri} className="spotify-result-row">
                {track.albumImageUrl && (
                  <img src={track.albumImageUrl} alt="" className="spotify-result-thumb"
                       width={32} height={32} />
                )}
                <div className="spotify-result-info">
                  <span className="spotify-result-name">{track.name}</span>
                  <span className="spotify-result-artist">{track.artist}</span>
                </div>
                <button
                  className="action-btn"
                  onClick={() => void handleAdd(track)}
                  disabled={state === 'adding'}
                  title={state === 'adding' && addingUri === track.uri
                    ? t.addingToPlaylist
                    : t.addToPlaylistBtn}
                >
                  {state === 'adding' && addingUri === track.uri ? '…' : '+'}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
