/**
 * A one-off, gentle pass that gives every song already in the library its release year (ADR-0013, spec
 * 2026-11-08-player-selection-and-filters-design.md X5). "Anni 80" needs a year, and the songs enriched before
 * 2.9.0 have none.
 *
 *  - ONLY THE YEAR is written for a song that is already enriched: its cover, genres and links are left exactly as
 *    they are (313 songs were enriched by Deezer with 250 px covers; rewriting them through iTunes just to add a
 *    year would downgrade them). A song never enriched gets the normal enrichment, which brings its year along.
 *  - A song is asked about ONCE: `song_meta.release_year_checked_at` is set whether or not a year was found.
 *  - The year comes from iTunes only (ADR-0013 section 5: Deezer's album dates are edition dates), and iTunes' own 3 s
 *    throttle (songEnrichment.ts, shared with the live enrichment) paces the pass: about 3.6 s a song, some 50 minutes
 *    for the whole library, once, without ever starving the live enrichment.
 *  - An outage is told from "iTunes does not know this song": a request that FAILED is not marked and counts towards
 *    MAX_CONSECUTIVE_FAILURES; a request that was ANSWERED with nothing trustworthy is a final "Senza anno". When the
 *    failures pile up the pass stops and starts again later.
 *  - Songs that arrive later are enriched (and so get their year) by the normal path; this pass only catches up.
 */
import { logError, logInfo, logWarning } from '../utils/logger';
import { enrichSongWithYear, lookupItunesYear, type SongEnrichmentResult } from './songEnrichment';
import { listReleaseYearChecked, setReleaseYear, upsertSongEnrichment } from './songMeta';

export const DELAY_MS = 600;
export const MAX_CONSECUTIVE_FAILURES = 5;
const START_DELAY_MS = 90_000;
const RETRY_AFTER_ABORT_MS = 60 * 60_000;

export interface BackfillSong {
  key: string;
  artist: string;
  title: string;
  /** Already enriched (cover, genres, links): only the year is looked up, and only the year is written. */
  enriched: boolean;
}

/** What asking about one song came to. */
export type YearOutcome =
  | { kind: 'year'; year: number; enrichment?: SongEnrichmentResult }
  /** The provider answered and has no date it can vouch for: a final "Senza anno". */
  | { kind: 'none'; enrichment?: SongEnrichmentResult }
  /** The question could not be asked (HTTP or network error): nothing is recorded, try again later. */
  | { kind: 'failed' };

export type SettledOutcome = Exclude<YearOutcome, { kind: 'failed' }>;

export interface BackfillDeps {
  /** Every song of the library (all users), once per run. */
  listSongs: () => Promise<BackfillSong[]>;
  /** Songs already asked about. */
  listChecked: () => Promise<Set<string>>;
  lookup: (song: BackfillSong) => Promise<YearOutcome>;
  /** Writes the outcome of a settled lookup (the year, and the enrichment of a song that had none). */
  record: (song: BackfillSong, outcome: SettledOutcome) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
}

export interface BackfillOptions {
  delayMs?: number;
  maxConsecutiveFailures?: number;
}

export interface BackfillReport {
  /** Songs in the library. */
  total: number;
  /** Songs that had not been asked about when the run began. */
  todo: number;
  /** Songs settled in this run (year found, or a final "Senza anno"). */
  checked: number;
  withYear: number;
  noYear: number;
  /** Stopped early: failures piled up (an outage is suspected), or the server is shutting down. */
  aborted: boolean;
  /** Songs still to ask about. */
  remaining: number;
}

