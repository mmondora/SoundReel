/**
 * Client for the instaloader sidecar's POST /yt/audio (see instaloader/yt_audio.py): find a song on
 * YouTube and download it as a tagged MP3 into the shared staging folder. Never throws: every failure is
 * a result with a code the downloader turns into "retry later" or "give up".
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

export type YtAudioCode =
  | 'no_source'
  | 'age_restricted'
  | 'blocked'
  | 'unavailable'
  | 'ffmpeg'
  | 'error'
  | 'bad_request'
  | 'transport';

export interface YtAudioJob {
  songKey: string;
  artist: string;
  title: string;
  album?: string | null;
  coverUrl?: string | null;
  expectedDurationS?: number | null;
  /** A YouTube link chosen by a person: wins over the search. */
  videoUrl?: string | null;
}

export type YtAudioResult =
  | {
      ok: true;
      path: string;
      bytes: number;
      durationS: number | null;
      videoId: string;
      videoTitle: string | null;
      channel: string | null;
      score: number | null;
      tagged: boolean;
    }
  | { ok: false; code: YtAudioCode; error: string; videoId?: string };

/** Shared by both containers (same volume, same path). */
export function stagingDir(): string {
  return process.env.STAGING_DIR || path.join(process.env.MEDIA_ROOT || '/data/media', '_staging');
}

/** One staging file per song, whatever the song's name looks like. */
export function stagingBasename(songKey: string): string {
  return `sf-${createHash('sha1').update(songKey).digest('hex').slice(0, 16)}`;
}

const REQUEST_TIMEOUT_MS = 175_000; // gunicorn's timeout is 180 s

const CODES: ReadonlySet<string> = new Set([
  'no_source', 'age_restricted', 'blocked', 'unavailable', 'ffmpeg', 'error', 'bad_request',
]);

export async function requestYtAudio(job: YtAudioJob, fetchImpl: typeof fetch = fetch): Promise<YtAudioResult> {
  const base = (process.env.INSTALOADER_URL || 'http://soundreel-instaloader:5000').replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/yt/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        artist: job.artist,
        title: job.title,
        album: job.album ?? null,
        coverUrl: job.coverUrl ?? null,
        expectedDurationS: job.expectedDurationS ?? null,
        videoUrl: job.videoUrl ?? null,
        outDir: stagingDir(),
        basename: stagingBasename(job.songKey),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, code: 'transport', error: `instaloader: risposta non valida (HTTP ${res.status})` };
    }
    if (body.ok === true && typeof body.path === 'string') {
      return {
        ok: true,
        path: body.path,
        bytes: Number(body.bytes) || 0,
        durationS: typeof body.durationS === 'number' ? body.durationS : null,
        videoId: String(body.videoId ?? ''),
        videoTitle: typeof body.videoTitle === 'string' ? body.videoTitle : null,
        channel: typeof body.channel === 'string' ? body.channel : null,
        score: typeof body.score === 'number' ? body.score : null,
        tagged: body.tagged === true,
      };
    }
    const code = typeof body.code === 'string' && CODES.has(body.code) ? (body.code as YtAudioCode) : res.ok ? 'error' : 'transport';
    return {
      ok: false,
      code,
      error: typeof body.error === 'string' && body.error ? body.error : `instaloader: HTTP ${res.status}`,
      ...(typeof body.videoId === 'string' ? { videoId: body.videoId } : {}),
    };
  } catch (err) {
    return { ok: false, code: 'transport', error: err instanceof Error ? err.message : String(err) };
  }
}
