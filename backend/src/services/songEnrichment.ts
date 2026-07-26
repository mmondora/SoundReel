import { logInfo, logWarning } from '../utils/logger';

export interface SongEnrichmentResult {
  deezerId: number | null;
  itunesId: number | null;
  genres: string[];
  album: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
  deezerUrl: string | null;
  itunesUrl: string | null;
}

/**
 * Accepts only absolute http(s) URLs. Guards against `javascript:` href
 * injection from provider data and drops fields with a missing/malformed
 * url rather than storing (and later rendering) something unsafe.
 */
function safeUrl(u: unknown): string | null {
  return typeof u === 'string' && /^https?:/i.test(u) ? u : null;
}

// --- Deezer ------------------------------------------------------------

interface DeezerTrack {
  id: number;
  link?: string;
  preview?: string;
  album?: {
    id: number;
    title?: string;
    cover_medium?: string;
  };
}

interface DeezerSearchResponse {
  data?: DeezerTrack[];
  error?: { code?: number; message?: string; type?: string };
}

interface DeezerAlbumResponse {
  genres?: { data?: Array<{ id: number; name: string }> };
}

async function getDeezerAlbumGenres(albumId: number | undefined): Promise<string[]> {
  if (!albumId) return [];
  try {
    const response = await fetch(`https://api.deezer.com/album/${albumId}`);
    if (!response.ok) {
      logWarning('Deezer album genres fallita', { albumId, status: response.status });
      return [];
    }
    const data = (await response.json()) as DeezerAlbumResponse;
    return (data.genres?.data ?? []).map((g) => g.name);
  } catch (error) {
    logWarning('Deezer album genres errore rete', { albumId, error: error instanceof Error ? error.message : error });
    return [];
  }
}

async function tryDeezer(artist: string, title: string): Promise<SongEnrichmentResult | null> {
  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}`;
    const response = await fetch(url);
    if (!response.ok) {
      logWarning('Deezer search fallita', { status: response.status });
      return null;
    }

    const data = (await response.json()) as DeezerSearchResponse;
    if (data.error) {
      // e.g. rate-limit: HTTP 200 with { error: { code: 4, ... } }
      logWarning('Deezer errore nella risposta', { error: data.error });
      return null;
    }

    if (!data.data || data.data.length === 0) {
      return null;
    }

    const track = data.data[0];
    const genres = await getDeezerAlbumGenres(track.album?.id);

    logInfo('Canzone trovata su Deezer', { deezerId: track.id, artist, title });
    return {
      deezerId: track.id,
      itunesId: null,
      genres,
      album: track.album?.title ?? null,
      coverUrl: safeUrl(track.album?.cover_medium),
      previewUrl: safeUrl(track.preview),
      deezerUrl: safeUrl(track.link),
      itunesUrl: null,
    };
  } catch (error) {
    logWarning('Deezer errore rete', { error: error instanceof Error ? error.message : error });
    return null;
  }
}

// --- iTunes --------------------------------------------------------------

interface ItunesTrack {
  trackId?: number;
  trackViewUrl?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  collectionName?: string;
  primaryGenreName?: string;
  artistName?: string;
  trackName?: string;
}

interface ItunesSearchResponse {
  results?: ItunesTrack[];
}

function looselyMatches(candidate: string, input: string): boolean {
  if (!candidate) return false;
  const c = candidate.toLowerCase();
  const i = input.trim().toLowerCase();
  return c.includes(i) || i.includes(c);
}

async function tryItunes(artist: string, title: string): Promise<SongEnrichmentResult | null> {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}&media=music&limit=5&country=IT`;
    const response = await fetch(url);
    if (!response.ok) {
      logWarning('iTunes search fallita', { status: response.status });
      return null;
    }

    const data = (await response.json()) as ItunesSearchResponse;
    if (!data.results || data.results.length === 0) {
      return null;
    }

    const match =
      data.results.find(
        (r) => looselyMatches(r.artistName ?? '', artist) || looselyMatches(r.trackName ?? '', title)
      ) ?? data.results[0];

    logInfo('Canzone trovata su iTunes', { itunesId: match.trackId, artist, title });
    return {
      deezerId: null,
      itunesId: match.trackId ?? null,
      genres: match.primaryGenreName ? [match.primaryGenreName] : [],
      album: match.collectionName ?? null,
      coverUrl: safeUrl(match.artworkUrl100),
      previewUrl: safeUrl(match.previewUrl),
      deezerUrl: null,
      itunesUrl: safeUrl(match.trackViewUrl),
    };
  } catch (error) {
    logWarning('iTunes errore rete', { error: error instanceof Error ? error.message : error });
    return null;
  }
}

// --- Public API ------------------------------------------------------------

/**
 * Deezer first, iTunes fallback. Never throws — every provider failure
 * (HTTP error, malformed body, rate-limit body, network throw) is logged
 * and treated as a miss so the next provider (or `null`) is returned. Safe
 * to call directly from the pipeline path.
 */
export async function enrichSong(artist: string, title: string): Promise<SongEnrichmentResult | null> {
  const deezerResult = await tryDeezer(artist, title);
  if (deezerResult) return deezerResult;

  const itunesResult = await tryItunes(artist, title);
  if (itunesResult) return itunesResult;

  return null;
}
