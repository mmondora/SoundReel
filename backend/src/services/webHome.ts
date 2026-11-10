/**
 * The front page of the SITE, in sections (spec 2026-11-10-web-look-and-feel-rethink-design.md §3.2 L1 «la Home usa le sezioni della C»,
 * plan 2026-11-10-web-look-and-feel.md Task 8, contract docs/web-home.md).
 *
 * The server decides which sections exist, what is in each and in which order (rule P: the site draws what it gets). The ORDER and the
 * VISIBILITY of the sections are the user's configuration (`home.sections` of GET /api/me/prefs): the site draws these sections in that
 * order, skips the ones the configuration hides and the ones it does not know. A section with nothing in it is not sent, and one that
 * fails costs only itself. The collections (ADR-0022) are tiles of the themes and the places the server discovered, in the order of the list
 * of collections; with nothing discovered yet their section is simply absent.
 *
 * Reads only. The viewer is who the route resolved from `Remote-User` (own entries and the ones shared with them; an admin also sees the
 * anonymous ones, exactly like the lists of the site), and the sources below apply that visibility: nothing of another user gets here.
 *
 * The rules are pure (the sources are injected, `services/webHomeData.ts` has the real ones), so they are tested without a database.
 */
import { logWarning } from '../utils/logger';
import type { AggregatedFilm, AggregatedSong, EntrySummaryRow, PlaylistSummary } from '../types';
import { applyPlaylistList, type PlaylistListQuery } from './playlistList';
import { collapseFilms } from './filmCollapse';
import { COLLECTION_VIEW, type CollectionListItem } from './collectionsView';

/** How much each section carries: a front page, not a catalogue (the pages of posts, songs, playlists and films hold the rest). */
export const WEB_HOME_LIMITS = { resume: 6, songs: 12, playlists: 12, collections: COLLECTION_VIEW.homeTiles, films: 12 } as const;

export type WebHomeSectionId = 'resume' | 'songs' | 'playlists' | 'collections' | 'films';

export interface WebHomeSong {
  songKey: string;
  title: string;
  artist: string;
  /** The cover the metadata knows, or null. */
  coverUrl: string | null;
  /** The newest post that names the song, and where that post lives. */
  entryId: string;
  sourceUrl: string | null;
  /** When that newest post was saved. */
  createdAt: string;
}

export interface WebHomePlaylist {
  id: string;
  name: string;
  /** For a rule (`dynamic`): how many songs it selects now. */
  songCount: number;
  createdAt: string;
  kind: 'static' | 'dynamic';
  /** `auto` = made by the server from a post that talks about music (ADR-0023); `user` = made by hand. */
  origin: 'user' | 'auto';
  ruleSummary: string | null;
  /** Whose it is (a list shared with the viewer says so). */
  ownerUser: string;
}

/** A tile of the collections: the line of the list without what only the page of the collection needs (views, heading, parent). */
export interface WebHomeCollection {
  id: string;
  name: string;
  count: number;
  isNew: boolean;
  /** Up to four pictures for the mosaic. */
  thumbs: string[];
}

export interface WebHomeFilm {
  filmKey: string;
  title: string;
  year: string | null;
  posterUrl: string | null;
  imdbUrl: string | null;
  /** The newest post that names the film, and where that post lives. */
  entryId: string;
  sourceUrl: string | null;
  createdAt: string;
}

export type WebHomeSection =
  /** The latest posts, exactly the row of `GET /api/entries?view=summary`. */
  | { id: 'resume'; total: number; items: EntrySummaryRow[] }
  /** New songs of the posts (never a song that exists only as a file), the one of the newest post first. */
  | { id: 'songs'; total: number; items: WebHomeSong[] }
  /** The playlists the viewer reads, the newest created first. */
  | { id: 'playlists'; total: number; items: WebHomePlaylist[] }
  /** The themes and the places discovered in the posts of the viewer (never the types), in the order of the list of collections. */
  | { id: 'collections'; total: number; items: WebHomeCollection[] }
  /** New films of the posts, one card per film (as the Films page collapses them). */
  | { id: 'films'; total: number; items: WebHomeFilm[] };

export interface WebHomeResponse {
  sections: WebHomeSection[];
}

/** Who is looking: what the route resolved from the Authelia headers (the same two values the other lists of the site are asked with). */
export interface WebHomeViewer {
  userId: string;
  isAdmin: boolean;
}

