/**
 * "Put it on the media server" (spec W6, ADR-0010).
 *
 * The backend never writes to the box (ADR-0006: no SMB share mounted in the container). A song downloaded by the
 * web lands on geekom's disk, which is the origin of the replica; this asks the HOST to push it now instead of
 * at 04:00: it touches a sentinel file in the store folder, and a systemd user path unit
 * (scripts/fritz-sync-request.path) starts fritz-sync.service when the file changes. Then the box is polled
 * (`reconcilePublished`, a HEAD per song) until it serves the file; from that moment the web plays it from there.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logInfo, logWarning } from '../utils/logger';
import { mediaServerConfig, reconcilePublished } from './mediaServer';
import { libraryRoot, storeDir } from './musicStore';

export const PUBLISH_SENTINEL = '.publish-request';
/** Downloads that finish within this window share one request. */
export const PUBLISH_DEBOUNCE_MS = 20_000;
/** A push takes a while: never ask more often than this. */
export const PUBLISH_MIN_INTERVAL_MS = 90_000;
/** When to look whether the box serves the file by now (the push, then the box's own indexing). */
export const PUBLISH_FOLLOW_UPS_MS = [60_000, 3 * 60_000, 8 * 60_000];

export function publishSentinelPath(): string | null {
  const root = libraryRoot();
  return root ? path.join(root, storeDir(), PUBLISH_SENTINEL) : null;
}

/** Write the sentinel (its content only has to change). Never throws: the nightly run publishes anyway. */
export async function touchPublishSentinel(now: Date = new Date()): Promise<boolean> {
  const file = publishSentinelPath();
  if (!file) return false;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${now.toISOString()}\n`);
    return true;
  } catch (err) {
    logWarning('publish request not written (the nightly sync will still publish)', { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

let pending: NodeJS.Timeout | null = null;
let lastRequestAt = 0;
const followUps = new Set<NodeJS.Timeout>();

function scheduleFollowUps(): void {
  for (const delay of PUBLISH_FOLLOW_UPS_MS) {
    const t = setTimeout(() => {
      followUps.delete(t);
      void reconcilePublished().catch((err) => logWarning('media publish follow-up failed', { err: err instanceof Error ? err.message : String(err) }));
    }, delay);
    t.unref();
    followUps.add(t);
  }
}

/**
 * Ask for a push of the store to the box. Cheap and safe to call after every download: one pending request covers
 * every download that finishes meanwhile, and requests are spaced out.
 */
export function requestMediaPublish(): void {
  if (pending || !mediaServerConfig().enabled || !publishSentinelPath()) return;
  const wait = Math.max(PUBLISH_DEBOUNCE_MS, lastRequestAt + PUBLISH_MIN_INTERVAL_MS - Date.now());
  pending = setTimeout(() => {
    pending = null;
    lastRequestAt = Date.now();
    void touchPublishSentinel().then((ok) => {
      if (!ok) return;
      logInfo('media publish requested', { sentinel: PUBLISH_SENTINEL });
      scheduleFollowUps();
    });
  }, wait);
  pending.unref();
}

/** For tests and shutdown: forget every timer and the rate limit. */
export function _resetMediaPublishForTest(): void {
  if (pending) clearTimeout(pending);
  pending = null;
  lastRequestAt = 0;
  for (const t of followUps) clearTimeout(t);
  followUps.clear();
}
