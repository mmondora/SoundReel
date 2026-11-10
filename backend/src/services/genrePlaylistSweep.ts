/**
 * The daily sweep of the genre playlists (ADR-0024, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.14).
 *
 * The playlist of a genre («Jazz da ascoltare») is born when a post of that theme goes by AND the library has two songs that carry the tag
 * (§3.A.12). A genre that has the songs but whose theme no post ever named has no playlist, and would not have one until a post came. Michele,
 * 10 November, asked about exactly that: «Le playlist di genere Latina (8 brani), Techno (4), Blues (4) e Metal (2) non esistono ancora, perché
 * nessun post con quel tema è passato. Un controllo una volta al giorno le fa nascere subito, senza aspettare il post. Lo faccio?» — «Sì, controllo
 * giornaliero (Recommended)».
 *
 * So, once a day and for every owner: every genre theme with at least `MIN_PLAYLIST_SONGS` songs in the library and no playlist gets the SAME
 * dynamic playlist a post of the theme would have made (`makeGenrePlaylist`). Rules that never bend: a playlist that is there is never touched; one
 * the user deleted is remembered (the theme row without a playlist) and never made again; two runs, or a run and a post, make ONE playlist (the
 * unique index decides, and the one who finds it there says «already there»); one theme or one owner failing never stops the others.
 *
 * Like `autoPlaylists.ts` the rules are pure: the store, the library count, the inbox and the clock come in through `GenreSweepDeps`, so the preview
 * of the script and the schedule run exactly this code. No model, no external service: the title is the word of the theme and its suffix.
 */
import { logInfo, logWarning } from '../utils/logger';
import { MIN_PLAYLIST_SONGS, makeGenrePlaylist, type AutoPlaylistStore } from './autoPlaylists';
import { GENRE_OF_THEME, GENRE_PLAYLIST_LIMIT, THEME_SUFFIX, genreThemeKey } from './genreThemes';

/** The first run comes about two minutes after the boot (the server has other things to do first), then every 24 hours. */
export const GENRE_SWEEP_FIRST_RUN_MS = 2 * 60 * 1000;
export const GENRE_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

export interface GenreTheme {
  /** The word of the theme in the registry («Latina»); of two words for one set of genres, the first one. */
  word: string;
  /** What the playlist is called: the word and the suffix, always the same string (no model is asked). */
  title: string;
  /** The canonical genres whose songs belong to it (what the rule selects and what the library is asked about). */
  genres: string[];
  /** `theme_key`: one per owner and set of genres. */
  key: string;
}

/**
 * The genre themes, in the order of the registry, ONE per set of genres («Rap» and «Hip hop» are one playlist, «R&B» and «Soul» too; House and
 * Techno are two). Of two words for the same set the first of the registry names the playlist.
 */
export function genreThemes(): GenreTheme[] {
  const seen = new Set<string>();
  const out: GenreTheme[] = [];
  for (const [word, genres] of Object.entries(GENRE_OF_THEME)) {
    const key = genreThemeKey(genres);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ word, title: `${word}${THEME_SUFFIX}`, genres: [...genres], key });
  }
  return out;
}

/** What the sweep decides about one theme (and, once it has run, did). */
export interface SweepItem {
  theme: GenreTheme;
  action: 'create' | 'skip' | 'failed';
  reason?: 'has_playlist' | 'deleted_by_user' | 'too_few_songs';
  /** How many songs of the library carry the genre; not asked when the theme already has an answer (a playlist, or a deletion). */
  matching?: number;
  /** The playlist that was made, or the one that was found there. */
  playlistId?: string;
  error?: string;
}

