/**
 * The reels of Mondrop (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md §4, contract docs/mondrop-reels.md): the list of the posts SoundReel has analysed
 * for the person — of each, what it says and what it holds by category — the page of one, and its picture. The SERVER decomposes and explains (rule P: the app draws), reads
 * only what the analysis already saved (no model, no external call, nothing queued) and never says the address of a post.
 *
 * The music of a post is the music of Mondrop: the songs the journal of the person knows by the key of the post's words, built by the library (`buildTracks`) like every
 * track, so they are played, downloaded and put in playlists like any song. A failure of a part (the facets, the music) costs only that part.
 */
import { logError } from '../utils/logger';
import { getUserSongs } from './userSongs';
import { buildTracks, type OfflineTrack } from './offlineManifest';
import {
  REEL_KINDS,
  REEL_KIND_LABEL,
  buildReelCard,
  buildReelDetail,
  reelSongs,
  type ReelCard,
  type ReelDetail,
  type ReelKind,
  type ReelRow,
} from './reelBreakdown';
import { getReelRow, listReelRows, reelKindCounts, resolveReelImage, type ReelImage } from './reelBreakdownData';
import type { AggregatedSong } from '../types';

export const REELS_DEFAULT_LIMIT = 20;
export const REELS_MAX_LIMIT = 50;
/** More than the posts of a library will ever be; a number that does not fit a page of the database is a wrong one. */
const MAX_OFFSET = 1_000_000;

// ---------- the parameters of the list ----------

export interface ReelsQuery {
  limit: number;
  offset: number;
  kind: ReelKind | undefined;
  facets: boolean;
}

export type ReelsQueryField = 'limit' | 'offset' | 'kind' | 'facets';
export type ParsedReelsQuery = { ok: true; query: ReelsQuery } | { ok: false; field: ReelsQueryField };

/** A blank value is no value (an app that builds the address from optional parts); anything else is read as written, without trimming. */
const given = (raw: unknown): raw is string | string[] | object | number | boolean => raw !== undefined && !(typeof raw === 'string' && raw.trim() === '');

/**
 * Reads the query string of `GET /api/mondrop/reels`. A value that is not text (the same name twice arrives as a list), a limit outside 1–50, an offset that is not a whole
 * number from 0, a category that is not one of the ten, a `facets` that is not 1, 0, true or false makes the whole request wrong, and the answer names the first wrong one (in
 * the order limit, offset, kind, facets). The viewer is never a parameter: whatever else is in the query is ignored.
 */
export function parseReelsQuery(raw: Record<string, unknown>): ParsedReelsQuery {
  let limit = REELS_DEFAULT_LIMIT;
  let offset = 0;
  let kind: ReelKind | undefined;
  let facets = false;

  const limitRaw = raw.limit;
  if (given(limitRaw)) {
    if (typeof limitRaw !== 'string' || !/^\d+$/.test(limitRaw)) return { ok: false, field: 'limit' };
    limit = Number(limitRaw);
    if (limit < 1 || limit > REELS_MAX_LIMIT) return { ok: false, field: 'limit' };
  }

  const offsetRaw = raw.offset;
  if (given(offsetRaw)) {
    if (typeof offsetRaw !== 'string' || !/^\d+$/.test(offsetRaw)) return { ok: false, field: 'offset' };
    offset = Number(offsetRaw);
    if (offset > MAX_OFFSET) return { ok: false, field: 'offset' };
  }

  const kindRaw = raw.kind;
  if (given(kindRaw)) {
    const found = typeof kindRaw === 'string' ? REEL_KINDS.find((k) => k === kindRaw) : undefined;
    if (!found) return { ok: false, field: 'kind' };
    kind = found;
  }

  const facetsRaw = raw.facets;
  if (given(facetsRaw)) {
    const word = typeof facetsRaw === 'string' ? facetsRaw.toLowerCase() : '';
    if (word === '1' || word === 'true') facets = true;
    else if (word === '0' || word === 'false') facets = false;
    else return { ok: false, field: 'facets' };
  }

  return { ok: true, query: { limit, offset, kind, facets } };
}

