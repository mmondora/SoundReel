import { Logger } from './debugLogger';
import { downloadWithInstaloader } from './instaloaderLocal';
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

  log.info('Legacy path for non-IG platform', { platform });
  return extractContentLegacy(url, options);
}