export interface GenreSweepDeps {
  store: Pick<AutoPlaylistStore, 'listThemes' | 'createPlaylist' | 'listWaiting' | 'saveRun'>;
  /** How many songs of the owner's library carry one of these genres: the SAME count the engine uses before it makes the playlist of a post. */
  countGenreSongs(owner: string, genres: string[]): Promise<number>;
  /** The message in the Posta; there is no post to link (`entryId` is null), like the message of the backfill. */
  announce(item: { userId: string; title: string; body: string; entryId: string | null }): Promise<void>;
  now(): Date;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Postgres says 23505 when a unique index refuses an insert: for the sweep that only means someone made the playlist a moment ago. */
const isUniqueViolation = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';

/**
 * What the sweep would do for this owner. Reads only (the themes of the owner, and the library for the genres that have no answer yet): nothing is
 * written, nothing is said. The preview of the script is this; `ensureGenrePlaylists` does what this says.
 */
export async function planGenreSweep(owner: string, deps: Pick<GenreSweepDeps, 'store' | 'countGenreSongs'>): Promise<SweepItem[]> {
  const known = new Map((await deps.store.listThemes(owner)).map((t) => [t.themeKey, t]));
  const plan: SweepItem[] = [];
  for (const theme of genreThemes()) {
    const row = known.get(theme.key);
    if (row) {
      // a theme with a playlist is left alone; one with NO playlist was deleted by the user: it is not made again
      plan.push(row.playlistId === null ? { theme, action: 'skip', reason: 'deleted_by_user' } : { theme, action: 'skip', reason: 'has_playlist', playlistId: row.playlistId });
      continue;
    }
    try {
      const matching = await deps.countGenreSongs(owner, theme.genres);
      plan.push(matching >= MIN_PLAYLIST_SONGS ? { theme, action: 'create', matching } : { theme, action: 'skip', reason: 'too_few_songs', matching });
    } catch (err) {
      logWarning('genre playlist could not be counted (the other genres go on)', { owner, theme: theme.word, error: messageOf(err) });
      plan.push({ theme, action: 'failed', error: messageOf(err) });
    }
  }
  return plan;
}

export interface OwnerSweep {
  owner: string;
  items: SweepItem[];
  created: number;
}

const songs = (n: number): string => `${n} ${n === 1 ? 'brano' : 'brani'}`;

/**
 * For one owner: makes the playlist of every genre the plan says, and tells him. The playlist is the dynamic one of `makeGenrePlaylist` with no
 * source post, dated now; the posts that waited for the theme are done with it. Never throws for a theme: it is a warning and a «failed» line.
 */
export async function ensureGenrePlaylists(owner: string, deps: GenreSweepDeps): Promise<OwnerSweep> {
  const plan = await planGenreSweep(owner, deps);
  const at = deps.now();
  const items: SweepItem[] = [];
  let created = 0;
  for (const item of plan) {
    if (item.action !== 'create') {
      items.push(item);
      continue;
    }
    try {
      const made = await makeGenrePlaylist(deps.store, { owner, title: item.theme.title, genres: item.theme.genres, key: item.theme.key, sourceEntryId: null, createdAt: at });
      if (!made.created) {
        // a post (or another run) made it a moment ago: it is there, and the one who made it said so
        items.push({ theme: item.theme, action: 'skip', reason: 'has_playlist', playlistId: made.id });
        continue;
      }
      created++;
      items.push({ ...item, playlistId: made.id });
      try {
        // what the rule will show: at most 200 songs, even when the library has more
        await deps.announce({ userId: owner, title: `Nuova playlist: ${item.theme.title}`, body: songs(Math.min(item.matching ?? 0, GENRE_PLAYLIST_LIMIT)), entryId: null });
      } catch {
        // the message only: the playlist is made anyway
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        items.push({ theme: item.theme, action: 'skip', reason: 'has_playlist' });
        continue;
      }
      logWarning('genre playlist could not be made (the other genres go on)', { owner, theme: item.theme.word, error: messageOf(err) });
      items.push({ theme: item.theme, action: 'failed', error: messageOf(err) });
    }
  }
  return { owner, items, created };
}

/** Who is swept: «anonymous» and an empty name are nobody (the engine skips them too), and a name that comes twice counts once. */
export function sweepOwners(list: readonly string[]): string[] {
  return [...new Set(list.filter((o) => typeof o === 'string' && o.trim() !== '' && o !== 'anonymous'))];
}

export interface GenreSweepRun {
  owners: number;
  created: number;
  skipped: number;
  failed: number;
}

/** Everything the sweep needs for ALL the owners: the owners themselves come from the database. */
export interface GenreSweepRunDeps extends GenreSweepDeps {
  /** The users who have entries (a user with no library gets nothing: every count is zero). */
  listOwners(): Promise<string[]>;
}

/** One run for every owner (`sweepOwners`). Never throws: an owner (or the list of owners) that fails is a warning and the others go on. */
export async function runGenreSweep(deps: GenreSweepRunDeps): Promise<GenreSweepRun> {
  const result: GenreSweepRun = { owners: 0, created: 0, skipped: 0, failed: 0 };
  let owners: string[];
  try {
    owners = sweepOwners(await deps.listOwners());
  } catch (err) {
    logWarning('genre playlist sweep could not list the owners (retried at the next run)', { error: messageOf(err) });
    result.failed = 1;
    return result;
  }
  for (const owner of owners) {
    result.owners++;
    try {
      const out = await ensureGenrePlaylists(owner, deps);
      result.created += out.created;
      result.skipped += out.items.filter((i) => i.action === 'skip').length;
      result.failed += out.items.filter((i) => i.action === 'failed').length;
    } catch (err) {
      result.failed++;
      logWarning('genre playlist sweep failed for an owner (the others go on)', { owner, error: messageOf(err) });
    }
  }
  logInfo(`genre playlist sweep done: created ${result.created} ${result.created === 1 ? 'playlist' : 'playlists'}`, { ...result });
  return result;
}

export interface ScheduleTimers {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

/**
 * The schedule: one run `firstRunMs` after the start (about two minutes), then every `everyMs` (24 hours). Neither timer keeps the process alive;
 * a run that fails is a warning and the next one tries again; a tick that finds the previous run still going does nothing; the function it
 * returns stops everything (a run already going finishes, a timer that fires after it does nothing). The timers can be handed in, for the tests.
 */
export function startGenreSweepSchedule(
  run: () => Promise<unknown>,
  opts: { timers?: ScheduleTimers; firstRunMs?: number; everyMs?: number } = {},
): () => void {
  const timers: ScheduleTimers = opts.timers ?? { setTimeout, setInterval, clearTimeout, clearInterval };
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await run();
    } catch (err) {
      logWarning('genre playlist sweep failed (retried at the next run)', { error: messageOf(err) });
    } finally {
      running = false;
    }
  };
  const first = timers.setTimeout(() => void tick(), opts.firstRunMs ?? GENRE_SWEEP_FIRST_RUN_MS);
  const every = timers.setInterval(() => void tick(), opts.everyMs ?? GENRE_SWEEP_EVERY_MS);
  for (const timer of [first, every]) (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    timers.clearTimeout(first);
    timers.clearInterval(every);
  };
}