// ---------- what it reads ----------

/** What the reels read, injectable so the rules can be tested without a database, a journal or a disk. */
export interface ReelsDeps {
  rows(userId: string, page: { kind?: ReelKind; limit: number; offset: number }): Promise<{ rows: ReelRow[]; total: number }>;
  kindCounts(userId: string): Promise<Array<{ kind: ReelKind; count: number }>>;
  row(userId: string, id: string): Promise<ReelRow | null>;
  /** The songs of the person's journal, by key (the posts they own and the ones shared with them: not the administrator's view). */
  journal(userId: string): Promise<Map<string, AggregatedSong>>;
  tracks(songs: AggregatedSong[], userId: string): Promise<OfflineTrack[]>;
  image(userId: string, id: string): Promise<ReelImage | null>;
}

export const realReelsDeps: ReelsDeps = {
  rows: (userId, page) => listReelRows(userId, page),
  kindCounts: (userId) => reelKindCounts(userId),
  row: (userId, id) => getReelRow(userId, id),
  journal: (userId) => getUserSongs(userId, false),
  tracks: (songs, userId) => buildTracks(songs, userId),
  image: (userId, id) => resolveReelImage(userId, id),
};

// ---------- the answers ----------

export interface ReelKindFacet {
  kind: ReelKind;
  label: string;
  count: number;
}

export interface ReelsPage {
  total: number;
  limit: number;
  offset: number;
  /** Only when asked (`facets`): how many reels have each category, over all of them. */
  kinds?: ReelKindFacet[];
  reels: ReelCard[];
}

/** A page of the list. The posts failing to be read is a failure (the route says so); the facets failing only leave the facets out. */
export async function listReels(userId: string, query: ReelsQuery, deps: ReelsDeps = realReelsDeps): Promise<ReelsPage> {
  const [page, counts] = await Promise.all([
    deps.rows(userId, { kind: query.kind, limit: query.limit, offset: query.offset }),
    query.facets
      ? deps.kindCounts(userId).catch((err: unknown) => {
        logError('mondrop reels: the categories could not be counted', { err: String(err) });
        return null;
      })
      : Promise.resolve(null),
  ]);
  const reels: ReelCard[] = [];
  for (const row of page.rows) {
    try {
      reels.push(buildReelCard(row));
    } catch (err) {
      // the builder reads damaged JSON as «nothing»: this is a bug, and costs one card, not the page
      logError('mondrop reels: a card could not be built', { id: row.id, err: String(err) });
    }
  }
  return {
    total: page.total,
    limit: query.limit,
    offset: query.offset,
    ...(counts ? { kinds: counts.map((c) => ({ kind: c.kind, label: REEL_KIND_LABEL[c.kind], count: c.count })) } : {}),
    reels,
  };
}

/** The tracks of the music of a reel, in the order of the post: the songs of the post that the journal of the person knows. null when there are none or they cannot be built. */
async function tracksOf(userId: string, row: ReelRow, deps: ReelsDeps): Promise<OfflineTrack[] | null> {
  const wanted = reelSongs(row.results);
  if (wanted.length === 0) return null;
  try {
    const journal = await deps.journal(userId);
    const songs = wanted.map((song) => journal.get(song.key)).filter((song): song is AggregatedSong => song !== undefined);
    if (songs.length === 0) return null;
    return await deps.tracks(songs, userId);
  } catch (err) {
    logError('mondrop reels: the music of a reel could not be built', { id: row.id, err: String(err) });
    return null;
  }
}

/** The page of one reel, or null when it does not exist or the person cannot read it (the route says «not found» either way). */
export async function getReel(userId: string, id: string, deps: ReelsDeps = realReelsDeps): Promise<ReelDetail | null> {
  const row = await deps.row(userId, id);
  if (!row) return null;
  return buildReelDetail(row, await tracksOf(userId, row, deps));
}

/** The file of the picture of a reel, or null (not readable, no picture). */
export function getReelImage(userId: string, id: string, deps: ReelsDeps = realReelsDeps): Promise<ReelImage | null> {
  return deps.image(userId, id);
}
