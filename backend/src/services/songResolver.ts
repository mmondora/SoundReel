import { searchTrack, generateYoutubeSearchUrl } from './spotify';
import { logInfo, logError } from '../utils/logger';
import type { ExtractedSong } from './musicListExtractor';
import { songKey, patchSongUserMeta } from './songMeta';
import { postToSpooty } from './spootyClient';

export interface ResolvedSong {
  title: string;
  artist: string;
  spotifyUrl: string | null;
  spotifyUri: string | null;
  youtubeUrl: string;
  sentToSpooty: boolean;
}

export async function resolveSong(song: ExtractedSong): Promise<ResolvedSong> {
  const youtubeUrl = generateYoutubeSearchUrl(song.title, song.artist);
  try {
    const track = await searchTrack(song.title, song.artist);
    if (!track) {
      logInfo('resolveSong: no Spotify result', { title: song.title, artist: song.artist });
      return { title: song.title, artist: song.artist, spotifyUrl: null, spotifyUri: null, youtubeUrl, sentToSpooty: false };
    }
    logInfo('resolveSong: Spotify found', { title: track.name, artist: track.artist });
    const sentToSpooty = await postToSpooty(track.url);
    if (sentToSpooty) {
      // Fire-and-forget: never delay/break song resolution on a song_meta write.
      void patchSongUserMeta(songKey(song.artist, song.title), { downloaded: true })
        .catch((err) => logError('song_meta downloaded flag update failed', { title: song.title, artist: song.artist, err: String(err) }));
    }
    return {
      title: song.title,
      artist: song.artist,
      spotifyUrl: track.url,
      spotifyUri: track.uri,
      youtubeUrl,
      sentToSpooty,
    };
  } catch (err) {
    logError('resolveSong failed', { title: song.title, err: String(err) });
    return { title: song.title, artist: song.artist, spotifyUrl: null, spotifyUri: null, youtubeUrl, sentToSpooty: false };
  }
}

export async function resolveSongs(songs: ExtractedSong[]): Promise<ResolvedSong[]> {
  return Promise.all(songs.map((s) => resolveSong(s)));
}
