/**
 * Spooty client — the ONLY place that talks to Spooty's HTTP API.
 *
 * Verified against the running service and its compiled code (2026-11-07):
 *   POST   /api/playlist                  create from a Spotify track/album/playlist link
 *   GET    /api/playlist                  list (id, name, spotifyUrl, error, active, isTrack, coverUrl, …)
 *   DELETE /api/playlist/:id
 *   GET    /api/track/playlist/:id        tracks (id, artist, name, spotifyUrl, youtubeUrl, status, error, coverUrl)
 *   GET    /api/track/retry/:id           re-run a failed track
 *
 * A single-track link becomes a playlist with `isTrack: true` (name = track
 * title, coverUrl set) holding one track (artist, name, status).
 */
import { logWarning } from '../utils/logger';
import { canonicalSpotifyUrl } from './spotifyLink';

/** Spooty's TrackStatusEnum, read from its compiled backend. */
export const SpootyStatus = {
  New: 0,
  Searching: 1,
  Queued: 2,
  Downloading: 3,
  Completed: 4,
  Error: 5,
} as const;

export interface SpootyPlaylist {
  id: number;
  name: string;
  spotifyUrl: string;
  error: string | null;
  active: boolean;
  isTrack: boolean;
  coverUrl: string | null;
}

export interface SpootyTrack {
  id: number;
  artist: string;
  name: string;
  spotifyUrl: string;
  youtubeUrl: string | null;
  status: number;
  error: string | null;
  coverUrl: string | null;
}

export function isFinalSpootyStatus(status: number): boolean {
  return status === SpootyStatus.Completed || status === SpootyStatus.Error;
}

const TIMEOUT_MS = 8000;

function baseUrl(): string {
  return process.env.SPOOTY_URL || 'http://spooty:3000';
}

export function spootyFrontendUrl(): string {
  return process.env.SPOOTY_FRONTEND_URL || 'https://spooty.casamon.dev';
}

async function spootyFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function toPlaylist(raw: Record<string, unknown>): SpootyPlaylist {
  return {
    id: Number(raw.id),
    name: str(raw.name),
    spotifyUrl: str(raw.spotifyUrl),
    error: strOrNull(raw.error),
    active: raw.active === true,
    isTrack: raw.isTrack === true,
    coverUrl: strOrNull(raw.coverUrl),
  };
}

function toTrack(raw: Record<string, unknown>): SpootyTrack {
  return {
    id: Number(raw.id),
    artist: str(raw.artist),
    name: str(raw.name),
    spotifyUrl: str(raw.spotifyUrl),
    youtubeUrl: strOrNull(raw.youtubeUrl),
    status: typeof raw.status === 'number' ? raw.status : SpootyStatus.New,
    error: strOrNull(raw.error),
    coverUrl: strOrNull(raw.coverUrl),
  };
}

export type SpootyAddResult = { ok: true } | { ok: false; error: string };

/** POST a Spotify link to Spooty. Never throws: the caller decides what a failure means. */
export async function addToSpooty(spotifyUrl: string): Promise<SpootyAddResult> {
  try {
    const res = await spootyFetch('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyUrl }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logWarning('Spooty POST failed', { status: res.status, body: body.slice(0, 200) });
      return { ok: false, error: `Spooty HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logWarning('Spooty POST error', { err: error });
    return { ok: false, error };
  }
}

/** Back-compat boolean wrapper (songResolver, offline manifest). */
export async function postToSpooty(spotifyUrl: string): Promise<boolean> {
  return (await addToSpooty(spotifyUrl)).ok;
}

/** Throws when Spooty is unreachable — the watcher treats that as "try again later". */
export async function listSpootyPlaylists(): Promise<SpootyPlaylist[]> {
  const res = await spootyFetch('/api/playlist');
  if (!res.ok) throw new Error(`Spooty HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error('Spooty: unexpected /api/playlist payload');
  return data.map((p) => toPlaylist(p as Record<string, unknown>));
}

export async function listSpootyTracks(playlistId: number): Promise<SpootyTrack[]> {
  const res = await spootyFetch(`/api/track/playlist/${playlistId}`);
  if (!res.ok) throw new Error(`Spooty HTTP ${res.status}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error('Spooty: unexpected /api/track payload');
  return data.map((t) => toTrack(t as Record<string, unknown>));
}

/** Newest Spooty playlist created for this (canonical) Spotify URL, if any. */
export async function findSpootyPlaylistByUrl(canonicalUrl: string): Promise<SpootyPlaylist | null> {
  const all = await listSpootyPlaylists();
  const matches = all.filter((p) => canonicalSpotifyUrl(p.spotifyUrl) === canonicalUrl);
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.id > a.id ? b : a));
}

export async function retrySpootyTrack(trackId: number): Promise<boolean> {
  try {
    const res = await spootyFetch(`/api/track/retry/${trackId}`);
    return res.ok;
  } catch (err) {
    logWarning('Spooty retry error', { trackId, err: String(err) });
    return false;
  }
}

export async function deleteSpootyPlaylist(playlistId: number): Promise<boolean> {
  try {
    const res = await spootyFetch(`/api/playlist/${playlistId}`, { method: 'DELETE' });
    return res.ok;
  } catch (err) {
    logWarning('Spooty delete error', { playlistId, err: String(err) });
    return false;
  }
}