type StoredPlaylist = PlaylistSummary & { ownerUser?: string };

/** What the Home reads, injectable so the rules can be tested without a database. Every source answers for THIS viewer only. */
export interface WebHomeDeps {
  /** The latest `limit` posts, as `GET /api/entries?view=summary` gives them, and how many posts the viewer can read in all. */
  posts(viewer: WebHomeViewer, limit: number): Promise<{ items: EntrySummaryRow[]; total: number }>;
  /** The songs of the posts the viewer can read, one per key, with their mentions and metadata. */
  songs(viewer: WebHomeViewer): Promise<AggregatedSong[]>;
  /** The films of the posts the viewer can read, as aggregated from the posts (NOT yet collapsed: that is a rule of this file). */
  films(viewer: WebHomeViewer): Promise<AggregatedFilm[]>;
  /** Every playlist the viewer can read, as stored (a rule's count is not filled in yet). */
  playlists(viewer: WebHomeViewer): Promise<StoredPlaylist[]>;
  /** The same playlists with the count of what a rule selects now (a rule is evaluated: only ask for the ones that are shown). */
  resolvePlaylists(list: StoredPlaylist[], viewer: WebHomeViewer): Promise<StoredPlaylist[]>;
  /** The collections the viewer sees, as the list of collections gives them (types, themes, places, in that list's order). */
  collections(viewer: WebHomeViewer): Promise<CollectionListItem[]>;
}

interface MentionLike {
  entryId: string;
  createdAt: string;
  sourceUrl?: string | null;
}

/**
 * The post that named a thing last. The latest READABLE date wins, wherever it sits in the list; with no readable date at all the first
 * mention speaks and the thing counts as «long ago» (0), so it goes last. No mention at all: not a thing of the posts, null.
 */
function newestMention<T extends MentionLike>(mentions: readonly T[]): { mention: T; at: number } | null {
  let best: T | null = null;
  let bestAt = 0;
  for (const mention of mentions) {
    const at = Date.parse(mention.createdAt);
    if (Number.isFinite(at) && (best === null || at > bestAt)) {
      best = mention;
      bestAt = at;
    }
  }
  if (best !== null) return { mention: best, at: bestAt };
  return mentions.length > 0 ? { mention: mentions[0], at: 0 } : null;
}

/** Italian collation without case or accents, so the order of two things of the same moment does not depend on the machine. */
const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });

