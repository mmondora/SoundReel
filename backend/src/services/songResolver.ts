import { searchTrack, generateYoutubeSearchUrl } from './spotify';
import { logInfo, logWarning, logError } from '../utils/logger';
import type { ExtractedSong } from './musicListExtractor';

export interface ResolvedSong {
  title: string;
  artist: string;
  spotifyUrl: string | null;
  spotifyUri: string | null;
  youtubeUrl: string;
  sentToSpooty: boolean;
}

async function postToSpooty(spotifyUrl: string): Promise<boolean> {
  const base = process.env.SPOOTY_URL || 'http://spooty:3000';
  try {
    const res = await fetch(`${base}/api/playlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyUrl }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logWarning('Spooty POST failed', { status: res.status, body: body.slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    logWarning('Spooty POST error', { err: String(err) });
    return false;
  }
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
