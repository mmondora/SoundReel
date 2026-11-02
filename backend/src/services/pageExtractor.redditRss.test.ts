import { describe, it, expect } from 'vitest';
import {
  linksFromRedditPostHtml,
  pickPrimaryArticleUrl,
  mergeArticleIntoReddit,
} from './pageExtractor';
import type { PageExtractResult } from './pageExtractor';

const POST_HTML = `
  <div>
    <p>Top Claude skills this month:</p>
    <p><a href="https://github.com/foo/bar">foo/bar</a></p>
    <p>Full write-up: <a href="https://example.com/blog/skills-oct">skills oct</a></p>
    <p><a href="https://www.reddit.com/r/claudeskills/comments/abc/x/">discussion</a></p>
    <p><a href="/r/claude/comments/1">relative reddit</a></p>
  </div>
`;

describe('linksFromRedditPostHtml', () => {
  it('extracts absolute http(s) links with anchor text', () => {
    const links = linksFromRedditPostHtml(POST_HTML, 'https://www.reddit.com/r/claudeskills/comments/abc/x/');
    expect(links.map((l) => l.url)).toEqual([
      'https://github.com/foo/bar',
      'https://example.com/blog/skills-oct',
      'https://www.reddit.com/r/claudeskills/comments/abc/x/',
      'https://www.reddit.com/r/claude/comments/1',
    ]);
    expect(links[0].anchorText).toBe('foo/bar');
  });
});

describe('pickPrimaryArticleUrl', () => {
  it('prefers a blog/article link over a GitHub repo when both exist', () => {
    const links = linksFromRedditPostHtml(POST_HTML, 'https://www.reddit.com/r/x/comments/1/');
    expect(pickPrimaryArticleUrl(links)).toBe('https://example.com/blog/skills-oct');
  });

  it('falls back to a repo when that is the only outbound link', () => {
    expect(
      pickPrimaryArticleUrl([{ url: 'https://github.com/foo/bar', anchorText: 'foo/bar' }]),
    ).toBe('https://github.com/foo/bar');
  });

  it('returns null when only reddit links exist', () => {
    expect(
      pickPrimaryArticleUrl([
        { url: 'https://www.reddit.com/r/x/comments/1/', anchorText: 'x' },
        { url: 'https://old.reddit.com/r/y/', anchorText: null },
      ]),
    ).toBeNull();
  });
});

describe('mergeArticleIntoReddit', () => {
  const reddit: PageExtractResult = {
    finalUrl: 'https://www.reddit.com/r/x/comments/1/',
    httpStatus: 200,
    contentType: 'application/atom+xml',
    title: 'Cool post',
    description: 'body',
    mainText: '# Cool post\n\nbody',
    representativeImageUrl: null,
    rawLinks: [{ url: 'https://example.com/article', anchorText: 'article' }],
    siteName: 'Reddit',
    lang: null,
  };

  it('appends article mainText and merges rawLinks', () => {
    const article: PageExtractResult = {
      finalUrl: 'https://example.com/article',
      httpStatus: 200,
      contentType: 'text/html',
      title: 'Article title',
      description: 'desc',
      mainText: 'Long article body about skills.',
      representativeImageUrl: 'https://example.com/og.jpg',
      rawLinks: [{ url: 'https://example.com/related', anchorText: 'related' }],
      siteName: 'Example',
      lang: 'en',
    };
    const merged = mergeArticleIntoReddit(reddit, article);
    expect(merged.mainText).toContain('# Cool post');
    expect(merged.mainText).toContain('## Linked article');
    expect(merged.mainText).toContain('Long article body about skills.');
    expect(merged.rawLinks.map((l) => l.url)).toEqual([
      'https://example.com/article',
      'https://example.com/related',
    ]);
    expect(merged.representativeImageUrl).toBe('https://example.com/og.jpg');
  });

  it('keeps reddit result when article has no mainText', () => {
    const emptyArticle: PageExtractResult = {
      ...reddit,
      finalUrl: 'https://example.com/empty',
      mainText: null,
      rawLinks: [],
      siteName: 'Example',
    };
    const merged = mergeArticleIntoReddit(reddit, emptyArticle);
    expect(merged.mainText).toBe(reddit.mainText);
  });
});