/** The newest first; two of the same moment (the songs of one post) by title, then by key, so the order never wobbles between two requests. */
function byNewest(a: { at: number; title: string; key: string }, b: { at: number; title: string; key: string }): number {
  return b.at - a.at || collator.compare(a.title, b.title) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

async function resumeSection(viewer: WebHomeViewer, deps: WebHomeDeps): Promise<WebHomeSection | null> {
  const { items, total } = await deps.posts(viewer, WEB_HOME_LIMITS.resume);
  if (items.length === 0) return null;
  // the rows go through as they are: the site already has a card for them
  return { id: 'resume', total, items: items.slice(0, WEB_HOME_LIMITS.resume) };
}

async function songsSection(viewer: WebHomeViewer, deps: WebHomeDeps): Promise<WebHomeSection | null> {
  const seen = new Set<string>();
  const found: Array<{ song: AggregatedSong; mention: AggregatedSong['mentions'][number]; at: number }> = [];
  for (const song of await deps.songs(viewer)) {
    // the new songs of the POSTS: a song that exists only as a file is not one of them
    if (song.libraryOnly || seen.has(song.songKey)) continue;
    const newest = newestMention(song.mentions);
    if (!newest) continue;
    seen.add(song.songKey);
    found.push({ song, ...newest });
  }
  if (found.length === 0) return null;
  const items = found
    .sort((a, b) => byNewest({ at: a.at, title: a.song.title, key: a.song.songKey }, { at: b.at, title: b.song.title, key: b.song.songKey }))
    .slice(0, WEB_HOME_LIMITS.songs)
    .map(({ song, mention }): WebHomeSong => ({
      songKey: song.songKey,
      title: song.title,
      artist: song.artist,
      coverUrl: song.meta?.coverUrl ?? null,
      entryId: mention.entryId,
      sourceUrl: mention.sourceUrl ?? null,
      createdAt: mention.createdAt,
    }));
  return { id: 'songs', total: found.length, items };
}

/** `ListablePlaylist` already knows how to order by creation (newest first, a tie by name): the same rule as the list of playlists. */
const NEWEST_PLAYLISTS: PlaylistListQuery = {
  words: [], filter: 'all', sort: 'created', order: 'desc', limit: WEB_HOME_LIMITS.playlists, offset: 0, legacy: false,
};

async function playlistsSection(viewer: WebHomeViewer, deps: WebHomeDeps): Promise<WebHomeSection | null> {
  const all = await deps.playlists(viewer);
  if (all.length === 0) return null;
  const { items: newest } = applyPlaylistList(all, NEWEST_PLAYLISTS, viewer.userId);
  // a rule is evaluated to count its songs: only the ones that are shown
  const shown = await deps.resolvePlaylists(newest, viewer);
  return {
    id: 'playlists',
    total: all.length,
    items: shown.map((p): WebHomePlaylist => ({
      id: p.id,
      name: p.name,
      songCount: p.songCount,
      createdAt: p.createdAt,
      kind: p.kind === 'dynamic' ? 'dynamic' : 'static',
      origin: p.origin === 'auto' ? 'auto' : 'user',
      ruleSummary: p.ruleSummary ?? null,
      ownerUser: p.ownerUser ?? '',
    })),
  };
}

async function collectionsSection(viewer: WebHomeViewer, deps: WebHomeDeps): Promise<WebHomeSection | null> {
  // the tiles are what was DISCOVERED (themes and places); the types are always there and have their own page
  const discovered = (await deps.collections(viewer)).filter((c) => c.kind !== 'type');
  if (discovered.length === 0) return null;
  return {
    id: 'collections',
    total: discovered.length,
    items: discovered.slice(0, WEB_HOME_LIMITS.collections).map((c): WebHomeCollection => ({ id: c.id, name: c.name, count: c.count, isNew: c.isNew, thumbs: c.thumbs })),
  };
}

async function filmsSection(viewer: WebHomeViewer, deps: WebHomeDeps): Promise<WebHomeSection | null> {
  // one card per film, as the Films page has it («Dune» and «Dune (2021)» are one; two years stay two films)
  const found: Array<{ film: AggregatedFilm; mention: AggregatedFilm['mentions'][number]; at: number }> = [];
  for (const film of collapseFilms(await deps.films(viewer))) {
    const newest = newestMention(film.mentions);
    if (newest) found.push({ film, ...newest });
  }
  if (found.length === 0) return null;
  const items = found
    .sort((a, b) => byNewest({ at: a.at, title: a.film.title, key: a.film.filmKey }, { at: b.at, title: b.film.title, key: b.film.filmKey }))
    .slice(0, WEB_HOME_LIMITS.films)
    .map(({ film, mention }): WebHomeFilm => {
      // the year may be stored as a number: the site always gets text, or null
      const year = film.year == null ? '' : String(film.year).trim();
      return {
        filmKey: film.filmKey,
        title: film.title,
        year: year === '' ? null : year,
        posterUrl: film.posterUrl ?? null,
        imdbUrl: film.imdbUrl ?? null,
        entryId: mention.entryId,
        sourceUrl: mention.sourceUrl ?? null,
        createdAt: mention.createdAt,
      };
    });
  return { id: 'films', total: found.length, items };
}

/** A section that fails is left out and written in the log; the others are still answered. */
async function guarded(id: WebHomeSectionId, build: () => Promise<WebHomeSection | null>): Promise<WebHomeSection | null> {
  try {
    return await build();
  } catch (err) {
    logWarning(`web home: section ${id} failed (the other sections were answered)`, { section: id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The sections of the front page for this viewer: posts, songs, playlists, collections, films, in that order, the empty and the failed left out. */
export async function buildWebHome(viewer: WebHomeViewer, deps: WebHomeDeps): Promise<WebHomeResponse> {
  const built = await Promise.all([
    guarded('resume', () => resumeSection(viewer, deps)),
    guarded('songs', () => songsSection(viewer, deps)),
    guarded('playlists', () => playlistsSection(viewer, deps)),
    guarded('collections', () => collectionsSection(viewer, deps)),
    guarded('films', () => filmsSection(viewer, deps)),
  ]);
  return { sections: built.filter((section): section is WebHomeSection => section !== null) };
}
