/**
 * The activity trail: who did what, when, from which device. Written to the existing `logs` table, so it shows
 * up in the Console (the "function" filter is the category) next to the pipeline logs, with
 * `data.action` and `data.actor = { user, device, channel }` on every line.
 *
 *   playlist  create / rename / delete / add_song / remove_song / reorder / share / unshare / rule_update
 *   sync      prepare (a device starts syncing a playlist) / manifest (a device read it)
 *   download  request / file / done / failed / override
 *   device    delete_songs / plays
 *
 * Fire-and-forget: a failed log line must never fail the action it describes.
 */
import { Logger } from './debugLogger';

export type ActivityCategory = 'playlist' | 'sync' | 'download' | 'device';
export type ActorChannel = 'web' | 'mondrop' | 'worker' | 'system';

export interface Actor {
  user: string;
  /** Label of the device the API key was issued for ("iPhone di Michele"); null on the web. */
  device?: string | null;
  channel: ActorChannel;
}

export const SYSTEM_ACTOR: Actor = { user: 'sistema', channel: 'system' };

/** "mike (iPhone di Michele)", or just "mike" when there is no device. */
export function describeActor(actor: Actor): string {
  const device = actor.device?.trim();
  return device ? `${actor.user} (${device})` : actor.user;
}

/** "White Flag – Bishop Briggs" for a song, or a readable fallback built from its key ("artist::title"). */
export function songLabel(song: { title?: string | null; artist?: string | null } | null | undefined, key?: string): string {
  const title = song?.title?.trim();
  const artist = song?.artist?.trim();
  if (title) return artist ? `${title} – ${artist}` : title;
  if (key) {
    const [a, ...rest] = key.split('::');
    const t = rest.join('::');
    return t ? (a ? `${t} – ${a}` : t) : key;
  }
  return 'brano sconosciuto';
}

export function logActivity(
  category: ActivityCategory,
  action: string,
  message: string,
  actor: Actor,
  data: Record<string, unknown> = {},
): void {
  try {
    new Logger(category).info(message, {
      action,
      actor: { user: actor.user, device: actor.device ?? null, channel: actor.channel },
      ...data,
    });
  } catch {
    /* an audit line is never worth breaking the request */
  }
}

const seen = new Map<string, number>();

/**
 * True the first time a key is seen in a window: for events a client repeats on a timer (a device polling the
 * manifest every few seconds must leave one line, not hundreds).
 */
export function shouldLogOnce(key: string, ttlMs: number, now: number = Date.now()): boolean {
  const until = seen.get(key);
  if (until !== undefined && until > now) return false;
  seen.set(key, now + ttlMs);
  if (seen.size > 2000) {
    for (const [k, t] of seen) if (t <= now) seen.delete(k);
  }
  return true;
}

export function _resetActivityThrottleForTest(): void {
  seen.clear();
}

/** 5,5 MB / 312 MB / 1,2 GB (Italian decimal comma, what the console reader expects). */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / 1_048_576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace('.', ',')} MB`;
}
