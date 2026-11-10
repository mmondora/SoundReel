/**
 * The playlists the server makes from the posts that talk about music (ADR-0023, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A).
 * Michele, 10 November: «se il reeel/post parla di musiche ( ecco le 5 musiche di natale ) mi venga creata una "playlist con il titolo
 * adeguato" e le 5 musiche dentro. se il titolo è generico ( ecco gli album jaaz da ascoltare ... ) la play list è "jazz da ascoltare" e deve
 * essere una sola. in tal caso le musiche sono ordinate per data di inserimento, le ultime per prime».
 *
 * The rules live HERE and are pure: the database, the local model and the inbox come in through `AutoPlaylistDeps`, so every rule is tested
 * without them (and the preview of the script runs the same code on a store that is only in memory).
 */
import { randomUUID } from 'node:crypto';
import type { Entry } from '../types';
import { songKey } from './songMeta';
import { themeKey, titleOverlap, type PlaylistKind, type TitlePlan, type TitleSource } from './autoPlaylistTitle';
import type { DynamicRule } from './dynamicRules';
import { GENRE_PLAYLIST_LIMIT, genreRule, genreThemeKey, genresOfThemeTitle } from './genreThemes';

/**
 * A post that LISTS music names at least this many songs from its content: a playlist of its own when the title is precise, or a theme when it
 * is generic. A post with fewer (one song named in the text, or the track recognised from the audio) can only feed a THEME, and only when it is
 * really about music (Michele, 10 November: «vorrei di tutti i post non solo di 42 già salvati»).
 */
export const MIN_SONGS = 2;
/**
 * A playlist has at least this many songs: an automatic one is BORN only when it has them (a theme that has one song waits for the second; the
 * playlist of a genre waits until the library has two songs with the tag). Michele, 10 November: «le playlist non possono essere di una sola
 * canzone - vanno smontate, si chiamano "play list"». Playlists made by hand are not touched by this.
 */
export const MIN_PLAYLIST_SONGS = 2;
/** A song whose source is the CONTENT of the post. `audio_fingerprint` is the background track of any reel, and a Spotify or Shazam link has its own path. */
export const CONTENT_SONG_SOURCES: ReadonlySet<string> = new Set(['ai_analysis', 'both', 'music_list']);
/** Two titles that share this much of their words are one theme (the model had no chance to pick it by name). */
export const THEME_OVERLAP = 0.75;

export interface ThemeRow {
  themeKey: string;
  title: string;
  /** null = the user DELETED the playlist: the theme is not made again. */
  playlistId: string | null;
}

export interface RunRow {
  /** `waiting`: the post belongs to a theme that has no playlist yet because it has fewer than two songs; it is looked at again later. */
  status: 'done' | 'skipped' | 'pending' | 'waiting';
  playlistId: string | null;
  reason: string | null;
  /** Only for `waiting`: the theme the post waits on (`ThemeRow.themeKey`, or the key of a genre). */
  themeKey?: string | null;
}

export interface NewAutoPlaylist {
  owner: string;
  name: string;
  kind: PlaylistKind;
  themeKey: string | null;
  /** The post that made it; null for a playlist of a genre made by the daily sweep (no post is involved). */
  sourceEntryId: string | null;
  createdAt: Date;
  /** Set for the playlist of a GENRE: it is DYNAMIC (this rule, evaluated at read time) and has no songs of its own. */
  rule?: DynamicRule;
}

/** What the rules need to remember. The database has the real one (unique indexes included); a Map has the one of the tests and of the preview. */
export interface AutoPlaylistStore {
  getRun(entryId: string, owner: string): Promise<RunRow | null>;
  saveRun(entryId: string, owner: string, run: RunRow): Promise<void>;
  listThemes(owner: string): Promise<ThemeRow[]>;
  /** Makes the playlist (and, for a theme, registers the theme). `created: false` = it was already there (one per post, one per theme). */
  createPlaylist(input: NewAutoPlaylist): Promise<{ id: string; created: boolean }>;
  /** Adds the songs that are not there yet and says how many; `front` puts them BEFORE every song present, in the order given (newest first). */
  addSongs(playlistId: string, songKeys: string[], opts: { front: boolean; addedAt: Date }): Promise<number>;
  /** The posts (entry ids, oldest first) that wait for this theme to have two songs. */
  listWaiting(owner: string, themeKey: string): Promise<string[]>;
}

