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

export function mentionOf(entry: Pick<Entry, 'id' | 'createdAt' | 'sourceUrl' | 'sourcePlatform'>): PostMention {
  return {
    entryId: entry.id,
    createdAt: String(entry.createdAt ?? ''),
    sourceUrl: typeof entry.sourceUrl === 'string' && entry.sourceUrl.trim() ? entry.sourceUrl.trim() : null,
    sourcePlatform: typeof entry.sourcePlatform === 'string' && entry.sourcePlatform ? entry.sourcePlatform : null,
  };
}

/** One mention per entry: an entry that names the same thing twice (two sources, two slides) counts once. */
export function addMention<T extends { entryId: string }>(mentions: T[], mention: T): void {
  if (!mentions.some((m) => m.entryId === mention.entryId)) mentions.push(mention);
}
