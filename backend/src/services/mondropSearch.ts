/**
 * `GET /api/mondrop/search` (ADR-0018, spec 2026-11-08-mondrop-search-spotify-style-design.md): one search over everything
 * that can be played, answered by the SERVER so that the app never knows how many stores there are (rule P).
 *
 *   - the user's journal (what came from posts and links),
 *   - geekom's music library,
 *   - the box's catalogue (`media_index`).
 * One row per SONG, not per file: the same recording is often there two or three times with different spellings (the
 * box's original has the album tag and plain «Bassi Maestro», the Mac import says «Bassi Maestro feat. Ape & Zampa», the
 * copy made from a file name says «Bassi Maestro, Ape, Zampa», «S.I.C» and «S.I.C.», «King's» and «King’s»). Entries are
 * GROUPED when they have the same title (case, accents and punctuation aside, a «(feat. X)» suffix aside) and at least one
 * credited artist in common. A version («(2019 Remastered)», «(Instrumental)») has another title, so it stays its own song.
 * The identity of an entry is still its song KEY (playlists, files, metadata, plays): grouping is only how the SEARCH shows
 * it. The group is shown as ONE entry, always the same one for a given group (so «already on the phone» does not change with
 * the words typed): the journal's if it has one (it knows more), else one that has a file on geekom's disk, else the box's.
 * Word order, case and accents do not count when searching (ADR-0011): «Maestro Bassi» finds «Bassi Maestro». The answer has
 * no field that names a store.
 *
 * Besides the tracks (one page), it counts the artists and albums among ALL matches, so the app can show «Brani, Artisti,
 * Album» like Spotify, and `artist=` / `album=` give the page of one artist or one album.
 */
import type { AggregatedSong } from '../types';
import { creditsOf } from '../utils/credits';
import { normalizeSearch, tokenize, matchesAll } from '../utils/searchText';
import { buildTracks, type OfflineTrack } from './offlineManifest';
import { libraryEntries, songFromEntry, type LibraryEntry } from './libraryOnlySongs';
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

export { creditsOf };

/** «Nightcall (feat. Lovefoxxx)» is the recording «Nightcall»: a credit written into the title is not a version. */
const FEAT_IN_TITLE = /\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/gi;

/**
 * What two entries must have in common to be the same recording: the title without case, accents, punctuation, spaces and
 * a «(feat. X)» suffix («S.I.C» = «S.I.C.», «King's» = «King’s»). A version label stays in it, so a version is another song.
 */
export function titleKeyOf(title: string): string {
  return normalizeSearch(title.replace(FEAT_IN_TITLE, '')).replace(/ /g, '');
}

/** Credits that name nobody: they must never make two songs «the same artist's». */
const NOBODY = new Set(['various artists', 'various', 'va', 'artisti vari', 'unknown artist', 'unknown', 'sconosciuto', 'n a']);

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

// ---------------------------------------------------------------------------
// Members (what can be found) and groups (the same recording found more than once)
// ---------------------------------------------------------------------------

interface Credit {
  /** `normalizeSearch(name)`: what two spellings of one name have in common. */
  key: string;
  name: string;
}

interface Derived {
  /** Everything a search can hit: names, album, tags (journal) or the folders of the file (library). */
  text: string;
  /** Artist and title only: a hit here ranks above a hit in the album, the tags or the path. */
  nameText: string;
  titleKey: string;
  credits: Credit[];
}

interface Member {
  artist: string;
  title: string;
  /** The album as the app shows it. */
  album: string | null;
  /** An album that comes from real tags (the box's, or the journal's own), as opposed to a folder name. */
  tagAlbum: string | null;
  journal: boolean;
  /** A file on geekom's disk. */
  hasLocal: boolean;
  derived: Derived;
  sortKey: string;
  make: () => AggregatedSong;
}

const derivedOf = new WeakMap<object, Derived>();

function derive(owner: object, artist: string, title: string, extra: string): Derived {
  const known = derivedOf.get(owner);
  if (known) return known;
  const seen = new Set<string>();
  const credits: Credit[] = [];
  for (const name of creditsOf(artist)) {
    const key = normalizeSearch(name);
    if (!key || NOBODY.has(key) || seen.has(key)) continue;
    seen.add(key);
    credits.push({ key, name });
  }
  const d: Derived = {
    text: normalizeSearch(`${artist} ${title} ${extra}`),
    nameText: normalizeSearch(`${artist} ${title}`),
    titleKey: titleKeyOf(title),
    credits,
  };
  derivedOf.set(owner, d);
  return d;
}

