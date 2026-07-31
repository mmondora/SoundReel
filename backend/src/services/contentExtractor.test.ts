import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./instaloaderLocal', () => ({
  downloadWithInstaloader: vi.fn(),
  downloadMediaWithYtdlp: vi.fn(),
}));
vi.mock('./_legacy/contentExtractorLegacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_legacy/contentExtractorLegacy')>();
  return { ...actual, extractContentLegacy: vi.fn() };
});

import { extractContent, YTDLP_PLATFORMS } from './contentExtractor';
import { downloadWithInstaloader, downloadMediaWithYtdlp } from './instaloaderLocal';
import { extractContentLegacy } from './_legacy/contentExtractorLegacy';
import type { InstaloaderDownload } from './instaloaderLocal';
import type { ExtractedContent } from '../types';

const OK_DOWNLOAD: InstaloaderDownload = {
  caption: 'My Short\n\nDescription here',
  musicInfo: { title: 'Song', artist: 'Artist' },
  videoPath: '/data/media/e1/video.mp4',
  audioPath: '/data/media/e1/audio.wav',
  thumbnailPath: '/data/media/e1/thumbnail-source.jpg',
  slidePaths: [],
  framePaths: ['/data/media/e1/frame-001.jpg'],
  success: true,
};

const FAILED_DOWNLOAD: InstaloaderDownload = {
  caption: null,
  musicInfo: null,
  videoPath: null,
  audioPath: null,
  thumbnailPath: null,
  slidePaths: [],
  framePaths: [],
  success: false,
  error: 'video too long (1200s > 900s)',
};

const LEGACY_CONTENT: ExtractedContent = {
  caption: 'oEmbed title',
  thumbnailUrl: 'https://i.ytimg.com/vi/x/hq.jpg',
  audioUrl: null,
  videoUrl: null,
  hasAudio: false,
  hasCaption: true,
  musicInfo: null,
  carouselUrls: [],
};

describe('extractContent dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(extractContentLegacy).mockResolvedValue(LEGACY_CONTENT);
  });

  it('YTDLP_PLATFORMS covers youtube and tiktok only', () => {
    expect([...YTDLP_PLATFORMS].sort()).toEqual(['tiktok', 'youtube']);
  });

  it('YouTube Short with entryId goes through yt-dlp and returns localPaths', async () => {
    vi.mocked(downloadMediaWithYtdlp).mockResolvedValue(OK_DOWNLOAD);
    const content = await extractContent('https://www.youtube.com/shorts/abc123', { entryId: 'e1' });

    expect(downloadMediaWithYtdlp).toHaveBeenCalledWith('https://www.youtube.com/shorts/abc123', 'e1');
    expect(extractContentLegacy).not.toHaveBeenCalled();
    expect(content.localPaths).toEqual({
      videoPath: '/data/media/e1/video.mp4',
      audioPath: '/data/media/e1/audio.wav',
      thumbnailPath: '/data/media/e1/thumbnail-source.jpg',
      slidePaths: [],
      framePaths: ['/data/media/e1/frame-001.jpg'],
    });
    expect(content.hasAudio).toBe(true);
    expect(content.musicInfo).toEqual({ title: 'Song', artist: 'Artist' });
    expect(content.caption).toBe('My Short\n\nDescription here');
  });

  it('TikTok with entryId also goes through yt-dlp', async () => {
    vi.mocked(downloadMediaWithYtdlp).mockResolvedValue(OK_DOWNLOAD);
    await extractContent('https://www.tiktok.com/@user/video/123', { entryId: 'e2' });
    expect(downloadMediaWithYtdlp).toHaveBeenCalledWith('https://www.tiktok.com/@user/video/123', 'e2');
  });

  it('falls back to legacy extraction when the yt-dlp download fails', async () => {
    vi.mocked(downloadMediaWithYtdlp).mockResolvedValue(FAILED_DOWNLOAD);
    const content = await extractContent('https://www.youtube.com/shorts/abc123', { entryId: 'e1' });

    expect(extractContentLegacy).toHaveBeenCalled();
    expect(content).toEqual(LEGACY_CONTENT);
  });

  it('falls back to legacy when yt-dlp "succeeds" without any media file', async () => {
    vi.mocked(downloadMediaWithYtdlp).mockResolvedValue({
      ...FAILED_DOWNLOAD,
      success: true,
    });
    const content = await extractContent('https://www.youtube.com/watch?v=abc', { entryId: 'e1' });

    expect(extractContentLegacy).toHaveBeenCalled();
    expect(content).toEqual(LEGACY_CONTENT);
  });

  it('YouTube without entryId keeps the legacy path (no sidecar call)', async () => {
    const content = await extractContent('https://youtu.be/abc123');
    expect(downloadMediaWithYtdlp).not.toHaveBeenCalled();
    expect(extractContentLegacy).toHaveBeenCalled();
    expect(content).toEqual(LEGACY_CONTENT);
  });

  it('non-ytdlp media platform (vimeo) keeps the legacy path even with entryId', async () => {
    await extractContent('https://vimeo.com/12345', { entryId: 'e3' });
    expect(downloadMediaWithYtdlp).not.toHaveBeenCalled();
    expect(extractContentLegacy).toHaveBeenCalled();
  });

  it('Instagram still uses instaloader and requires entryId', async () => {
    vi.mocked(downloadWithInstaloader).mockResolvedValue(OK_DOWNLOAD);
    await extractContent('https://www.instagram.com/reel/xyz/', { entryId: 'e4' });
    expect(downloadWithInstaloader).toHaveBeenCalledWith('https://www.instagram.com/reel/xyz/', 'e4');
    expect(downloadMediaWithYtdlp).not.toHaveBeenCalled();

    await expect(extractContent('https://www.instagram.com/reel/xyz/')).rejects.toThrow(/entryId/);
  });
});
