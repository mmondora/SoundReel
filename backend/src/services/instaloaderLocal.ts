import { logInfo, logWarning, logError } from '../utils/logger';

export interface InstaloaderDownload {
  caption: string | null;
  musicInfo: { title: string; artist: string } | null;
  videoPath: string | null;
  audioPath: string | null;
  thumbnailPath: string | null;
  slidePaths: string[];
  framePaths: string[];
  success: boolean;
  error?: string;
}

const EMPTY: InstaloaderDownload = {
  caption: null,
  musicInfo: null,
  videoPath: null,
  audioPath: null,
  thumbnailPath: null,
  slidePaths: [],
  framePaths: [],
  success: false,
};

export async function downloadWithInstaloader(
  url: string,
  entryId: string,
): Promise<InstaloaderDownload> {
  const base = process.env.INSTALOADER_URL;
  if (!base) {
    logWarning('INSTALOADER_URL non configurato, skip');
    return { ...EMPTY, error: 'INSTALOADER_URL not set' };
  }

  const endpoint = `${base.replace(/\/$/, '')}/download`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, entryId }),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    let data: Partial<InstaloaderDownload> & { error?: string } = {};
    try {
      data = JSON.parse(bodyText);
    } catch {
      logWarning('Instaloader download: risposta non JSON', { preview: bodyText.substring(0, 500) });
      return { ...EMPTY, error: `invalid JSON response (HTTP ${response.status})` };
    }

    if (!response.ok || data.success === false) {
      logWarning('Instaloader download error', {
        status: response.status,
        error: data.error,
      });
      return { ...EMPTY, error: data.error || `HTTP ${response.status}` };
    }

    const result: InstaloaderDownload = {
      caption: data.caption ?? null,
      musicInfo: data.musicInfo ?? null,
      videoPath: data.videoPath ?? null,
      audioPath: data.audioPath ?? null,
      thumbnailPath: data.thumbnailPath ?? null,
      slidePaths: Array.isArray(data.slidePaths) ? data.slidePaths : [],
      framePaths: Array.isArray(data.framePaths) ? data.framePaths : [],
      success: true,
    };

    logInfo('Instaloader download ok', {
      entryId,
      hasVideo: !!result.videoPath,
      hasAudio: !!result.audioPath,
      hasThumbnail: !!result.thumbnailPath,
      slides: result.slidePaths.length,
      frames: result.framePaths.length,
      hasMusic: !!result.musicInfo,
    });
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logWarning('Instaloader download timeout', { entryId });
      return { ...EMPTY, error: 'timeout' };
    }
    logError('Instaloader download network error', error);
    return { ...EMPTY, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
