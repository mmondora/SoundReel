import { logInfo, logWarning, logError } from '../../utils/logger';

export interface InstaloaderResult {
  caption: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  musicInfo: { title: string; artist: string } | null;
  carouselUrls: string[];
  success: boolean;
}

export async function fetchWithInstaloader(url: string): Promise<InstaloaderResult> {
  const base = process.env.INSTALOADER_URL;
  if (!base) {
    logWarning('INSTALOADER_URL non configurato, skip');
    return { caption: null, thumbnailUrl: null, videoUrl: null, musicInfo: null, carouselUrls: [], success: false };
  }

  const endpoint = `${base.replace(/\/$/, '')}/fetch?url=${encodeURIComponent(url)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) {
      logWarning('Instaloader HTTP error', { status: response.status });
      return { caption: null, thumbnailUrl: null, videoUrl: null, musicInfo: null, carouselUrls: [], success: false };
    }
    const data = (await response.json()) as Partial<InstaloaderResult> & { error?: string };
    if (data.error) {
      logWarning('Instaloader returned error', { error: data.error });
      return { caption: null, thumbnailUrl: null, videoUrl: null, musicInfo: null, carouselUrls: [], success: false };
    }
    logInfo('Instaloader estrazione riuscita', {
      hasCaption: !!data.caption,
      hasThumbnail: !!data.thumbnailUrl,
      hasVideo: !!data.videoUrl,
      hasMusic: !!data.musicInfo,
      slides: data.carouselUrls?.length ?? 0,
    });
    return {
      caption: data.caption ?? null,
      thumbnailUrl: data.thumbnailUrl ?? null,
      videoUrl: data.videoUrl ?? null,
      musicInfo: data.musicInfo ?? null,
      carouselUrls: data.carouselUrls ?? [],
      success: true,
    };
  } catch (error) {
    logError('Instaloader network error', error);
    return { caption: null, thumbnailUrl: null, videoUrl: null, musicInfo: null, carouselUrls: [], success: false };
  } finally {
    clearTimeout(timeout);
  }
}
