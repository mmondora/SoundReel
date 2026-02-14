import { defineSecret } from 'firebase-functions/params';
import { logInfo, logWarning, logError } from '../utils/logger';
import { getSpotifyConfig, updateSpotifyConfig } from '../utils/firestore';
import type { SpotifySearchResult } from '../types';

const spotifyClientId = defineSecret('SPOTIFY_CLIENT_ID');
const spotifyClientSecret = defineSecret('SPOTIFY_CLIENT_SECRET');

async function refreshAccessToken(): Promise<string | null> {
  try {
    const config = await getSpotifyConfig();
    if (!config) {
      logWarning('Spotify non configurato');
      return null;
    }

    if (Date.now() < config.expiresAt - 60000) {
      return config.accessToken;
    }

    logInfo('Refresh del token Spotify');

    const clientId = spotifyClientId.value();
    const clientSecret = spotifyClientSecret.value();

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: config.refreshToken
      })
    });

    if (!response.ok) {
      logError('Errore refresh token Spotify', { status: response.status });
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const newExpiresAt = Date.now() + data.expires_in * 1000;

    await updateSpotifyConfig({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || config.refreshToken,
      expiresAt: newExpiresAt
    });

    logInfo('Token Spotify refreshato');
    return data.access_token;
  } catch (error) {
    logError('Errore durante refresh token', error);
    return null;
  }
}

export async function searchTrack(
  title: string,
  artist: string
): Promise<SpotifySearchResult | null> {
  try {
    const accessToken = await refreshAccessToken();
    if (!accessToken) {
      return null;
    }

    const query = encodeURIComponent(`track:${title} artist:${artist}`);
    const url = `https://api.spotify.com/v1/search?q=${query}&type=track&limit=1`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      logWarning('Spotify search fallita', { status: response.status });
      return null;
    }

    const data = await response.json() as {
      tracks: {
        items: Array<{
          uri: string;
          external_urls: { spotify: string };
          name: string;
          artists: Array<{ name: string }>;
        }>;
      };
    };

    if (!data.tracks.items.length) {
      logInfo('Nessun risultato Spotify', { title, artist });
      return null;
    }

    const track = data.tracks.items[0];
    logInfo('Track Spotify trovata', { name: track.name });

    return {
      uri: track.uri,
      url: track.external_urls.spotify,
      name: track.name,
      artist: track.artists[0]?.name || artist
    };
  } catch (error) {
    logError('Errore ricerca Spotify', error);
    return null;
  }
}

export async function addToPlaylist(trackUri: string): Promise<boolean> {
  try {
    const accessToken = await refreshAccessToken();
    if (!accessToken) {
      return false;
    }

    const config = await getSpotifyConfig();
    let playlistId = config?.playlistId;

    if (!playlistId) {
      playlistId = await createPlaylist(accessToken);
      if (!playlistId) {
        return false;
      }
    }

    const response = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          uris: [trackUri]
        })
      }
    );

    if (!response.ok) {
      logWarning('Errore aggiunta a playlist', { status: response.status });
      return false;
    }

    logInfo('Track aggiunta alla playlist', { trackUri });
    return true;
  } catch (error) {
    logError('Errore aggiunta playlist', error);
    return false;
  }
}

async function createPlaylist(accessToken: string): Promise<string | null> {
  try {
    const userResponse = await fetch('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!userResponse.ok) {
      logError('Errore fetch user Spotify');
      return null;
    }

    const userData = await userResponse.json() as { id: string };

    const createResponse = await fetch(
      `https://api.spotify.com/v1/users/${userData.id}/playlists`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'SoundReel',
          description: 'Canzoni estratte automaticamente da SoundReel',
          public: false
        })
      }
    );

    if (!createResponse.ok) {
      logError('Errore creazione playlist');
      return null;
    }

    const playlistData = await createResponse.json() as { id: string };
    await updateSpotifyConfig({ playlistId: playlistData.id });

    logInfo('Playlist SoundReel creata', { playlistId: playlistData.id });
    return playlistData.id;
  } catch (error) {
    logError('Errore creazione playlist', error);
    return null;
  }
}

export function generateYoutubeSearchUrl(title: string, artist: string): string {
  const query = encodeURIComponent(`${artist} ${title}`);
  return `https://youtube.com/results?search_query=${query}`;
}

export function generateSoundcloudSearchUrl(title: string, artist: string): string {
  const query = encodeURIComponent(`${artist} ${title}`);
  return `https://soundcloud.com/search/sounds?q=${query}`;
}

export { spotifyClientId, spotifyClientSecret };
