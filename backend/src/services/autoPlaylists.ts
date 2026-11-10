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

/** A post talks about music when it names at least this many songs (a single song, or only the background track, makes no playlist). */
export const MIN_SONGS = 2;
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
  status: 'done' | 'skipped' | 'pending';
  playlistId: string | null;
  reason: string | null;
}

export interface NewAutoPlaylist {
  owner: string;
  name: string;
  kind: PlaylistKind;
  themeKey: string | null;
  sourceEntryId: string;
  createdAt: Date;
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
}

export interface AutoPlaylistDeps {
  store: AutoPlaylistStore;
  getEntry(id: string): Promise<Entry | null>;
  /** The title and the kind, from the local model; null when there is no good one. */
  title(source: TitleSource): Promise<TitlePlan | null>;
  language(): Promise<'it' | 'en'>;
  announce(item: { userId: string; title: string; body: string; entryId: string }): Promise<void>;
}

export type AutoOutcome =
  | { status: 'skipped'; reason: 'not_music_post' | 'not_about_music' | 'already_done' | 'theme_deleted' | 'no_owner' | 'entry_not_found' }
  | { status: 'pending'; reason: 'no_title' }
  | { status: 'done'; playlistId: string; title: string; kind: PlaylistKind; created: boolean; added: number };

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

/**
 * One post → a playlist, or nothing. Once per entry and user (`runs`); a playlist the user deleted is not made again.
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

  const before = await deps.store.getRun(entry.id, owner);
  if (before && before.status !== 'pending') return { status: 'skipped', reason: 'already_done' };

  const { keys, songs } = contentSongs(entry);
  if (keys.length < MIN_SONGS) return { status: 'skipped', reason: 'not_music_post' };

  const themes = await deps.store.listThemes(owner);
  const plan = await deps.title({
    caption: entry.caption,
    summary: entry.results?.summary ?? null,
    songs,
    themes: themes.filter((t) => t.playlistId !== null).map((t) => t.title),
    language: await deps.language(),
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
  let playlistId: string;
  let created: boolean;
  let front: boolean;
  let title = plan.title;

  if (plan.kind === 'one_off') {
    const made = await deps.store.createPlaylist({ owner, name: plan.title, kind: 'one_off', themeKey: null, sourceEntryId: entry.id, createdAt: at });
    playlistId = made.id;
    created = made.created;
    front = false;
  } else {
    const found = findTheme(plan, themes);
    if (found && found.playlistId === null) {
      await deps.store.saveRun(entry.id, owner, { status: 'skipped', playlistId: null, reason: 'theme_deleted' });
      return { status: 'skipped', reason: 'theme_deleted' };
    }
    if (found && found.playlistId) {
      playlistId = found.playlistId;
      created = false;
      front = true;
      title = found.title;
    } else {
      const made = await deps.store.createPlaylist({ owner, name: plan.title, kind: 'theme', themeKey: themeKey(plan.title), sourceEntryId: entry.id, createdAt: at });
      playlistId = made.id;
      created = made.created;
      // a theme that another run made a moment ago already has songs: the newest go first
      front = !made.created;
    }
  }

  const added = await deps.store.addSongs(playlistId, keys, { front, addedAt: at });
  await deps.store.saveRun(entry.id, owner, { status: 'done', playlistId, reason: null });

  if (opts.announce !== false && (created || added > 0)) {
    await deps
      .announce({
        userId: owner,
        entryId: entry.id,
        title: created ? `Nuova playlist: ${title}` : title,
        body: created ? `${added} ${added === 1 ? 'brano' : 'brani'}` : `+${added} ${added === 1 ? 'brano' : 'brani'}`,
      })
      .catch(() => undefined);
  }
  return { status: 'done', playlistId, title, kind: plan.kind, created, added };
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
  sourceEntryId: string;
  createdAt: Date;
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
    this.playlists.set(id, { id, owner: input.owner, name: input.name, kind: input.kind, themeKey: input.themeKey, sourceEntryId: input.sourceEntryId, createdAt: input.createdAt, songs: [] });
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
