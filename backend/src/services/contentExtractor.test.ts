import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./instaloaderLocal', () => ({
  downloadWithInstaloader: vi.fn(),
  downloadMediaWithYtdlp: vi.fn(),
  fetchYtSubtitles: vi.fn(),
}));
vi.mock('./_legacy/contentExtractorLegacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_legacy/contentExtractorLegacy')>();
  return { ...actual, extractContentLegacy: vi.fn() };
});

import { extractContent, YTDLP_PLATFORMS } from './contentExtractor';
import { downloadWithInstaloader, downloadMediaWithYtdlp, fetchYtSubtitles } from './instaloaderLocal';
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
  subtitleText: null,
  subtitleLang: null,
  subtitleKind: null,
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
  subtitleText: null,
  subtitleLang: null,
  subtitleKind: null,
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
    vi.mocked(fetchYtSubtitles).mockResolvedValue({
      subtitleText: null,
      subtitleLang: null,
      subtitleKind: null,
    });
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

  it('still gets the written track when the video is too long to download', async () => {
    // The duration cap protects against pulling hundreds of megabytes. A
    // subtitle file is tens of kilobytes and does not care how long the video
    // is, so letting the cap take the text too lost it precisely on the long
    // talks — where Whisper costs the most and captions are likeliest to exist.
    vi.mocked(downloadMediaWithYtdlp).mockResolvedValue({
      ...FAILED_DOWNLOAD,
      error: 'video too long (2140s > 900s)',
    });
    vi.mocked(fetchYtSubtitles).mockResolvedValue({
      subtitleText: 'il testo della traccia',
      subtitleLang: 'it',
      subtitleKind: 'auto',
    });

    const content = await extractContent('https://youtu.be/abc123', { entryId: 'e1' });

    expect(fetchYtSubtitles).toHaveBeenCalledWith('https://youtu.be/abc123');
    // The legacy extraction still supplies caption and thumbnail; the track is
    // merged on top rather than replacing it.
    expect(content).toMatchObject({
      caption: LEGACY_CONTENT.caption,
      subtitleText: 'il testo della traccia',
      subtitleLang: 'it',
      subtitleKind: 'auto',
    });
  });

  it('leaves the legacy result untouched when there is no track either', async () => {
    vi.mocked(downloadMediaWithYtdlp).mockResolvedValue(FAILED_DOWNLOAD);
    const content = await extractContent('https://youtu.be/abc123', { entryId: 'e1' });
    expect(content).toEqual(LEGACY_CONTENT);
  });

  it('does not ask for subtitles when the download worked', async () => {
    // A successful download already carries the track; paying for a second
    // round trip on every healthy video would be waste.
    vi.mocked(downloadMediaWithYtdlp).mockResolvedValue(OK_DOWNLOAD);
    await extractContent('https://www.youtube.com/shorts/abc123', { entryId: 'e1' });
    expect(fetchYtSubtitles).not.toHaveBeenCalled();
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