export interface AutoPlaylistDeps {
  store: AutoPlaylistStore;
  getEntry(id: string): Promise<Entry | null>;
  /** How many songs of the owner's library carry one of these (canonical) genres: the playlist of a genre is born when there are two. */
  countGenreSongs(owner: string, genres: string[]): Promise<number>;
  /** The title and the kind, from the local model; null when there is no good one. */
  title(source: TitleSource): Promise<TitlePlan | null>;
  language(): Promise<'it' | 'en'>;
  /** `entryId` is the post that made the playlist; null for one the daily sweep made (the message is in the Posta without a post, like the one of the backfill). */
  announce(item: { userId: string; title: string; body: string; entryId: string | null }): Promise<void>;
}

export type AutoOutcome =
  | { status: 'skipped'; reason: 'not_music_post' | 'not_about_music' | 'already_done' | 'theme_deleted' | 'no_owner' | 'entry_not_found' }
  | { status: 'pending'; reason: 'no_title' }
  | { status: 'waiting'; reason: 'needs_two_songs' }
  | { status: 'done'; playlistId: string; title: string; kind: PlaylistKind; created: boolean; added: number; mode: PostMode };

export interface ContentSongs {
  keys: string[];
  songs: Array<{ title: string; artist: string }>;
}

/** The songs of a post that come from its CONTENT, once each, in the order the post gives them. */
export function contentSongs(entry: Pick<Entry, 'results'>): ContentSongs {
  const list = Array.isArray(entry.results?.songs) ? entry.results.songs : [];
  const seen = new Set<string>();
  const out: ContentSongs = { keys: [], songs: [] };
  for (const s of list) {
    if (!s || typeof s.title !== 'string' || !s.title.trim()) continue;
    if (!CONTENT_SONG_SOURCES.has(String(s.source))) continue;
    const artist = typeof s.artist === 'string' ? s.artist : '';
    const key = songKey(artist, s.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.keys.push(key);
    out.songs.push({ title: s.title.trim(), artist: artist.trim() });
  }
  return out;
}

export const talksAboutMusic = (entry: Pick<Entry, 'results'>): boolean => contentSongs(entry).keys.length >= MIN_SONGS;

/** `list`: the post names several songs. `single`: it has one (or only a recognised track): it can only feed a theme. */
export type PostMode = 'list' | 'single';

export interface PostSongs extends ContentSongs {
  mode: PostMode;
}

/** Every song with a title, whatever its source, once each, in order. */
export function allSongs(entry: Pick<Entry, 'results'>): ContentSongs {
  const list = Array.isArray(entry.results?.songs) ? entry.results.songs : [];
  const seen = new Set<string>();
  const out: ContentSongs = { keys: [], songs: [] };
  for (const s of list) {
    if (!s || typeof s.title !== 'string' || !s.title.trim()) continue;
    const artist = typeof s.artist === 'string' ? s.artist : '';
    const key = songKey(artist, s.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.keys.push(key);
    out.songs.push({ title: s.title.trim(), artist: artist.trim() });
  }
  return out;
}

/**
 * The songs a post can give to a playlist, and how: a LIST (two or more from the content), or SINGLE (what is left: the song the post names, else
 * the track recognised from the audio). null when the post has no song at all.
 */
export function songsFor(entry: Pick<Entry, 'results'>): PostSongs | null {
  const content = contentSongs(entry);
  if (content.keys.length >= MIN_SONGS) return { mode: 'list', ...content };
  const picked = content.keys.length > 0 ? content : allSongs(entry);
  return picked.keys.length > 0 ? { mode: 'single', ...picked } : null;
}

/** The theme a title belongs to: the one the model named, else the same key, else the same words (nearly). */
export function findTheme(plan: TitlePlan, themes: ThemeRow[]): ThemeRow | null {
  if (plan.existingTheme) {
    const named = themes.find((t) => t.title === plan.existingTheme);
    if (named) return named;
  }
  const key = themeKey(plan.title);
  const same = themes.find((t) => t.themeKey === key);
  if (same) return same;
  let best: ThemeRow | null = null;
  let bestScore = 0;
  for (const t of themes) {
    const score = titleOverlap(plan.title, t.title);
    if (score >= THEME_OVERLAP && score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

const entryDate = (entry: Entry): Date => {
  const d = new Date(entry.createdAt);
  return Number.isFinite(d.getTime()) ? d : new Date();
};

/** What a post is going to give to a playlist, with what the rules below need to make one. */
interface Birth {
  entry: Entry;
  owner: string;
  at: Date;
  keys: string[];
  plan: TitlePlan;
  deps: AutoPlaylistDeps;
}

interface Born {
  playlistId: string;
  created: boolean;
  added: number;
  title: string;
}

/** A theme with no playlist yet and fewer than two songs: the post WAITS (it is looked at again when the theme has more). */
async function wait(b: Birth, key: string): Promise<AutoOutcome> {
  await b.deps.store.saveRun(b.entry.id, b.owner, { status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: key });
  return { status: 'waiting', reason: 'needs_two_songs' };
}

/** The playlist of the theme is born: the posts that waited for it are in it now. */
async function closeWaiting(b: Birth, waitingIds: string[], playlistId: string): Promise<void> {
  for (const id of waitingIds) await b.deps.store.saveRun(id, b.owner, { status: 'done', playlistId, reason: null });
}

/**
 * The playlist of a GENRE is made: DYNAMIC (the rule of the genre, no songs of its own), ONE per owner and set of genres (`theme_key`), registered as a
 * theme so that a deletion by the user is remembered, and the posts that waited for it are done now. The ONE place where it is made: a post of the
 * theme (`bornFromGenre`) and the daily sweep (`ensureGenrePlaylists`, ADR-0024) both come here, so they cannot differ.
 * `sourceEntryId` is the post that made it, null for the sweep; `exceptEntryId` is a waiting post that the caller closes itself.
 */
export async function makeGenrePlaylist(
  store: Pick<AutoPlaylistStore, 'createPlaylist' | 'listWaiting' | 'saveRun'>,
  input: { owner: string; title: string; genres: string[]; key: string; sourceEntryId: string | null; createdAt: Date; exceptEntryId?: string },
): Promise<{ id: string; created: boolean; closed: string[] }> {
  const made = await store.createPlaylist({
    owner: input.owner, name: input.title, kind: 'theme', themeKey: input.key, sourceEntryId: input.sourceEntryId, createdAt: input.createdAt, rule: genreRule(input.genres),
  });
  const closed = (await store.listWaiting(input.owner, input.key)).filter((id) => id !== input.exceptEntryId);
  for (const id of closed) await store.saveRun(id, input.owner, { status: 'done', playlistId: made.id, reason: null });
  return { id: made.id, created: made.created, closed };
}

/**
 * The playlist of a GENRE («Soul da ascoltare») for a post: a RULE, with no songs of its own, born when the library has two songs that carry the tag.
 * Michele, 10 November: «mi aspetto che sia una dinamica deve avere il tag soul la canzone».
 */
async function bornFromGenre(b: Birth, genres: string[], key: string): Promise<Born | null> {
  const matching = await b.deps.countGenreSongs(b.owner, genres);
  if (matching < MIN_PLAYLIST_SONGS) return null;
  const made = await makeGenrePlaylist(b.deps.store, { owner: b.owner, title: b.plan.title, genres, key, sourceEntryId: b.entry.id, createdAt: b.at, exceptEntryId: b.entry.id });
  return { playlistId: made.id, created: made.created, added: made.created ? Math.min(matching, GENRE_PLAYLIST_LIMIT) : 0, title: b.plan.title };
}

/** A theme made of the songs of the posts: born when the posts that wait for it and this one have two DIFFERENT songs between them. */
async function bornFromPosts(b: Birth, key: string): Promise<Born | null> {
  const waiting = (await b.deps.store.listWaiting(b.owner, key)).filter((id) => id !== b.entry.id);
  const contributors: Array<{ id: string; keys: string[]; at: Date }> = [];
  for (const id of waiting) {
    const other = await b.deps.getEntry(id);
    const found = other ? songsFor(other) : null;
    if (other && found) contributors.push({ id, keys: found.keys, at: entryDate(other) });
  }
  contributors.push({ id: b.entry.id, keys: b.keys, at: b.at });
  contributors.sort((x, y) => x.at.getTime() - y.at.getTime());
  if (new Set(contributors.flatMap((c) => c.keys)).size < MIN_PLAYLIST_SONGS) return null;
  const made = await b.deps.store.createPlaylist({ owner: b.owner, name: b.plan.title, kind: 'theme', themeKey: key, sourceEntryId: b.entry.id, createdAt: b.at });
  let added = 0;
  // oldest first, each batch in front of the ones before it: the newest post ends up on top (a theme that another run made a moment ago: all in front)
  let front = !made.created;
  for (const c of contributors) {
    added += await b.deps.store.addSongs(made.id, c.keys, { front, addedAt: c.at });
    front = true;
  }
  await closeWaiting(b, waiting, made.id);
  return { playlistId: made.id, created: made.created, added, title: b.plan.title };
}

/**
 * One post → a playlist, or nothing. Once per entry and user (`runs`); a playlist the user deleted is not made again.
 * A playlist has at least two songs (`MIN_PLAYLIST_SONGS`): a theme that has fewer WAITS for the next post.
 * `announce: false` is for the preview and the backfill (one message at the end, not ninety).
 */
export async function processEntry(
  entryOrId: string | Entry,
  deps: AutoPlaylistDeps,
  opts: { announce?: boolean } = {},
): Promise<AutoOutcome> {
  const entry = typeof entryOrId === 'string' ? await deps.getEntry(entryOrId) : entryOrId;
  if (!entry) return { status: 'skipped', reason: 'entry_not_found' };
  const owner = entry.ownerUser;
  if (!owner || owner === 'anonymous') return { status: 'skipped', reason: 'no_owner' };

  // a post that waits is looked at again (like one without a title): the theme may have more songs now
  const before = await deps.store.getRun(entry.id, owner);
  if (before && before.status !== 'pending' && before.status !== 'waiting') return { status: 'skipped', reason: 'already_done' };

  const found = songsFor(entry);
  if (!found) return { status: 'skipped', reason: 'not_music_post' };
  const { keys, songs, mode } = found;

  const themes = await deps.store.listThemes(owner);
  const plan = await deps.title({
    caption: entry.caption,
    summary: entry.results?.summary ?? null,
    songs,
    themes: themes.filter((t) => t.playlistId !== null).map((t) => t.title),
    language: await deps.language(),
    mode,
  });
  if (!plan) {
    // no good title: nothing is made with a bad one; the entry stays «to do» (the script retries the pending ones)
    await deps.store.saveRun(entry.id, owner, { status: 'pending', playlistId: null, reason: 'no_title' });
    return { status: 'pending', reason: 'no_title' };
  }

  if (!plan.aboutMusic) {
    // the songs are a background track or the titles of films: not a post about music (said once, never asked again)
    await deps.store.saveRun(entry.id, owner, { status: 'skipped', playlistId: null, reason: 'not_about_music' });
    return { status: 'skipped', reason: 'not_about_music' };
  }

  const at = entryDate(entry);
  const birth: Birth = { entry, owner, at, keys, plan, deps };
  let born: Born;

  // one song has no list to be: it only ever feeds a theme, whatever the title step said
  const kind: PlaylistKind = mode === 'single' ? 'theme' : plan.kind;

  if (kind === 'one_off') {
    // a post that lists music has two songs at least (that is what makes it a list): the playlist is born with them
    const made = await deps.store.createPlaylist({ owner, name: plan.title, kind: 'one_off', themeKey: null, sourceEntryId: entry.id, createdAt: at });
    const added = await deps.store.addSongs(made.id, keys, { front: false, addedAt: at });
    born = { playlistId: made.id, created: made.created, added, title: plan.title };
  } else {
    // a theme of a genre is ONE per set of genres («Rap» and «Hip hop» are one); any other theme is found by its title
    const genres = genresOfThemeTitle(plan.title);
    const key = genres ? genreThemeKey(genres) : themeKey(plan.title);
    const known = genres ? themes.find((t) => t.themeKey === key) ?? null : findTheme(plan, themes);
    if (known && known.playlistId === null) {
      await deps.store.saveRun(entry.id, owner, { status: 'skipped', playlistId: null, reason: 'theme_deleted' });
      return { status: 'skipped', reason: 'theme_deleted' };
    }
    if (known && known.playlistId) {
      // the playlist of a genre has no songs of its own (the tag decides what is in): nothing to add and nothing to announce
      const added = genres ? 0 : await deps.store.addSongs(known.playlistId, keys, { front: true, addedAt: at });
      born = { playlistId: known.playlistId, created: false, added, title: known.title };
    } else {
      const fresh = genres ? await bornFromGenre(birth, genres, key) : await bornFromPosts(birth, key);
      if (!fresh) return wait(birth, key);
      born = fresh;
    }
  }

  await deps.store.saveRun(entry.id, owner, { status: 'done', playlistId: born.playlistId, reason: null });

  // a list that feeds a theme says so; one more single song in a theme is not news (a theme that is NEW is)
  if (opts.announce !== false && (born.created || (born.added > 0 && mode === 'list'))) {
    await deps
      .announce({
        userId: owner,
        entryId: entry.id,
        title: born.created ? `Nuova playlist: ${born.title}` : born.title,
        body: born.created
          ? `${born.added} ${born.added === 1 ? 'brano' : 'brani'}`
          : `+${born.added} ${born.added === 1 ? 'brano' : 'brani'}`,
      })
      .catch(() => undefined);
  }
  return { status: 'done', playlistId: born.playlistId, title: born.title, kind, created: born.created, added: born.added, mode };
}

// ---------------------------------------------------------------------------
// A store that lives in memory: the tests, and the preview of the script
// ---------------------------------------------------------------------------

export interface MemoryPlaylist {
  id: string;
  owner: string;
  name: string;
  kind: PlaylistKind;
  themeKey: string | null;
  sourceEntryId: string | null;
  createdAt: Date;
  /** Set for the playlist of a genre: it is dynamic, so `songs` stays empty. */
  rule?: DynamicRule;
  songs: Array<{ key: string; position: number; addedAt: Date }>;
}

export class MemoryAutoPlaylistStore implements AutoPlaylistStore {
  readonly playlists = new Map<string, MemoryPlaylist>();
  readonly themes = new Map<string, ThemeRow & { owner: string }>();
  readonly runs = new Map<string, RunRow>();

  constructor(seed: { themes?: Array<ThemeRow & { owner: string }>; deleted?: string[] } = {}) {
    for (const t of seed.themes ?? []) this.themes.set(`${t.owner}|${t.themeKey}`, t);
  }

  private runKey = (entryId: string, owner: string) => `${entryId}|${owner}`;

  async getRun(entryId: string, owner: string): Promise<RunRow | null> {
    return this.runs.get(this.runKey(entryId, owner)) ?? null;
  }

  async saveRun(entryId: string, owner: string, run: RunRow): Promise<void> {
    this.runs.set(this.runKey(entryId, owner), run);
  }

  async listThemes(owner: string): Promise<ThemeRow[]> {
    return [...this.themes.values()].filter((t) => t.owner === owner).map(({ themeKey: k, title, playlistId }) => ({ themeKey: k, title, playlistId }));
  }

  async createPlaylist(input: NewAutoPlaylist): Promise<{ id: string; created: boolean }> {
    for (const p of this.playlists.values()) {
      if (p.owner !== input.owner) continue;
      if (input.kind === 'theme' && p.themeKey === input.themeKey) return { id: p.id, created: false };
      if (input.kind === 'one_off' && p.kind === 'one_off' && p.sourceEntryId === input.sourceEntryId) return { id: p.id, created: false };
    }
    const id = randomUUID();
    this.playlists.set(id, {
      id, owner: input.owner, name: input.name, kind: input.kind, themeKey: input.themeKey, sourceEntryId: input.sourceEntryId, createdAt: input.createdAt,
      ...(input.rule ? { rule: input.rule } : {}), songs: [],
    });
    if (input.kind === 'theme' && input.themeKey) {
      this.themes.set(`${input.owner}|${input.themeKey}`, { owner: input.owner, themeKey: input.themeKey, title: input.name, playlistId: id });
    }
    return { id, created: true };
  }

  async addSongs(playlistId: string, songKeys: string[], opts: { front: boolean; addedAt: Date }): Promise<number> {
    const playlist = this.playlists.get(playlistId);
    if (!playlist) return 0;
    const present = new Set(playlist.songs.map((s) => s.key));
    const fresh = [...new Set(songKeys)].filter((k) => !present.has(k));
    if (fresh.length === 0) return 0;
    const positions = playlist.songs.map((s) => s.position);
    const base = opts.front ? (positions.length ? Math.min(...positions) : 0) - fresh.length : positions.length ? Math.max(...positions) + 1 : 0;
    fresh.forEach((key, i) => playlist.songs.push({ key, position: base + i, addedAt: opts.addedAt }));
    return fresh.length;
  }

  async listWaiting(owner: string, themeKey: string): Promise<string[]> {
    const out: string[] = [];
    for (const [key, run] of this.runs) {
      const [entryId, who] = key.split('|');
      if (who === owner && run.status === 'waiting' && run.themeKey === themeKey) out.push(entryId);
    }
    return out;
  }

  /** The songs of a playlist in the order they are played. */
  songKeysOf(playlistId: string): string[] {
    const playlist = this.playlists.get(playlistId);
    return playlist ? [...playlist.songs].sort((a, b) => a.position - b.position || a.addedAt.getTime() - b.addedAt.getTime()).map((s) => s.key) : [];
  }

  /** What a user does: the playlist is deleted (the theme stays on the registry, without a playlist). */
  deletePlaylist(playlistId: string): void {
    this.playlists.delete(playlistId);
    for (const t of this.themes.values()) if (t.playlistId === playlistId) t.playlistId = null;
  }
}
