import { spotifyAuthorizeUrl } from './api';

// Spotify OAuth is now entirely server-side.
// The backend handles PKCE + token exchange + storage.
export async function initiateSpotifyAuth(): Promise<void> {
  window.location.href = spotifyAuthorizeUrl();
}
