import { Logger } from './debugLogger';
import { downloadWithInstaloader, downloadMediaWithYtdlp } from './instaloaderLocal';
import {
  detectPlatform as detectPlatformLegacy,
  getPlatformConfig as getPlatformConfigLegacy,
  getPlatformLabel as getPlatformLabelLegacy,
  setLogger as setLegacyLogger,
  extractContentLegacy,
  InstagramCookies,
  ExtractContentOptions as LegacyExtractOptions,
} from './_legacy/contentExtractorLegacy';
import type { ExtractedContent } from '../types';

let log = new Logger('contentExtractor');

export function setLogger(logger: Logger): void {
  log = logger;
  setLegacyLogger(logger);
}

export const detectPlatform = detectPlatformLegacy;
export const getPlatformConfig = getPlatformConfigLegacy;
export const getPlatformLabel = getPlatformLabelLegacy;
export type { InstagramCookies };

export interface ExtractContentOptions extends LegacyExtractOptions {
  entryId?: string;
}

/**
 * Instagram local path: delegates to Instaloader sidecar for full local download
 * (video, audio, carousel slides, frames, thumbnail). No oEmbed / OG / cobalt / cookie API.
 */
async function extractInstagramLocal(url: string, entryId: string): Promise<ExtractedContent & { __downloadError?: string | null }> {
  log.info('IG local path: Instaloader /download', { url, entryId });
  const dl = await downloadWithInstaloader(url, entryId);

  if (!dl.success) {
    log.warn('Instaloader download fallito', { error: dl.error });
  }

  return {
    caption: dl.caption,
    thumbnailUrl: null,
    audioUrl: null,
    videoUrl: null,
    hasAudio: !!dl.audioPath,
    hasCaption: !!dl.caption,
    musicInfo: dl.musicInfo,
    carouselUrls: [],
    localPaths: {
      videoPath: dl.videoPath,
      audioPath: dl.audioPath,
      thumbnailPath: dl.thumbnailPath,
      slidePaths: dl.slidePaths,
      framePaths: dl.framePaths,
    },
    __downloadError: dl.success ? null : dl.error || 'unknown',
  };
}

// Platforms whose media the sidecar can download via yt-dlp. Vimeo/SoundCloud/
// Twitch stay on the legacy path until there's a real need for them.
export const YTDLP_PLATFORMS = new Set(['youtube', 'tiktok']);

/**
 * YouTube/TikTok local path: yt-dlp in the sidecar downloads the video and
 * derives audio/frames/thumbnail — same layout as the IG path, so the whole
 * local pipeline (Whisper/OCR/vision/Shazam) runs on it. Unlike IG, a failed
 * download is NOT fatal: it degrades to the legacy oEmbed/OG extraction,
 * which is exactly what these platforms got before this path existed.
 */
async function extractMediaLocal(
  url: string,
  entryId: string,
  options: ExtractContentOptions,
): Promise<ExtractedContent> {
  log.info('Media local path: sidecar /download-media (yt-dlp)', { url, entryId });
  const dl = await downloadMediaWithYtdlp(url, entryId);

  if (!dl.success || (!dl.videoPath && !dl.audioPath)) {
    log.warn('yt-dlp download fallito, fallback su legacy', { error: dl.error });
    return extractContentLegacy(url, options);
  }

  return {
    caption: dl.caption,
    thumbnailUrl: null,
    audioUrl: null,
    videoUrl: null,
    hasAudio: !!dl.audioPath,
    hasCaption: !!dl.caption,
    musicInfo: dl.musicInfo,
    carouselUrls: [],
    localPaths: {
      videoPath: dl.videoPath,
      audioPath: dl.audioPath,
      thumbnailPath: dl.thumbnailPath,
      slidePaths: dl.slidePaths,
      framePaths: dl.framePaths,
    },
  };
}

export async function extractContent(
  url: string,
  options: ExtractContentOptions = {},
): Promise<ExtractedContent> {
  const platform = detectPlatform(url);

  if (platform === 'instagram') {
    if (!options.entryId) {
      throw new Error('entryId is required for Instagram extraction (local path)');
    }
    return extractInstagramLocal(url, options.entryId);
  }

  if (YTDLP_PLATFORMS.has(platform) && options.entryId) {
    return extractMediaLocal(url, options.entryId, options);
  }

  log.info('Legacy path for non-IG platform', { platform });
  return extractContentLegacy(url, options);
}
