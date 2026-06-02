import { logInfo, logWarning, logError } from '../utils/logger';

export interface ShazamTrack {
  title: string;
  artist: string;
  spotifyUrl: string | null;
  youtubeUrl: string | null;
  timestampMs?: number;
}

function instaloaderUrl(): string {
  return (process.env.INSTALOADER_URL ?? '').replace(/\/$/, '');
}

async function postJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T | null> {
  const base = instaloaderUrl();
  if (!base) {
    logWarning('INSTALOADER_URL not set, skipping shazam');
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      logWarning(`shazamClient ${path} HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logWarning(`shazamClient ${path} timeout after ${timeoutMs}ms`);
    } else {
      logError(`shazamClient ${path} error`, err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function recognizeAudio(audioPath: string): Promise<ShazamTrack | null> {
  const track = await postJson<ShazamTrack>('/shazam/recognize', { audioPath }, 60_000);
  if (track) logInfo('Shazam recognized', { title: track.title, artist: track.artist });
  return track;
}

export async function scanFullAudio(audioPath: string): Promise<ShazamTrack[]> {
  const tracks = await postJson<ShazamTrack[]>('/shazam/scan-full', { audioPath }, 300_000);
  if (!tracks) return [];
  logInfo('Shazam scan-full', { found: tracks.length });
  return tracks;
}

export async function resolveYoutubeUrl(artist: string, title: string): Promise<string | null> {
  const base = instaloaderUrl();
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`${base}/yt/url?q=${q}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { url: string | null };
    return data.url ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
