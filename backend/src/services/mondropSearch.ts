/**
 * `GET /api/mondrop/search` (ADR-0018, spec 2026-11-08-mondrop-search-spotify-style-design.md): one search over everything
 * that can be played, answered by the SERVER so that the app never knows how many stores there are (rule P).
 *
 *   - the user's journal (what came from posts and links),
 *   - geekom's music library,
 *   - the box's catalogue (`media_index`).
 * One row per song KEY (the key of playlists and files; a version such as «(Instrumental)» is its own song): a song found in
 * several places is a single track, and the journal's object wins, it knows more. Word order, case and accents do not
 * count when searching (ADR-0011): «Maestro Bassi» finds «Bassi Maestro». The answer has no field that names a store.
 *
 * Besides the tracks (one page), it counts the artists and albums among ALL matches, so the app can show «Brani, Artisti,
 * Album» like Spotify, and `artist=` / `album=` give the page of one artist or one album.
 */
import type { AggregatedSong } from '../types';
import { normalizeSearch, tokenize, matchesAll } from '../utils/searchText';
import { buildTracks, type OfflineTrack } from './offlineManifest';
import { libraryEntries, songFromEntry } from './libraryOnlySongs';
import { getUserSongs } from './userSongs';

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 200;
const ARTISTS_IN_ANSWER = 6;
const ALBUMS_IN_ANSWER = 6;
const ALBUMS_ON_AN_ARTIST_PAGE = 60;
const MAX_TEXT = 200;

export interface SearchQuery {
  q: string;
  artist: string | null;
  album: string | null;
  limit: number;
  offset: number;
  sections: boolean;
}

export type ParsedQuery = { ok: true; value: SearchQuery } | { ok: false; field: string };

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);

