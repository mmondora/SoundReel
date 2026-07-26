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
export function safeUrl(u: unknown): string | null {
  return typeof u === 'string' && /^https?:/i.test(u) ? u : null;
}

/** Loose containment match, case-insensitive, either direction. Shared by
 * both providers' match-verification logic below. */
function looselyMatches(candidate: string, input: string): boolean {
  if (!candidate) return false;
  const c = candidate.toLowerCase();
  const i = input.trim().toLowerCase();
  return c.includes(i) || i.includes(c);
}

// --- Deezer ------------------------------------------------------------

interface DeezerTrack {
  id: number;
  title?: string;
  artist?: { name?: string };
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

interface DeezerTrackResponse {
  preview?: string;
  error?: { code?: number; message?: string; type?: string };
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

/**
 * Same T2 ruling as iTunes' selectItunesMatch, applied to Deezer: Deezer's
 * search endpoint can rank a same-titled track by an unrelated artist above
 * the real match, so we can't blindly trust data[0]. Precedence: (1) first
 * result where BOTH artist.name and title loosely match (artist check is
 * vacuous-true when the input artist is '', since some mentions have no
 * artist at all); (2) else first result where title alone loosely matches;
 * (3) else `null` — unlike iTunes, Deezer has no "just take the first one"
 * last resort, it's treated as a miss so enrichSong falls through to iTunes.
 */
function selectDeezerMatch(results: DeezerTrack[], artist: string, title: string): DeezerTrack | null {
  const artistMatch = (r: DeezerTrack) => artist.trim() === '' || looselyMatches(r.artist?.name ?? '', artist);
  const titleMatch = (r: DeezerTrack) => looselyMatches(r.title ?? '', title);

  return (
    results.find((r) => artistMatch(r) && titleMatch(r)) ??
    results.find((r) => titleMatch(r)) ??
    null
  );
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

    const track = selectDeezerMatch(data.data, artist, title);
    if (!track) {
      logInfo('Deezer: nessun risultato con match affidabile, fallback a iTunes', { artist, title });
      return null;
    }

    const genres = await getDeezerAlbumGenres(track.album?.id);

    logInfo('Canzone trovata su Deezer', { deezerId: track.id, artist, title });
    return {
      deezerId: track.id,
      itunesId: null,
      genres,
      album: track.album?.title ?? null,
      coverUrl: safeUrl(track.album?.cover_medium),
      // Deezer's `preview` is a signed URL that expires ~14min after being
      // issued (live-verified: `?hdnea=exp=...` → 403 once expired). By the
      // time a user clicks ▶ on a stored song, it's almost always already
      // dead. Never persist it — GET /api/songs/:songKey/preview resolves a
      // fresh one on demand from `deezerId` right before playback.
      previewUrl: null,
      deezerUrl: safeUrl(track.link),
      itunesUrl: null,
    };
  } catch (error) {
    logWarning('Deezer errore rete', { error: error instanceof Error ? error.message : error });
    return null;
  }
}

/**
 * Live-resolves a fresh (not-yet-expired) Deezer preview URL for a known
 * track id, for on-demand playback. Never cached back to the DB — the
 * caller (GET /api/songs/:songKey/preview) returns it straight to the
 * client. Returns `null` on any failure (HTTP error, rate-limit body,
 * missing/malformed preview field, network throw) — the route turns that
 * into a 404 rather than propagating an error.
 */
export async function resolveDeezerPreviewUrl(deezerId: number): Promise<string | null> {
  try {
    const response = await fetch(`https://api.deezer.com/track/${deezerId}`);
    if (!response.ok) {
      logWarning('Deezer live preview resolve fallita', { deezerId, status: response.status });
      return null;
    }
    const data = (await response.json()) as DeezerTrackResponse;
    if (data.error) {
      logWarning('Deezer live preview resolve errore risposta', { deezerId, error: data.error });
      return null;
    }
    return safeUrl(data.preview);
  } catch (error) {
    logWarning('Deezer live preview resolve errore rete', {
      deezerId,
      error: error instanceof Error ? error.message : error,
    });
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

/**
 * Precedence: (1) first result where BOTH artistName and trackName loosely
 * match — avoids picking a same-titled track by an unrelated artist (e.g. a
 * cover band) over the real one; (2) else first result where EITHER
 * matches; (3) else the first result outright.
 */
function selectItunesMatch(results: ItunesTrack[], artist: string, title: string): ItunesTrack {
  const artistMatch = (r: ItunesTrack) => looselyMatches(r.artistName ?? '', artist);
  const trackMatch = (r: ItunesTrack) => looselyMatches(r.trackName ?? '', title);

  return (
    results.find((r) => artistMatch(r) && trackMatch(r)) ??
    results.find((r) => artistMatch(r) || trackMatch(r)) ??
    results[0]
  );
}

// iTunes' undocumented Search API rate-limits at roughly 20 req/min. This is
// the fallback path only (Deezer first), but both the pipeline hook (one
// fire-and-forget call per song mention, potentially several in parallel)
// and the backfill script funnel through the same `tryItunes`, so the
// throttle lives here rather than in either caller — it's the one place
// that sees every call regardless of who's making it.
const ITUNES_MIN_INTERVAL_MS = 3000;
let lastItunesCall = -Infinity;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test-only: resets the throttle window so each test doesn't have to wait
 * out (or fake-timer-advance past) a real 3s window left over from a prior
 * test/call. */
export function _resetItunesThrottle(): void {
  lastItunesCall = -Infinity;
}

async function waitForItunesThrottle(): Promise<void> {
  const elapsed = Date.now() - lastItunesCall;
  if (elapsed < ITUNES_MIN_INTERVAL_MS) {
    await sleep(ITUNES_MIN_INTERVAL_MS - elapsed);
  }
  lastItunesCall = Date.now();
}

async function tryItunes(artist: string, title: string): Promise<SongEnrichmentResult | null> {
  try {
    await waitForItunesThrottle();

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

    const match = selectItunesMatch(data.results, artist, title);

    logInfo('Canzone trovata su iTunes', { itunesId: match.trackId, artist, title });
    return {
      deezerId: null,
      itunesId: match.trackId ?? null,
      genres: match.primaryGenreName ? [match.primaryGenreName] : [],
      album: match.collectionName ?? null,
      coverUrl: safeUrl(match.artworkUrl100),
      // iTunes preview URLs are durable (unlike Deezer's), safe to persist.
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
 * (HTTP error, malformed body, rate-limit body, network throw, no
 * sufficiently-verified match) is logged and treated as a miss so the next
 * provider (or `null`) is returned. Safe to call directly from the pipeline
 * path.
 */
export async function enrichSong(artist: string, title: string): Promise<SongEnrichmentResult | null> {
  const deezerResult = await tryDeezer(artist, title);
  if (deezerResult) return deezerResult;

  const itunesResult = await tryItunes(artist, title);
  if (itunesResult) return itunesResult;

  return null;
}
