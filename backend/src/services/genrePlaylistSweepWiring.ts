/**
 * Where the daily genre-playlist sweep meets the rest of the server: the database (the owners, the store), the library count and the inbox
 * (ADR-0024, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.14). The rules are in `genrePlaylistSweep.ts` and are pure; this only
 * connects them, and reuses what the engine already uses (the same store, the SAME `countGenreSongs`, the same way to put a message in the Posta),
 * so the playlist a sweep makes and the playlist a post would have made cannot differ.
 */
import { query } from '../utils/db';
import { autoPlaylistsEnabled, realAutoPlaylistDeps } from './autoPlaylistWiring';
import { runGenreSweep, startGenreSweepSchedule, type GenreSweepRun, type GenreSweepRunDeps } from './genrePlaylistSweep';

/**
 * The users who have entries (the engine makes playlists for the entries a user owns): distinct, never «anonymous», never an empty name. A user who
 * has entries but no song with a genre gets nothing: every count is zero.
 */
export async function listLibraryOwners(): Promise<string[]> {
  const rows = await query<{ owner_user: string }>(
    `SELECT DISTINCT owner_user FROM entries
      WHERE owner_user IS NOT NULL AND owner_user <> '' AND owner_user <> 'anonymous'
      ORDER BY owner_user`,
  );
  return rows.map((r) => r.owner_user);
}

export function realGenreSweepDeps(): GenreSweepRunDeps {
  const engine = realAutoPlaylistDeps();
  return {
    store: engine.store,
    countGenreSongs: engine.countGenreSongs,
    // a message in the Posta (an `info` that goes away after 3 days) with no post to open, like the one of the backfill; the push is only the doorbell
    announce: engine.announce,
    now: () => new Date(),
    listOwners: listLibraryOwners,
  };
}

/** One run for every owner, unless `AUTO_PLAYLISTS=0` (the playlists already made stay). Never throws. */
export async function sweepGenrePlaylistsOnce(deps: GenreSweepRunDeps = realGenreSweepDeps()): Promise<GenreSweepRun | null> {
  if (!autoPlaylistsEnabled()) return null;
  return runGenreSweep(deps);
}

/** Starts the sweep (first run about two minutes after the boot, then every 24 hours); returns the function that stops it. */
export function startGenrePlaylistSweep(): () => void {
  return startGenreSweepSchedule(() => sweepGenrePlaylistsOnce());
}
