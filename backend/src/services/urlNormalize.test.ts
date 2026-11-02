import { describe, it, expect } from 'vitest';
import { normalizeUrl, extractInstagramShortcode } from './urlNormalize';

describe('normalizeUrl', () => {
  it('strips utm_source param', () => {
    const url = 'https://example.com/path?utm_source=instagram';
    expect(normalizeUrl(url)).toBe('https://example.com/path');
  });

  it('strips utm_medium and utm_campaign together', () => {
    const url = 'https://example.com/page?utm_medium=social&utm_campaign=winter2025';
    expect(normalizeUrl(url)).toBe('https://example.com/page');
  });

  it('strips fbclid', () => {
    const url = 'https://example.com/?fbclid=IwAR0abc123';
    expect(normalizeUrl(url)).toBe('https://example.com/');
  });

  it('strips igshid', () => {
    const url = 'https://www.instagram.com/p/abc/?igshid=xyz';
    // trailing slash on /abc/ gets removed by normalizeUrl (path > '/')
    expect(normalizeUrl(url)).toBe('https://www.instagram.com/p/abc');
  });

  it('strips _ga param', () => {
    const url = 'https://example.com/article?_ga=2.123456789.0.0';
    expect(normalizeUrl(url)).toBe('https://example.com/article');
  });

  it('strips ref param', () => {
    const url = 'https://example.com/page?ref=homepage';
    expect(normalizeUrl(url)).toBe('https://example.com/page');
  });

  it('keeps non-tracking params', () => {
    const url = 'https://www.youtube.com/watch?v=abc123';
    expect(normalizeUrl(url)).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('keeps multiple non-tracking params', () => {
    const url = 'https://example.com/search?q=music&page=2';
    expect(normalizeUrl(url)).toBe('https://example.com/search?q=music&page=2');
  });

  it('lowercases hostname', () => {
    const url = 'https://YOUTUBE.COM/watch?v=test';
    const result = normalizeUrl(url);
    expect(result).toContain('youtube.com');
    expect(result).not.toContain('YOUTUBE');
  });

  it('drops fragment', () => {
    const url = 'https://example.com/page#section-2';
    expect(normalizeUrl(url)).toBe('https://example.com/page');
  });

  it('removes trailing slash from non-root path', () => {
    const url = 'https://example.com/path/';
    expect(normalizeUrl(url)).toBe('https://example.com/path');
  });

  it('does NOT remove lone slash (root path preserved)', () => {
    const url = 'https://example.com/';
    expect(normalizeUrl(url)).toBe('https://example.com/');
  });

  it('is idempotent: normalizeUrl(normalizeUrl(url)) === normalizeUrl(url)', () => {
    const url = 'https://EXAMPLE.COM/path/?utm_source=fb&fbclid=abc#hash';
    const once = normalizeUrl(url);
    const twice = normalizeUrl(once);
    expect(twice).toBe(once);
  });

  it('returns malformed string as-is (trimmed)', () => {
    const malformed = '  not-a-url  ';
    expect(normalizeUrl(malformed)).toBe('not-a-url');
  });

  it('strips tracking params while keeping non-tracking ones', () => {
    const url = 'https://example.com/page?v=abc&utm_source=ig&fbclid=xyz';
    expect(normalizeUrl(url)).toBe('https://example.com/page?v=abc');
  });

  it('strips Instagram share params so mdxt and obrf collapse to the same URL', () => {
    const mdxt = 'https://www.instagram.com/p/DfM5C7FjfzZ/?mdxt=MTF5d3Zwc3lrYTF2Yg==';
    const obrf = 'https://www.instagram.com/p/DfM5C7FjfzZ?obrf=MTF5d3Zwc3lrYTF2Yg%3D%3D';
    expect(normalizeUrl(mdxt)).toBe('https://www.instagram.com/p/DfM5C7FjfzZ');
    expect(normalizeUrl(obrf)).toBe('https://www.instagram.com/p/DfM5C7FjfzZ');
  });

  it('strips igsh / stkn / img_index on reels', () => {
    const url = 'https://www.instagram.com/reel/abc123/?img_index=3&igsh=xyz&stkn=tok';
    expect(normalizeUrl(url)).toBe('https://www.instagram.com/reel/abc123');
  });
});

describe('extractInstagramShortcode', () => {
  it('reads /p/ shortcode', () => {
    expect(extractInstagramShortcode('https://www.instagram.com/p/DfM5C7FjfzZ/?mdxt=x')).toBe('DfM5C7FjfzZ');
  });

  it('reads /reel/ shortcode', () => {
    expect(extractInstagramShortcode('https://instagram.com/reel/AbC_12-3')).toBe('AbC_12-3');
  });

  it('returns null for non-Instagram hosts', () => {
    expect(extractInstagramShortcode('https://tiktok.com/@x/video/1')).toBeNull();
  });

  it('returns null for profile URLs', () => {
    expect(extractInstagramShortcode('https://www.instagram.com/someuser/')).toBeNull();
  });
});