/** The folders of a file, without the roots every file shares («Music», «SoundReel», «_MacMusic») and the extension. */
const SHARED_FOLDERS = new Set(['music', 'soundreel', '_macmusic']);
const pathWords = (relPath: string | undefined): string =>
  (relPath ?? '')
    .replace(/\.[A-Za-z0-9]{2,4}$/, '')
    .split('/')
    .filter((seg) => seg && !SHARED_FOLDERS.has(seg.toLowerCase()))
    .join(' ');

function memberOfSong(s: AggregatedSong): Member {
  return {
    artist: s.artist,
    title: s.title,
    album: s.album,
    tagAlbum: s.album,
    journal: true,
    hasLocal: s.fs === true,
    derived: derive(s, s.artist, s.title, `${s.album ?? ''} ${(s.tags ?? []).join(' ')}`),
    sortKey: `${s.artist} ${s.title}`.toLowerCase(),
    make: () => s,
  };
}

function memberOfEntry(e: LibraryEntry): Member {
  return {
    artist: e.artist,
    title: e.title,
    album: e.album,
    tagAlbum: e.media?.album || null,
    journal: false,
    hasLocal: e.local !== null,
    derived: derive(e, e.artist, e.title, `${e.album ?? ''} ${pathWords(e.local?.relPath)} ${pathWords(e.media?.relPath)}`),
    sortKey: `${e.artist} ${e.title}`.toLowerCase(),
    make: () => songFromEntry(e),
  };
}

/** One member per song KEY: the given journal songs, then the files that are not already one of them. */
async function membersOf(journal: Iterable<AggregatedSong>): Promise<Member[]> {
  const byKey = new Map<string, Member>();
  for (const s of journal) byKey.set(s.songKey, memberOfSong(s));
  for (const e of (await libraryEntries()).all) {
    if (!byKey.has(e.songKey)) byKey.set(e.songKey, memberOfEntry(e)); // same key as a journal song: one entry
  }
  return [...byKey.values()];
}

/** Everything searchable: the user's journal and the files. */
async function allMembers(userId: string): Promise<Member[]> {
  return membersOf((await getUserSongs(userId, false)).values());
}

interface Group {
  /** The one shown, always the same for a group: journal, then a file on geekom's disk, then the fullest credit. */
  rep: Member;
  members: Member[];
  text: string;
  nameText: string;
  credits: Map<string, string[]>;
}

const rank = (m: Member): number => (m.journal ? 0 : m.hasLocal ? 1 : 2);