export async function runReleaseYearBackfill(deps: BackfillDeps, options: BackfillOptions = {}): Promise<BackfillReport> {
  const delayMs = options.delayMs ?? DELAY_MS;
  const maxFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;

  const songs = await deps.listSongs();
  const done = await deps.listChecked();
  const todo = songs.filter((s) => !done.has(s.key));
  const report: BackfillReport = { total: songs.length, todo: todo.length, checked: 0, withYear: 0, noYear: 0, aborted: false, remaining: todo.length };

  let failures = 0;
  for (const song of todo) {
    if (deps.shouldStop?.()) {
      report.aborted = true;
      break;
    }

    let outcome: YearOutcome;
    try {
      outcome = await deps.lookup(song);
    } catch (err) {
      logWarning('release year backfill: lookup threw, counted as a failure', { key: song.key, err: String(err) });
      outcome = { kind: 'failed' };
    }

    if (outcome.kind === 'failed') {
      failures += 1;
      if (failures >= maxFailures) {
        report.aborted = true; // looks like an outage: leave them unmarked, try again later
        break;
      }
    } else {
      failures = 0;
      await deps.record(song, outcome);
      report.checked += 1;
      if (outcome.kind === 'year') report.withYear += 1;
      else report.noYear += 1;
    }
    await deps.sleep(delayMs);
  }

  report.remaining = todo.length - report.checked;
  return report;
}

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

const off = (value: string | undefined): boolean => ['0', 'false', 'off'].includes((value ?? '').toLowerCase());

/** The same switches as the enrichment (tests set SONG_ENRICHMENT_ENABLED=0), plus one of its own. */
export function releaseYearBackfillEnabled(): boolean {
  return !off(process.env.SONG_ENRICHMENT_ENABLED) && !off(process.env.RELEASE_YEAR_BACKFILL_ENABLED);
}

/** The real dependencies: the journal, the song_meta table and iTunes. Exported for the live (real database) check. */
export function realBackfillDeps(): BackfillDeps {
  return {
    listSongs: async () => {
      // loaded on demand: routes/songs pulls in half the backend, which a unit test of the runner does not need
      const [{ aggregateSongs, LIST_ENTRIES_LIMIT }, { listEntries }, { listSongMeta }] = await Promise.all([
        import('../routes/songs'),
        import('../utils/db'),
        import('./songMeta'),
      ]);
      const [entries, meta] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listSongMeta()]);
      return [...aggregateSongs(entries, new Map()).values()].map((s) => ({
        key: s.songKey,
        artist: s.artist,
        title: s.title,
        enriched: meta.get(s.songKey)?.enrichedAt != null,
      }));
    },
    listChecked: listReleaseYearChecked,
    lookup: async (song) => {
      if (song.enriched) {
        const { answered, year } = await lookupItunesYear(song.artist, song.title);
        if (!answered) return { kind: 'failed' };
        return year !== null ? { kind: 'year', year } : { kind: 'none' };
      }
      // never enriched: the normal enrichment, which brings the year with it (null = not found: nothing to rewrite)
      const enrichment = await enrichSongWithYear(song.artist, song.title);
      if (!enrichment) return { kind: 'none' };
      return enrichment.releaseYear !== null ? { kind: 'year', year: enrichment.releaseYear, enrichment } : { kind: 'none', enrichment };
    },
    record: async (song, outcome) => {
      if (outcome.enrichment) await upsertSongEnrichment({ songKey: song.key, ...outcome.enrichment });
      else await setReleaseYear(song.key, outcome.kind === 'year' ? outcome.year : null);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function startReleaseYearBackfill(
  options: { firstRunDelayMs?: number; retryMs?: number; deps?: BackfillDeps; runOptions?: BackfillOptions } = {},
): () => void {
  if (!releaseYearBackfillEnabled()) return () => undefined;

  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  const retryMs = options.retryMs ?? RETRY_AFTER_ABORT_MS;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const report = await runReleaseYearBackfill({ ...(options.deps ?? realBackfillDeps()), shouldStop: () => stopped }, options.runOptions);
      if (report.todo > 0) logInfo('release year backfill pass done', { ...report });
      if (report.aborted && !stopped) {
        logWarning('release year backfill stopped early (iTunes not answering?), will try again later', { remaining: report.remaining });
        schedule(retryMs);
      }
    } catch (err) {
      logError('release year backfill failed, will try again later', { err: String(err) });
      schedule(retryMs);
    } finally {
      running = false;
    }
  };

  schedule(options.firstRunDelayMs ?? START_DELAY_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
