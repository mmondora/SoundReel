import type { CollectionChip, Entry, EntrySummary, SearchResult } from '../../types';
import { isPlaceholderTag } from '../CollectionChips';

// One model for the card of a post, whatever list it comes from (the journal, the list of summaries, a search): the wall and the Home draw only
// this. The wall puts the media of the post in view (the first songs and films); a list that carries only counts shows the counts.

export interface PostCardModel {
  id: string;
  /** `sourcePlatform` (instagram, tiktok…): the card writes its short label. */
  platform: string;
  /** ISO date, or null when the row has none that can be read. */
  createdAt: string | null;
  thumbnailUrl: string | null;
  summary: string;
  status: string;
  /** The first songs and films of the post, in view (empty when the list carries only counts). */
  songs: Array<{ title: string; artist: string }>;
  films: Array<{ title: string; year: string | null }>;
  songCount: number;
  filmCount: number;
  noteCount: number;
  tags: string[];
  /** The collections the post is in, as the server chose them (the summaries carry them; the full journal does not). */
  collections: CollectionChip[];
}

export const SONGS_IN_VIEW = 3;
export const FILMS_IN_VIEW = 2;
export const TAGS_IN_VIEW = 4;
export const SUMMARY_MAX = 140;

/** An ISO date from what the database sends (an ISO string, or the old `{ _seconds }`), or null. */
function toIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'object') {
    const ts = value as Record<string, unknown>;
    const seconds = ts._seconds ?? ts.seconds;
    return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/** The first text that says something: the summary, else the caption, else the link; never longer than `SUMMARY_MAX`. */
function summaryOf(summary: string | null | undefined, caption: string | null | undefined, url: string): string {
  const text = [summary, caption, url].map((s) => (typeof s === 'string' ? s.trim() : '')).find((s) => s !== '') ?? '';
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX).trimEnd()}…`;
}

function tagsOf(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '' && !isPlaceholderTag(tag)).slice(0, TAGS_IN_VIEW);
}

export function postFromEntry(entry: Entry): PostCardModel {
  const results: Partial<Entry['results']> = entry.results ?? {};
  const songs = results.songs ?? [];
  const films = results.films ?? [];
  return {
    id: entry.id,
    platform: entry.sourcePlatform,
    createdAt: toIso(entry.createdAt),
    thumbnailUrl: entry.thumbnailUrl ?? null,
    summary: summaryOf(results.summary, entry.caption, entry.sourceUrl),
    status: entry.status,
    songs: songs.slice(0, SONGS_IN_VIEW).map((s) => ({ title: s.title, artist: s.artist })),
    films: films.slice(0, FILMS_IN_VIEW).map((f) => ({ title: f.title, year: f.year ?? null })),
    songCount: songs.length,
    filmCount: films.length,
    noteCount: (results.notes ?? []).length,
    tags: tagsOf(results.tags),
    collections: [],
  };
}

export function postFromSummary(row: EntrySummary): PostCardModel {
  return {
    id: row.id,
    platform: row.sourcePlatform,
    createdAt: toIso(row.createdAt),
    thumbnailUrl: row.thumbnailUrl ?? null,
    summary: summaryOf(row.summary, row.caption, row.sourceUrl),
    status: row.status,
    songs: [],
    films: [],
    songCount: row.songCount,
    filmCount: row.filmCount,
    noteCount: row.noteCount,
    tags: tagsOf(row.tags),
    collections: row.collections ?? [],
  };
}

export function postFromSearch(result: SearchResult): PostCardModel {
  const { songs, films, notes, tags, summary } = result.results;
  return {
    id: result.id,
    platform: result.sourcePlatform,
    createdAt: toIso(result.createdAt),
    thumbnailUrl: result.thumbnailUrl ?? null,
    summary: summaryOf(summary, result.caption, result.sourceUrl),
    status: 'completed',
    songs: songs.slice(0, SONGS_IN_VIEW).map((s) => ({ title: s.title, artist: s.artist })),
    films: films.slice(0, FILMS_IN_VIEW).map((f) => ({ title: f.title, year: null })),
    songCount: songs.length,
    filmCount: films.length,
    noteCount: notes.length,
    tags: tagsOf(tags),
    collections: [],
  };
}
