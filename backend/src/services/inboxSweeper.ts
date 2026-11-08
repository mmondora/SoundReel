/**
 * The housekeeping of the inbox, hourly: information past its 3 days goes away, old removal memories and finished
 * share intents are dropped. Errors are never touched (spec IN4). One run failing costs nothing: the next one retries.
 */
import { logInfo, logWarning } from '../utils/logger';
import { sweepInbox, type SweepResult } from './inbox';
import { resolveStuckIntents } from './shareFlow';

export const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Shares whose analysis ended without anyone announcing it are looked at this often. */
export const STUCK_EVERY_MS = 10 * 60 * 1000;
const FIRST_RUN_MS = 90_000;

export async function sweepOnce(sweep: () => Promise<SweepResult> = sweepInbox): Promise<SweepResult | null> {
  try {
    const result = await sweep();
    if (result.expired > 0 || result.purged > 0 || result.intentsPurged > 0) logInfo('inbox sweep', { ...result });
    return result;
  } catch (err) {
    logWarning('inbox sweep failed (retried at the next run)', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function resolveOnce(resolve: () => Promise<number> = resolveStuckIntents): Promise<number> {
  try {
    const closed = await resolve();
    if (closed > 0) logInfo('stuck shares resolved', { closed });
    return closed;
  } catch (err) {
    logWarning('resolving stuck shares failed (retried at the next run)', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

/** Starts the housekeeping (hourly) and the stuck-share resolver (every 10 minutes); returns the function that stops both. */
export function startInboxSweeper(
  sweep: () => Promise<SweepResult> = sweepInbox,
  resolve: () => Promise<number> = resolveStuckIntents,
): () => void {
  const first = setTimeout(() => void sweepOnce(sweep), FIRST_RUN_MS);
  const every = setInterval(() => void sweepOnce(sweep), SWEEP_EVERY_MS);
  const firstResolve = setTimeout(() => void resolveOnce(resolve), FIRST_RUN_MS);
  const everyResolve = setInterval(() => void resolveOnce(resolve), STUCK_EVERY_MS);
  for (const t of [first, every, firstResolve, everyResolve]) t.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
    clearTimeout(firstResolve);
    clearInterval(everyResolve);
  };
}
