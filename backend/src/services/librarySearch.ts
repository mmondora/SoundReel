/**
 * One search over everything Michele might have: the songs the app knows (the journal), the whole media server
 * and every local music folder (spec 2026-11-07-library-search-music-folders-design.md, ADR-0011).
 *
 * It returns the INDEX — where each file is — and never serves a file: finding a song does not import it.
 */
import { songKey } from './songMeta';
import { getUserSongs } from './userSongs';
import { getLocalFiles, libraryDisplayRoot } from './musicFolders';
import { getMediaSnapshot } from './musicSnapshot';
import { mediaUrlForVolumePath } from './mediaServer';
import { matchesAll, normalizeSearch, tokenize } from '../utils/searchText';

export type SearchScope = 'all' | 'songs' | 'media' | 'local';
export const SEARCH_SCOPES: readonly SearchScope[] = ['all', 'songs', 'media', 'local'];
export const MAX_RESULTS_PER_SCOPE = 100;

export interface LibraryHit {
  scope: 'songs' | 'media' | 'local';
  artist: string;
  title: string;
  album: string | null;
  /** The media server or the folder the file is in. */
  folder: string;
  /** URL on the media server, or path on disk with its display root; null for a journal song (it has no file of its own here). */
  location: string | null;
  bytes: number | null;
  songKey: string;
  inJournal: boolean;
}

export interface LibrarySearchResult {
  q: string;
  scope: SearchScope;
  /** Matches per scope, before the limit. */
  counts: { songs: number; media: number; local: number };
  results: LibraryHit[];
}

interface Candidate<T> {
  item: T;
  /** 2: the words are in the artist/title; 1: only in the album or the path. */
  score: number;
  sortKey: string;
}

function rank<T>(items: Candidate<T>[], limit: number): { total: number; top: T[] } {
  items.sort((a, b) => b.score - a.score || a.sortKey.localeCompare(b.sortKey));
  return { total: items.length, top: items.slice(0, limit).map((c) => c.item) };
}

const scoreOf = (artist: string, title: string, tokens: string[]): number => (matchesAll(normalizeSearch(`${artist} ${title}`), tokens) ? 2 : 1);
const sortKeyOf = (artist: string, title: string): string => `${artist} ${title}`.toLowerCase();

export async function searchLibrary(params: {
  q: string;
  scope?: SearchScope;
  limit?: number;
  userId: string;
  isAdmin?: boolean;
}): Promise<LibrarySearchResult> {
  const scope = params.scope ?? 'all';
  const limit = Math.min(MAX_RESULTS_PER_SCOPE, Math.max(1, params.limit ?? MAX_RESULTS_PER_SCOPE));
  const tokens = tokenize(params.q);
  const counts = { songs: 0, media: 0, local: 0 };
  const results: LibraryHit[] = [];
  if (tokens.length === 0) return { q: params.q, scope, counts, results };

  const journal = await getUserSongs(params.userId, params.isAdmin ?? false);
  const inJournal = (artist: string, title: string): boolean => journal.has(songKey(artist, title));

  if (scope === 'all' || scope === 'songs') {
    const found: Candidate<LibraryHit>[] = [];
    for (const song of journal.values()) {
      const text = normalizeSearch(`${song.artist} ${song.title} ${song.album ?? ''} ${(song.tags ?? []).join(' ')}`);
      if (!matchesAll(text, tokens)) continue;
      found.push({
        score: scoreOf(song.artist, song.title, tokens),
        sortKey: sortKeyOf(song.artist, song.title),
        item: { scope: 'songs', artist: song.artist, title: song.title, album: song.album, folder: 'Libreria', location: null, bytes: null, songKey: song.songKey, inJournal: true },
      });
    }
    const { total, top } = rank(found, limit);
    counts.songs = total;
    results.push(...top);
  }

  if (scope === 'all' || scope === 'media') {
    const snapshot = await getMediaSnapshot();
    const found: Candidate<LibraryHit>[] = [];
    for (const f of snapshot.files) {
      if (!matchesAll(f.searchText, tokens)) continue;
      found.push({
        score: scoreOf(f.artist, f.title, tokens),
        sortKey: sortKeyOf(f.artist, f.title),
        item: {
          scope: 'media', artist: f.artist, title: f.title, album: f.album, folder: 'Media server',
          location: mediaUrlForVolumePath(f.relPath), bytes: f.bytes, songKey: songKey(f.artist, f.title), inJournal: inJournal(f.artist, f.title),
        },
      });
    }
    const { total, top } = rank(found, limit);
    counts.media = total;
    results.push(...top);
  }

  if (scope === 'all' || scope === 'local') {
    const root = libraryDisplayRoot();
    const found: Candidate<LibraryHit>[] = [];
    for (const f of getLocalFiles()) {
      if (!matchesAll(f.searchText, tokens)) continue;
      found.push({
        score: scoreOf(f.artist, f.title, tokens),
        sortKey: sortKeyOf(f.artist, f.title),
        item: {
          scope: 'local', artist: f.artist, title: f.title, album: f.album, folder: f.folderLabel,
          location: `${f.builtIn ? root : f.folderLabel}/${f.relPath}`, bytes: f.bytes, songKey: songKey(f.artist, f.title), inJournal: inJournal(f.artist, f.title),
        },
      });
    }
    const { total, top } = rank(found, limit);
    counts.local = total;
    results.push(...top);
  }

  return { q: params.q, scope, counts, results };
}
