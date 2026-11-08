/**
 * The post(s) a found song, film, note or piece of software was extracted from, for the card's "Dal post" line
 * (spec 2026-11-08-no-duplicates-and-post-links, D3): one link per post, a few at most, then "+N".
 */
import type { SongMention } from '../types';

export interface PostLink {
  url: string;
  /** What the link says: the site and the start of the path, like `instagram.com/reel/DWDZS4Qob0U`. */
  label: string;
  platform: string | null;
}

export interface PostLinks {
  links: PostLink[];
  /** Posts beyond the ones shown. */
  more: number;
}

export const MAX_POST_LINKS = 3;
const LABEL_MAX = 34;

/** `https://www.instagram.com/reel/DWDZS4Qob0U/?igsh=…` → `instagram.com/reel/DWDZS4Qob0U` */
export function postLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const text = `${u.hostname.replace(/^www\./, '')}${path}`;
    return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
  } catch {
    return url.length > LABEL_MAX ? `${url.slice(0, LABEL_MAX - 1)}…` : url;
  }
}

/** Only addresses a browser can open: a stored value is never trusted to be one (no `javascript:`). */
const isHttp = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url.trim());

/** Several mentions of the same post (the same address) make one link; mentions without a post make none. */
export function postLinksOf(
  mentions: Array<Pick<SongMention, 'sourceUrl' | 'sourcePlatform'>> | undefined,
  max: number = MAX_POST_LINKS,
): PostLinks {
  const seen = new Set<string>();
  const all: PostLink[] = [];
  for (const m of mentions ?? []) {
    if (!isHttp(m.sourceUrl)) continue;
    const url = m.sourceUrl.trim();
    const key = url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ url, label: postLabel(url), platform: m.sourcePlatform ?? null });
  }
  return { links: all.slice(0, max), more: Math.max(0, all.length - max) };
}
