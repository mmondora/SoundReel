/**
 * The nightly pass of the collections, on a timer (Raccolte, task 7; spec 2026-11-09-library-collections-auto-topics-design.md §5.3 and §5.10): the first pass
 * about ten minutes after the server starts (never at the boot: the backfill and the analyses are busier then), then every 24 hours, for every user that has
 * vectors. The rules are in `collectionsEngine.ts`; this only decides WHEN and for WHOM, and what a failure does.
 *
 * BEFORE the pass of an owner the entries whose inputs are still missing are healed (`catchUpInputs` of the wiring: a vector, the places and venues; the same
 * decision as the pipeline of an entry): a router that was down after an analysis left a hole, and the pass should see the vector. The heal has ONE budget for
 * the whole night (200 entries), so that a cold router cannot stretch the pass; it is best effort (a failure is a warning and the pass goes on), and when there
 * was something to do and NOTHING could be done the model looks down and the other owners are not asked tonight.
 *
 * THE FIRST PUBLICATION IS NOT THE NIGHT'S: the pass consolidates only an owner who ALREADY has collections (any row of the table, in any state: a hidden or a
 * merged one is a publication too). The first ones are made by `rebuildCollections --apply`, after a look at its preview with Michele (spec §9, the golden set);
 * an owner who has none WAITS (his missing inputs are still healed, so the preview sees every vector), and a family member needs `--owner`.
 *
 * A pass that fails is a warning and the next night tries again; one user that fails never stops the others; a tick that finds the previous pass still going
 * does nothing; neither timer keeps the process alive; `COLLECTIONS_AUTO=0` starts nothing (the collections that exist stay). Nothing here throws.
 */
import { logInfo, logWarning } from '../utils/logger';
import type { ConsolidationResult } from './collectionsEngine';
import { catchUpInputs, collectionsAutoEnabled, realCatchUpDeps, type CatchUpSummary } from './collectionsWiring';
import type { ScheduleTimers } from './genrePlaylistSweep';

/** About ten minutes after the start: the boot, the backfill of the inputs and the first analyses are all busy before. */
export const NIGHTLY_FIRST_RUN_MS = 10 * 60 * 1000;
export const NIGHTLY_EVERY_MS = 24 * 60 * 60 * 1000;
/** The entries healed in a night, for all the owners together (each one is a call to the model, 300 ms apart: at most about a minute and a half when it answers). */
export const NIGHTLY_CATCH_UP_LIMIT = 200;

