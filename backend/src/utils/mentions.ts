/**
 * A mention is one entry that names a thing (a song, a film, a note, a piece of software). Every card of the media found
 * links back to the post the thing was extracted from (spec 2026-11-08-no-duplicates-and-post-links, D3), so a mention
 * carries the post's own URL and platform, not just the entry id.
 */
import type { Entry } from '../types';

export interface PostMention {
  entryId: string;
  createdAt: string;
  /** The original post (Instagram, TikTok, YouTube…): where the thing was found. */
  sourceUrl: string | null;
  sourcePlatform: string | null;
}

/**
 * The address of a post as the card shows it. A stored address can carry a stray character in front (one entry of the
 * real journal is `xhttps://www.instagram.com/…`, a web paste typo): up to four characters before `http(s)://` are
 * dropped so the link still opens the post. The stored value is not touched.
 */
export function postUrlOf(raw: string | null | undefined): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  const at = text.search(/https?:\/\//i);
  return at > 0 && at <= 4 ? text.slice(at) : text;
}

export function mentionOf(entry: Pick<Entry, 'id' | 'createdAt' | 'sourceUrl' | 'sourcePlatform'>): PostMention {
  return {
    entryId: entry.id,
    createdAt: String(entry.createdAt ?? ''),
    sourceUrl: postUrlOf(entry.sourceUrl),
    sourcePlatform: typeof entry.sourcePlatform === 'string' && entry.sourcePlatform ? entry.sourcePlatform : null,
  };
}

/** One mention per entry: an entry that names the same thing twice (two sources, two slides) counts once. */
export function addMention<T extends { entryId: string }>(mentions: T[], mention: T): void {
  if (!mentions.some((m) => m.entryId === mention.entryId)) mentions.push(mention);
}