function int(raw: unknown, lo: number, hi: number, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/** The query string of the route. An empty search is refused: it would list the whole music library. */
export function parseSearchQuery(raw: Record<string, unknown>): ParsedQuery {
  const q = text(raw.q) ?? '';
  const artist = text(raw.artist);
  const album = text(raw.album);
  if (!q && !artist && !album) return { ok: false, field: 'q' };
  const limit = int(raw.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  if (limit === null) return { ok: false, field: 'limit' };
  const offset = int(raw.offset, 0, 1_000_000, 0);
  if (offset === null) return { ok: false, field: 'offset' };
  if (raw.sections !== undefined && raw.sections !== '0' && raw.sections !== '1') return { ok: false, field: 'sections' };
  return { ok: true, value: { q, artist, album, limit, offset, sections: raw.sections !== '0' } };
}

/** «Hell Raton, Ensi & Bassi Maestro feat. X» → each credited name, as the app shows it. */
export function creditsOf(artist: string): string[] {
  return artist
    .split(/\s*(?:,|;|&|\bfeat\.?|\bft\.?|\bfeaturing\b|\bvs\.?|\bx\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ArtistHit {
  name: string;
  tracks: number;
}
export interface AlbumHit {
  title: string;
  artist: string;
  tracks: number;
}
export interface SearchAnswer {
  q: string;
  tracks: OfflineTrack[];
  artists: ArtistHit[];
  albums: AlbumHit[];
  total: number;
  offset: number;
  limit: number;
}

interface Candidate {
  song: AggregatedSong;
  artist: string;
  title: string;
  album: string | null;
  /** 2: the words are in the artist or the title; 1: only in the album, the tags or the path. */
  score: number;
  sortKey: string;
}

/** Everything searchable, one candidate per song: the journal's songs, then the files that are not already one of them. */
async function allCandidates(userId: string): Promise<Array<Omit<Candidate, 'score'> & { text: string }>> {
  const journal = [...(await getUserSongs(userId, false)).values()];
  const byKey = new Map<string, Omit<Candidate, 'score'> & { text: string }>();
  for (const s of journal) {
    byKey.set(s.songKey, {
      song: s,
      artist: s.artist,
      title: s.title,
      album: s.album,
      sortKey: `${s.artist} ${s.title}`.toLowerCase(),
      text: normalizeSearch(`${s.artist} ${s.title} ${s.album ?? ''} ${(s.tags ?? []).join(' ')}`),
    });
  }
  for (const e of (await libraryEntries()).all) {
    if (byKey.has(e.songKey)) continue; // the same song as a journal one (same key): one row
    byKey.set(e.songKey, {
      song: songFromEntry(e),
      artist: e.artist,
      title: e.title,
      album: e.album,
      sortKey: `${e.artist} ${e.title}`.toLowerCase(),
      text: normalizeSearch(`${e.artist} ${e.title} ${e.album ?? ''} ${e.local?.relPath ?? e.media?.relPath ?? ''}`),
    });
  }
  return [...byKey.values()];
}

const mostCommon = (counts: Map<string, number>): string => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

export async function searchEverything(query: SearchQuery & { userId: string }): Promise<SearchAnswer> {
  const tokens = tokenize(query.q);
  const wantedArtist = query.artist ? normalizeSearch(query.artist) : null;
  const wantedAlbum = query.album ? normalizeSearch(query.album) : null;

  const matches: Candidate[] = [];
  for (const c of await allCandidates(query.userId)) {
    if (tokens.length > 0 && !matchesAll(c.text, tokens)) continue;
    if (wantedArtist && !creditsOf(c.artist).some((n) => normalizeSearch(n) === wantedArtist)) continue;
    if (wantedAlbum && normalizeSearch(c.album ?? '') !== wantedAlbum) continue;
    const inTitle = tokens.length === 0 || matchesAll(normalizeSearch(`${c.artist} ${c.title}`), tokens);
    matches.push({ ...c, score: inTitle ? 2 : 1 });
  }
  matches.sort((a, b) => b.score - a.score || a.sortKey.localeCompare(b.sortKey));

  const page = matches.slice(query.offset, query.offset + query.limit);
  const tracks = await buildTracks(page.map((c) => c.song), query.userId);

  let artists: ArtistHit[] = [];
  let albums: AlbumHit[] = [];
  if (query.sections) {
    // artists: the credited names that match what was typed (a name is not an artist hit because a song it is not credited on matched)
    if (!wantedArtist && tokens.length > 0) {
      const byName = new Map<string, { spellings: Map<string, number>; tracks: number }>();
      for (const c of matches) {
        for (const name of creditsOf(c.artist)) {
          const n = normalizeSearch(name);
          if (!matchesAll(n, tokens)) continue;
          const slot = byName.get(n) ?? { spellings: new Map<string, number>(), tracks: 0 };
          slot.spellings.set(name, (slot.spellings.get(name) ?? 0) + 1);
          slot.tracks += 1;
          byName.set(n, slot);
        }
      }
      artists = [...byName.values()]
        .map((s) => ({ name: mostCommon(s.spellings), tracks: s.tracks }))
        .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name))
        .slice(0, ARTISTS_IN_ANSWER);
    }
    // albums: where the matching tracks come from, under the first credited artist
    if (!wantedAlbum) {
      const byAlbum = new Map<string, { titles: Map<string, number>; artists: Map<string, number>; tracks: number }>();
      for (const c of matches) {
        if (!c.album) continue;
        const key = normalizeSearch(c.album);
        const slot = byAlbum.get(key) ?? { titles: new Map<string, number>(), artists: new Map<string, number>(), tracks: 0 };
        slot.titles.set(c.album, (slot.titles.get(c.album) ?? 0) + 1);
        const first = creditsOf(c.artist)[0] ?? c.artist;
        slot.artists.set(first, (slot.artists.get(first) ?? 0) + 1);
        slot.tracks += 1;
        byAlbum.set(key, slot);
      }
      albums = [...byAlbum.values()]
        .map((s) => ({ title: mostCommon(s.titles), artist: mostCommon(s.artists), tracks: s.tracks }))
        .sort((a, b) => b.tracks - a.tracks || a.title.localeCompare(b.title))
        .slice(0, wantedArtist ? ALBUMS_ON_AN_ARTIST_PAGE : ALBUMS_IN_ANSWER);
    }
  }

  return { q: query.q, tracks, artists, albums, total: matches.length, offset: query.offset, limit: query.limit };
}
