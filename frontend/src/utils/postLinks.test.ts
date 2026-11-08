import { describe, expect, it } from 'vitest';
import { MAX_POST_LINKS, postLabel, postLinksOf } from './postLinks';

const m = (sourceUrl: string | null | undefined, sourcePlatform: string | null = 'instagram') => ({ sourceUrl, sourcePlatform });

describe('postLabel', () => {
  it.each([
    ['https://www.instagram.com/reel/DWDZS4Qob0U/?igsh=abc', 'instagram.com/reel/DWDZS4Qob0U'],
    ['https://www.tiktok.com/@a/video/123', 'tiktok.com/@a/video/123'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtu.be/dQw4w9WgXcQ'],
    ['https://example.com/', 'example.com'],
  ])('%s → %s', (url, label) => {
    expect(postLabel(url)).toBe(label);
  });

  it('shortens a very long address and survives something that is not a URL', () => {
    const long = postLabel(`https://example.com/${'a'.repeat(80)}`);
    expect(long.length).toBe(34);
    expect(long.endsWith('…')).toBe(true);
    expect(postLabel('not a url')).toBe('not a url');
  });
});

describe('postLinksOf: one link per post', () => {
  it('five songs of one post show the same single link', () => {
    const url = 'https://www.instagram.com/reel/DWDZS4Qob0U';
    expect(postLinksOf([m(url)]).links.map((l) => l.url)).toEqual([url]);
  });

  it('one link per post, the same post under two forms counted once', () => {
    const { links, more } = postLinksOf([
      m('https://www.instagram.com/reel/AAA/?igsh=1'),
      m('https://www.instagram.com/reel/AAA?utm_source=x'),
      m('https://www.tiktok.com/@a/video/1', 'tiktok'),
    ]);
    expect(links.map((l) => [l.platform, l.label])).toEqual([['instagram', 'instagram.com/reel/AAA'], ['tiktok', 'tiktok.com/@a/video/1']]);
    expect(more).toBe(0);
  });

  it('shows at most three and says how many more', () => {
    const many = Array.from({ length: 7 }, (_, i) => m(`https://www.instagram.com/reel/P${i}`));
    const { links, more } = postLinksOf(many);
    expect(MAX_POST_LINKS).toBe(3);
    expect(links).toHaveLength(3);
    expect(more).toBe(4);
  });

  it('mentions without a post address make no link (an older backend, or nothing stored)', () => {
    expect(postLinksOf([m(null), m(undefined), m('')])).toEqual({ links: [], more: 0 });
    expect(postLinksOf(undefined)).toEqual({ links: [], more: 0 });
    expect(postLinksOf([])).toEqual({ links: [], more: 0 });
  });

  it('never makes a link of something a browser should not open', () => {
    expect(postLinksOf([m('javascript:alert(1)'), m('data:text/html,x'), m('ftp://x.it/a'), m('//evil.com/x')]).links).toEqual([]);
  });
});
