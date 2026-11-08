import { describe, it, expect } from 'vitest';
import { extractYoutubeVideoId, youtubeWatchUrl } from './youtubeVideoId';

describe('extractYoutubeVideoId', () => {
  it('parses watch?v=', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('parses youtu.be', () => {
    expect(extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('parses shorts and embed', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for search URLs and empty', () => {
    expect(extractYoutubeVideoId('https://youtube.com/results?search_query=Apocalypse')).toBeNull();
    expect(extractYoutubeVideoId(null)).toBeNull();
    expect(extractYoutubeVideoId('')).toBeNull();
  });
});

describe('youtubeWatchUrl', () => {
  it('builds a watch URL', () => {
    expect(youtubeWatchUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