export interface NightlyDeps {
  listOwners: () => Promise<string[]>;
  consolidate: (userId: string) => Promise<ConsolidationResult>;
  /**
   * Has this owner a first publication (any collection, in any state)? The one who has not WAITS for `rebuildCollections --apply`: nothing is published by the
   * night. Without it (a test, a script) every owner is consolidated; the real night always has it.
   */
  published?: (owner: string) => Promise<boolean>;
  /** Reads what is still missing (vector, places) of the entries of this owner, at most `limit` of them. Without it the owners are only consolidated. */
  catchUp?: (owner: string, limit: number) => Promise<CatchUpSummary>;
  /** The entries healed in a night, all owners together (default: `NIGHTLY_CATCH_UP_LIMIT`). */
  catchUpLimit?: number;
  /** The timers can be handed in, for the tests. */
  timers?: ScheduleTimers;
  firstRunMs?: number;
  everyMs?: number;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Distinct, in order, trimmed, never «anonymous», never an empty name. */
function passOwners(owners: string[]): string[] {
  const out: string[] = [];
  for (const raw of owners) {
    const owner = typeof raw === 'string' ? raw.trim() : '';
    if (owner && owner !== 'anonymous' && !out.includes(owner)) out.push(owner);
  }
  return out;
}

export interface NightlyRun {
  owners: number;
  ok: number;
  failed: number;
  /** Entries whose missing inputs were read tonight. */
  healed: number;
  /** Entries that needed something and could not get it (asked again tomorrow). */
  stillPending: number;
  /** Owners who have no collection yet: not consolidated tonight (the first publication is the script's, after a look at the preview). */
  waiting: number;
}

/**
 * One run for every owner, one after the other (the model is shared with the analyses: no hurry): the heal of his missing inputs, then his pass. Never throws.
 */
export async function runNightly(deps: Pick<NightlyDeps, 'listOwners' | 'consolidate' | 'published' | 'catchUp' | 'catchUpLimit'>): Promise<NightlyRun> {
  const run: NightlyRun = { owners: 0, ok: 0, failed: 0, healed: 0, stillPending: 0, waiting: 0 };
  let owners: string[];
  try {
    owners = passOwners(await deps.listOwners());
  } catch (err) {
    logWarning('collections nightly: could not list the owners (tried again at the next run)', { error: messageOf(err) });
    run.failed = 1;
    return run;
  }
  let budget = deps.catchUpLimit ?? NIGHTLY_CATCH_UP_LIMIT;
  let modelLooksDown = false;
  for (const owner of owners) {
    run.owners += 1;
    if (deps.catchUp && budget > 0 && !modelLooksDown) {
      try {
        const healed = await deps.catchUp(owner, budget);
        budget -= healed.needAny;
        run.healed += healed.done;
        run.stillPending += healed.pending;
        if (healed.needAny > 0 && healed.done === 0) {
          modelLooksDown = true;
          logWarning('collections nightly: nothing could be caught up (the model looks down): the other owners are not asked tonight', { owner, pending: healed.pending });
        }
      } catch (err) {
        logWarning('collections: catching up the inputs failed for an owner (the pass goes on)', { owner, error: messageOf(err) });
      }
    }
    if (deps.published) {
      let has: boolean;
      try {
        has = await deps.published(owner);
      } catch (err) {
        run.failed += 1;
        logWarning('collections: could not tell whether the owner has collections (no pass for him tonight, the others go on)', { owner, error: messageOf(err) });
        continue;
      }
      if (!has) {
        run.waiting += 1;
        logInfo('collections nightly: the owner has no collection yet and is waiting for the first publication (rebuildCollections --apply, after a look at the preview)', { owner });
        continue;
      }
    }
    try {
      await deps.consolidate(owner);
      run.ok += 1;
    } catch (err) {
      run.failed += 1;
      logWarning('collections: the pass failed for an owner (the others go on)', { owner, error: messageOf(err) });
    }
  }
  const waitingNote = run.waiting > 0 ? `, ${run.waiting} waiting for the first publication` : '';
  logInfo(`collections nightly done: ${run.ok} of ${run.owners} ${run.owners === 1 ? 'owner' : 'owners'}, ${run.healed} ${run.healed === 1 ? 'entry' : 'entries'} caught up${waitingNote}`, { ...run });
  return run;
}

/**
 * The schedule: one run `firstRunMs` after the start, then every `everyMs`. Neither timer keeps the process alive; a run that fails is a warning and the next
 * one tries again; a tick that finds the previous run still going does nothing; the function it returns stops everything (a run already going finishes, a
 * timer that fires after it does nothing).
 */
export function startNightlySchedule(
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
      logWarning('collections nightly pass failed (tried again at the next run)', { error: messageOf(err) });
    } finally {
      running = false;
    }
  };
  const first = timers.setTimeout(() => void tick(), opts.firstRunMs ?? NIGHTLY_FIRST_RUN_MS);
  const every = timers.setInterval(() => void tick(), opts.everyMs ?? NIGHTLY_EVERY_MS);
  for (const timer of [first, every]) (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    timers.clearTimeout(first);
    timers.clearInterval(every);
  };
}

/**
 * The real parts of the night: the owners with vectors, whether each one has a first publication, the pass of the engine with its real dependencies, and the heal of the wiring (the whole-library run, in
 * apply mode, for ONE owner and at most the budget; its progress lines go to the log). Made only when they are needed, so that importing this module opens nothing.
 */
export async function realNightlyDeps(): Promise<NightlyDeps> {
  const [{ consolidate }, data] = await Promise.all([import('./collectionsEngine'), import('./collectionsEngineData')]);
  const engine = data.realEngineDeps();
  const healing = realCatchUpDeps((line) => logInfo(line));
  return {
    listOwners: data.listOwners,
    published: data.hasCollections,
    consolidate: (userId) => consolidate(userId, engine),
    catchUp: (owner, limit) => catchUpInputs(healing, { apply: true, owner, limit }),
  };
}

/**
 * What the server starts (`server.ts`): the pass for every user that has vectors, unless `COLLECTIONS_AUTO=0`. The dependencies are the real ones unless handed
 * in.
 */
export function startNightlyConsolidation(deps?: NightlyDeps): { stop: () => void } {
  if (!collectionsAutoEnabled()) return { stop: () => undefined };
  const stop = startNightlySchedule(
    async () => {
      await runNightly(deps ?? (await realNightlyDeps()));
    },
    { timers: deps?.timers, firstRunMs: deps?.firstRunMs, everyMs: deps?.everyMs },
  );
  return { stop };
}