function groupMembers(members: Member[]): Group[] {
  const parent = members.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    for (let cur = i; parent[cur] !== root; ) {
      const next = parent[cur];
      parent[cur] = root; // path compression
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const byTitle = new Map<string, number[]>();
  members.forEach((m, i) => {
    if (!m.derived.titleKey) return; // a title with no letters or digits is never «the same» as another
    const list = byTitle.get(m.derived.titleKey);
    if (list) list.push(i);
    else byTitle.set(m.derived.titleKey, [i]);
  });
  for (const idx of byTitle.values()) {
    if (idx.length < 2) continue;
    const firstWith = new Map<string, number>();
    for (const i of idx) {
      for (const c of members[i].derived.credits) {
        const other = firstWith.get(c.key);
        if (other === undefined) firstWith.set(c.key, i);
        else union(other, i);
      }
    }
  }

  const byRoot = new Map<number, Member[]>();
  members.forEach((m, i) => {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(m);
    else byRoot.set(r, [m]);
  });

  const groups: Group[] = [];
  for (const list of byRoot.values()) {
    list.sort((a, b) => rank(a) - rank(b) || b.derived.credits.length - a.derived.credits.length || a.sortKey.localeCompare(b.sortKey));
    const credits = new Map<string, string[]>();
    for (const m of list) {
      for (const c of m.derived.credits) {
        const spellings = credits.get(c.key);
        if (spellings) spellings.push(c.name);
        else credits.set(c.key, [c.name]);
      }
    }
    groups.push({
      rep: list[0],
      members: list,
      text: list.length === 1 ? list[0].derived.text : list.map((m) => m.derived.text).join(' '),
      nameText: list.length === 1 ? list[0].derived.nameText : list.map((m) => m.derived.nameText).join(' '),
      credits,
    });
  }
  return groups;
}

/** The album a group is shown under: the member's own for the album page, else the journal's, else the best real tag. */
function albumShown(g: Group, onAlbum: Member | null): string | null {
  if (onAlbum) return onAlbum.album;
  if (g.rep.journal) return g.rep.album;
  return g.members.find((m) => m.tagAlbum)?.tagAlbum ?? g.rep.album;
}

const mostCommon = (counts: Map<string, number>): string => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

/**
 * The songs that exist ONLY as files (geekom's library, the box), one per song as «Cerca» groups them: what the web's playlist
 * manager adds to the journal's list so that its search takes from EVERYTHING (spec 2026-11-08-playlist-search-everything-design.md).
 * `journal` is the list the web shows: a file of a song that is already in it is never a second row, neither by key nor
 * because it is the same recording under another spelling (the group is shown as the journal's song). Sorted by artist, title.
 */
export async function songsOnlyAsFiles(journal: Iterable<AggregatedSong>): Promise<AggregatedSong[]> {
  const out: Array<{ sortKey: string; song: AggregatedSong }> = [];
  for (const g of groupMembers(await membersOf(journal))) {
    if (g.rep.journal) continue; // the journal's song is already in the list
    const song = g.rep.make();
    const album = albumShown(g, null);
    // empty facets, not absent ones: a client that finds none on a song goes and derives them from the whole journal
    out.push({ sortKey: g.rep.sortKey, song: { ...song, album, sources: [], platforms: [], tags: [] } });
  }
  return out.sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map((x) => x.song);
}

interface Match {
  group: Group;
  /** The member whose album is the one asked for (album page): its file is the one shown. */
  onAlbum: Member | null;
  /** 2: the words are in the artist or the title; 1: only in the album, the tags or the path. */
  score: number;
}

export async function searchEverything(query: SearchQuery & { userId: string }): Promise<SearchAnswer> {
  const tokens = tokenize(query.q);
  const wantedArtist = query.artist ? normalizeSearch(query.artist) : null;
  const wantedAlbum = query.album ? normalizeSearch(query.album) : null;

  const matches: Match[] = [];
  for (const g of groupMembers(await allMembers(query.userId))) {
    if (tokens.length > 0 && !matchesAll(g.text, tokens)) continue;
    if (wantedArtist && !g.credits.has(wantedArtist)) continue;
    const onAlbum = wantedAlbum ? g.members.find((m) => m.album && normalizeSearch(m.album) === wantedAlbum) ?? null : null;
    if (wantedAlbum && !onAlbum) continue;
    matches.push({ group: g, onAlbum, score: tokens.length === 0 || matchesAll(g.nameText, tokens) ? 2 : 1 });
  }
  matches.sort((a, b) => b.score - a.score || a.group.rep.sortKey.localeCompare(b.group.rep.sortKey));

  const page = matches.slice(query.offset, query.offset + query.limit);
  const tracks = await buildTracks(
    page.map((m) => {
      const song = (m.onAlbum ?? m.group.rep).make();
      const album = albumShown(m.group, m.onAlbum);
      return album === song.album ? song : { ...song, album };
    }),
    query.userId,
  );

  let artists: ArtistHit[] = [];
  let albums: AlbumHit[] = [];
  if (query.sections) {
    // artists: the credited names that match what was typed (a name is not an artist hit because a song it is not credited on
    // matched); a song counts once for a name, however many files it has
    if (!wantedArtist && tokens.length > 0) {
      const byName = new Map<string, { spellings: Map<string, number>; tracks: number }>();
      for (const { group } of matches) {
        for (const [key, names] of group.credits) {
          if (!matchesAll(key, tokens)) continue;
          const slot = byName.get(key) ?? { spellings: new Map<string, number>(), tracks: 0 };
          for (const n of names) slot.spellings.set(n, (slot.spellings.get(n) ?? 0) + 1);
          slot.tracks += 1;
          byName.set(key, slot);
        }
      }
      artists = [...byName.values()]
        .map((s) => ({ name: mostCommon(s.spellings), tracks: s.tracks }))
        .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name))
        .slice(0, ARTISTS_IN_ANSWER);
    }
    // albums: where the matching songs come from (one album per song), under the first credited artist of the one shown
    if (!wantedAlbum) {
      const byAlbum = new Map<string, { titles: Map<string, number>; artists: Map<string, number>; tracks: number }>();
      for (const { group } of matches) {
        const album = albumShown(group, null);
        if (!album) continue;
        const key = normalizeSearch(album);
        if (!key) continue;
        const slot = byAlbum.get(key) ?? { titles: new Map<string, number>(), artists: new Map<string, number>(), tracks: 0 };
        slot.titles.set(album, (slot.titles.get(album) ?? 0) + 1);
        const first = creditsOf(group.rep.artist)[0] ?? group.rep.artist;
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
