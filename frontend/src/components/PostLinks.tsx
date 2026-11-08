import { useLanguage } from '../i18n';
import { postLinksOf } from '../utils/postLinks';
import type { SongMention } from '../types';

/**
 * "Dal post": the original post(s) a found song, film, note or piece of software came from. Five songs extracted from
 * the same post show the same link (spec 2026-11-08-no-duplicates-and-post-links, D3). Renders nothing when no
 * mention has a post address (an older backend, or a thing that was not found in a post).
 */
export function PostLinks({ mentions }: { mentions: Array<Pick<SongMention, 'sourceUrl' | 'sourcePlatform'>> | undefined }) {
  const { t } = useLanguage();
  const { links, more } = postLinksOf(mentions);
  if (links.length === 0) return null;
  return (
    <div className="post-links" data-testid="post-links">
      <span>{t.fromPost}</span>
      {links.map((link) => (
        <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
          {link.label}
        </a>
      ))}
      {more > 0 && <span className="post-links-more">+{more}</span>}
    </div>
  );
}
