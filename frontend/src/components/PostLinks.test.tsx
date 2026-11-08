import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../i18n';
import { PostLinks } from './PostLinks';

const render = (mentions: Array<{ sourceUrl?: string | null; sourcePlatform?: string | null }> | undefined) =>
  renderToStaticMarkup(
    <LanguageProvider>
      <PostLinks mentions={mentions} />
    </LanguageProvider>,
  );

describe('PostLinks', () => {
  it('renders "Dal post" with a safe link to the original post (new tab, no opener)', () => {
    const html = render([{ sourceUrl: 'https://www.instagram.com/reel/DWDZS4Qob0U/?igsh=1', sourcePlatform: 'instagram' }]);
    expect(html).toContain('post-links');
    expect(html).toContain('href="https://www.instagram.com/reel/DWDZS4Qob0U/?igsh=1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('instagram.com/reel/DWDZS4Qob0U');
  });

  it('says how many more posts there are beyond three', () => {
    const html = render(Array.from({ length: 5 }, (_, i) => ({ sourceUrl: `https://www.instagram.com/reel/P${i}`, sourcePlatform: 'instagram' })));
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain('+2');
  });

  it('renders nothing when no mention has a post', () => {
    expect(render([{ sourceUrl: null }])).toBe('');
    expect(render(undefined)).toBe('');
  });
});
