/**
 * What happens to a share after the link is stored (ADR-0015, spec SH5/SH6/IN3–IN5): the playlist the user chose,
 * the family he shared it with, and the notices that come back — to him (the outcome, like Telegram's reply) and to
 * the people who received the entry.
 *
 * A song known at once (Spotify, Shazam) is handled at share time; the rest when the analysis ends. Both paths end
 * in `completeIntent`, gated by the intent row so a share is announced exactly once, whatever runs it.
 */
import type { Entry } from '../types';
import { addEntryShares, getEntry } from '../utils/db';
import { ANONYMOUS_USER, FAMILY_USERS, normalizeFamilyUser } from '../utils/requestUser';
import { logWarning } from '../utils/logger';
import { addSongsToPlaylist, getPlaylist } from './playlists';
import { songKey } from './songMeta';
import { closeErrorsForLink, createInboxItem, usersNotifiedAbout, type InboxItem, type NewInboxItem } from './inbox';
import { announceInboxItem } from './inboxAnnouncer';
import {
  finishIntent,
  pendingIntentsForEntry,
  stuckIntents,
  upsertPendingIntent,
  type NewShareIntent,
  type ShareIntent,
} from './shareIntents';
import {
  composeShareError,
  composeShareReceived,
  composeShareResult,
  digestEntry,
  type PlaylistOutcome,
  type ShareErrorReason,
  type ShareNotice,
  type ShareOptions,
} from './shareNotifications';

// ---------------------------------------------------------------------------
// What the request asked for
// ---------------------------------------------------------------------------

export type RejectReason = 'self' | 'unknown_user' | 'sender_unknown';

export interface ShareRequestOptions {
  /** The playlist asked for, whatever its validity (checked later). */
  playlistId: string | null;
  /** The family members that can really receive it. */
  recipients: string[];
  rejected: Array<{ user: string; reason: RejectReason }>;
}

const MAX_RECIPIENTS_ASKED = 10;
const MAX_COMMENT = 500;

/**
 * Reads `playlistId` and `shareWith` of `POST /api/share`. `shareWith` takes only family members, never the sender,
 * and a key not bound to a user (`anonymous`) shares with nobody: the entry would have no sender to show.
 */
export function parseShareOptions(body: { playlistId?: unknown; shareWith?: unknown } | undefined, sender: string): ShareRequestOptions {
  const playlistId = typeof body?.playlistId === 'string' && body.playlistId.trim() ? body.playlistId.trim().slice(0, 100) : null;
  const asked = Array.isArray(body?.shareWith) ? (body.shareWith as unknown[]).filter((u): u is string => typeof u === 'string') : [];
  const recipients: string[] = [];
  const rejected: ShareRequestOptions['rejected'] = [];
  const seen = new Set<string>();
  for (const raw of asked.slice(0, MAX_RECIPIENTS_ASKED)) {
    const user = raw.trim().toLowerCase();
    if (!user || seen.has(user)) continue;
    seen.add(user);
    if (sender === ANONYMOUS_USER) rejected.push({ user, reason: 'sender_unknown' });
    else if (user === sender) rejected.push({ user, reason: 'self' });
    else if (!(FAMILY_USERS as readonly string[]).includes(user)) rejected.push({ user, reason: 'unknown_user' });
    else recipients.push(user);
  }
  return { playlistId, recipients, rejected };
}

/** The inbox user of a share: the same mapping the Mondrop routes use (a family id, else `anonymous`). */
export const inboxUserOf = (owner: string | null | undefined): string => normalizeFamilyUser(owner) ?? ANONYMOUS_USER;

export const cleanComment = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, MAX_COMMENT) : null;

// ---------------------------------------------------------------------------
// Dependencies (replaceable in tests)
// ---------------------------------------------------------------------------

export interface FlowDeps {
  getEntry: (id: string) => Promise<Entry | null>;
  addEntryShares: (entryId: string, users: string[], by: string) => Promise<string[]>;
  notifiedRecipients: (entryId: string, users: string[]) => Promise<string[]>;
  getPlaylist: (id: string, who: { userId: string }) => Promise<{ id: string; name: string; kind?: 'static' | 'dynamic'; ownerUser?: string } | null>;
  addSongsToPlaylist: (playlistId: string, songKeys: string[], owner: string) => Promise<number | null>;
  createInboxItem: (item: NewInboxItem, now?: Date) => Promise<InboxItem>;
  closeErrorsForLink: (userId: string, linkKey: string, now?: Date) => Promise<string[]>;
  announce: (item: InboxItem) => Promise<void>;
  upsertPendingIntent: (input: NewShareIntent) => Promise<ShareIntent>;
  pendingIntentsForEntry: (entryId: string) => Promise<ShareIntent[]>;
  finishIntent: (id: string, status: 'done' | 'failed', result: Record<string, unknown>) => Promise<boolean>;
  stuckIntents: (olderThan: Date) => Promise<ShareIntent[]>;
}

// Each dependency is read when it is called, not when this module loads: anything that imports the job worker or the
// Spooty watcher (and so this file) must not need the whole database layer just to be imported.
export const realDeps: FlowDeps = {
  getEntry: (id) => getEntry(id),
  addEntryShares: (entryId, users, by) => addEntryShares(entryId, users, by),
  notifiedRecipients: (entryId, users) => usersNotifiedAbout(entryId, users),
  getPlaylist: (id, who) => getPlaylist(id, who),
  addSongsToPlaylist: (playlistId, keys, owner) => addSongsToPlaylist(playlistId, keys, owner),
  createInboxItem: (item, now) => createInboxItem(item, now),
  closeErrorsForLink: (userId, linkKey, now) => closeErrorsForLink(userId, linkKey, now),
  announce: (item) => announceInboxItem(item),
  upsertPendingIntent: (input) => upsertPendingIntent(input),
  pendingIntentsForEntry: (entryId) => pendingIntentsForEntry(entryId),
  finishIntent: (id, status, result) => finishIntent(id, status, result),
  stuckIntents: (olderThan) => stuckIntents(olderThan),
};

// ---------------------------------------------------------------------------
// The playlist
// ---------------------------------------------------------------------------

export type PlaylistProblem = 'not_found' | 'dynamic' | 'read_only';
export type PlaylistCheck = { ok: true; id: string; name: string } | { ok: false; id: string; error: PlaylistProblem };

/** A share can fill only a STATIC playlist the sender owns: dynamic ones are rules, shared ones are read-only. */
export async function checkPlaylist(id: string, userId: string, deps: Pick<FlowDeps, 'getPlaylist'> = realDeps): Promise<PlaylistCheck> {
  const playlist = await deps.getPlaylist(id, { userId });
  if (!playlist) return { ok: false, id, error: 'not_found' };
  if (playlist.kind === 'dynamic') return { ok: false, id, error: 'dynamic' };
  if (playlist.ownerUser !== userId) return { ok: false, id, error: 'read_only' };
  return { ok: true, id: playlist.id, name: playlist.name };
}

const PLAYLIST_REASON: Record<PlaylistProblem, ShareErrorReason> = {
  not_found: 'playlist_not_found',
  dynamic: 'playlist_dynamic',
  read_only: 'playlist_read_only',
};

const PROBLEM_OF: Record<string, PlaylistProblem> = {
  playlist_not_found: 'not_found',
  playlist_dynamic: 'dynamic',
  playlist_read_only: 'read_only',
};

/** The answer's name for a playlist problem found at completion. */
const problemOf = (reason: ShareErrorReason | null): PlaylistProblem => (reason ? PROBLEM_OF[reason] : undefined) ?? 'not_found';

/** The song keys an entry brings to a playlist: every song with a title, once. */
export function songKeysOf(entry: Pick<Entry, 'results'>): string[] {
  const songs = Array.isArray(entry.results?.songs) ? entry.results.songs : [];
  const keys = new Set<string>();
  for (const s of songs) {
    if (!s || typeof s.title !== 'string' || !s.title.trim()) continue;
    keys.add(songKey(typeof s.artist === 'string' ? s.artist : '', s.title));
  }
  return [...keys];
}

type FillResult = { ok: true; added: number } | { ok: false; reason: ShareErrorReason };

async function fillPlaylist(entry: Entry, playlistId: string, userId: string, deps: FlowDeps): Promise<FillResult> {
  try {
    const added = await deps.addSongsToPlaylist(playlistId, songKeysOf(entry), userId);
    // null: not the owner any more, or the playlist is gone since the share began
    return added === null ? { ok: false, reason: 'playlist_not_found' } : { ok: true, added };
  } catch (err) {
    if (err instanceof Error && err.message === 'playlist_is_dynamic') return { ok: false, reason: 'playlist_dynamic' };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function shareOptionsOf(intent: Pick<ShareIntent, 'playlistId' | 'shareWith' | 'comment'>): ShareOptions {
  return {
    ...(intent.playlistId ? { playlistId: intent.playlistId } : {}),
    ...(intent.shareWith.length > 0 ? { shareWith: intent.shareWith } : {}),
    ...(intent.comment ? { comment: intent.comment } : {}),
  };
}

async function put(
  deps: FlowDeps,
  base: Omit<NewInboxItem, 'title' | 'body' | 'data'>,
  notice: ShareNotice,
  ring: boolean,
  now: Date,
): Promise<InboxItem> {
  const item = await deps.createInboxItem({ ...base, title: notice.title, body: notice.body, data: notice.data }, now);
  if (ring) await deps.announce(item);
  return item;
}

// ---------------------------------------------------------------------------
// Completing a share
// ---------------------------------------------------------------------------

export interface CompleteOptions {
  /**
   * The user already saw the outcome (the share sheet, for a Spotify or Shazam link): his own notice is stored as
   * read and nobody rings his phone. The recipients are always rung.
   */
  immediate: boolean;
}

export interface CompleteResult {
  playlist: PlaylistOutcome | null;
  playlistProblem: ShareErrorReason | null;
  /** false when another run had already closed this intent. */
  announced: boolean;
}

export async function completeIntent(
  intent: ShareIntent,
  entry: Entry,
  opts: CompleteOptions,
  deps: FlowDeps = realDeps,
  now: Date = new Date(),
): Promise<CompleteResult> {
  const digest = digestEntry(entry);
  let playlist: PlaylistOutcome | null = null;
  let playlistProblem: ShareErrorReason | null = null;

  if (intent.playlistId) {
    // Checked again now: the playlist may have been renamed, deleted or made dynamic since the share began, and a
    // playlist that was never valid is reported here too, AFTER the errors of this link were closed.
    const check = await checkPlaylist(intent.playlistId, intent.userId, deps);
    if (!check.ok) {
      playlistProblem = PLAYLIST_REASON[check.error];
    } else {
      const filled = await fillPlaylist(entry, check.id, intent.userId, deps);
      if (filled.ok) playlist = { id: check.id, name: check.name, added: filled.added };
      else playlistProblem = filled.reason;
    }
  }

  // Whoever closes the intent announces it; a second run (the worker and the Spooty watcher at once) stays silent.
  const owned = await deps.finishIntent(intent.id, 'done', {
    songs: digest.counts.songs,
    ...(playlist ? { playlist } : {}),
    ...(playlistProblem ? { playlistProblem } : {}),
  });
  if (!owned) return { playlist, playlistProblem, announced: false };

  // The same link went through: whatever error it had left in the inbox closes by itself.
  await deps.closeErrorsForLink(intent.userId, entry.sourceUrl, now);

  const result = composeShareResult(digest, playlist);
  await put(
    deps,
    { userId: intent.userId, kind: 'share_result', entryId: entry.id, linkKey: entry.sourceUrl, read: opts.immediate },
    result,
    !opts.immediate,
    now,
  );

  if (playlistProblem) {
    // The share sheet already told him (the answer carries `playlist.error`), so the notice is stored as read and
    // nobody rings; it stays, like every error, until he removes it or the same link goes through with a good playlist.
    const problem = composeShareError(playlistProblem, { sourceUrl: entry.sourceUrl, host: digest.host, options: shareOptionsOf(intent) });
    await put(
      deps,
      { userId: intent.userId, kind: 'share_result', level: 'error', entryId: entry.id, linkKey: entry.sourceUrl, read: true },
      problem,
      false,
      now,
    );
  }

  const received = composeShareReceived(intent.userId, digest);
  for (const to of intent.notifyWith) {
    if (to === intent.userId) continue;
    await put(deps, { userId: to, kind: 'share_received', entryId: entry.id }, received, true, now);
  }
  return { playlist, playlistProblem, announced: true };
}

// ---------------------------------------------------------------------------
// Failing a share
// ---------------------------------------------------------------------------

/**
 * The analysis failed. `final`: it will not be tried again, the intent closes as failed and the error stays in the
 * inbox until the user removes it or the same link goes through. Not final (`retrying`): the server keeps trying by
 * itself, the intent stays open, and the same error closes when the link finally succeeds.
 */
async function failIntent(
  intent: ShareIntent,
  entry: Entry | null,
  reason: ShareErrorReason,
  mode: 'final' | 'retrying',
  deps: FlowDeps,
  now: Date,
): Promise<void> {
  if (mode === 'final' && !(await deps.finishIntent(intent.id, 'failed', { reason }))) return;
  const linkKey = entry?.sourceUrl ?? intent.sourceUrl;
  // one error per link: a newer one replaces the older (a "retrying" notice becomes the final one)
  await deps.closeErrorsForLink(intent.userId, linkKey, now);
  const notice = composeShareError(reason, {
    sourceUrl: linkKey,
    host: entry ? digestEntry(entry).host : null,
    options: shareOptionsOf(intent),
    retrying: mode === 'retrying',
  });
  await put(deps, { userId: intent.userId, kind: 'share_result', level: 'error', entryId: intent.entryId, linkKey }, notice, true, now);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface RegisterShareInput {
  entry: Entry;
  /** The inbox user of the sender. */
  sender: string;
  kind: 'spotify' | 'shazam' | 'generic';
  options: ShareRequestOptions;
  comment: string | null;
}

export type PlaylistReport =
  | { id: string; name: string; added: number | 'pending' }
  | { id: string; error: PlaylistProblem };

export interface RegisterShareResult {
  playlist: PlaylistReport | null;
  /** The recipients that were valid (they have the entry now). */
  sharedWith: string[];
}

const hasSongs = (entry: Entry): boolean => songKeysOf(entry).length > 0;

/**
 * Called by `POST /api/share` once the link is stored: shares the entry with the family at once (it shows up in
 * their SoundReel immediately), validates the playlist, records the intent, and — when the entry already holds its
 * songs (Spotify, Shazam) — completes it right away. A generic link completes when its analysis ends.
 */
export async function registerShare(
  input: RegisterShareInput,
  deps: FlowDeps = realDeps,
  now: Date = new Date(),
): Promise<RegisterShareResult> {
  const { entry, sender, options } = input;
  // The entry is theirs at once (it shows up in their SoundReel); the NOTICE goes to the ones never told about it: a share
  // that failed the first time and works the second would otherwise tell nobody, the recipients having the entry already.
  let toNotify: string[] = [];
  if (options.recipients.length > 0) {
    await deps.addEntryShares(entry.id, options.recipients, sender);
    const told = new Set(await deps.notifiedRecipients(entry.id, options.recipients));
    toNotify = options.recipients.filter((u) => !told.has(u));
  }

  let playlistName: string | null = null;
  let report: PlaylistReport | null = null;
  if (options.playlistId) {
    const check = await checkPlaylist(options.playlistId, sender, deps);
    if (check.ok) playlistName = check.name;
    else report = { id: check.id, error: check.error };
  }

  // The playlist asked for is kept even when it is not usable: completion looks at it again and raises the error
  // AFTER the errors of this link were closed (an error raised here would be closed by the very completion that
  // follows), carrying the options as they were asked.
  const intent = await deps.upsertPendingIntent({
    entryId: entry.id,
    userId: sender,
    sourceUrl: entry.sourceUrl,
    playlistId: options.playlistId,
    shareWith: options.recipients,
    notifyWith: toNotify,
    comment: input.comment,
  });

  const ready = input.kind !== 'generic' && hasSongs(entry);
  if (ready) {
    const done = await completeIntent(intent, entry, { immediate: true }, deps, now);
    if (options.playlistId) {
      report = done.playlist
        ? { id: done.playlist.id, name: done.playlist.name, added: done.playlist.added }
        : { id: options.playlistId, error: problemOf(done.playlistProblem) };
    }
  } else if (options.playlistId && playlistName && !report) {
    report = { id: options.playlistId, name: playlistName, added: 'pending' };
  }

  return { playlist: report, sharedWith: options.recipients };
}

/**
 * The analysis job ended. A good result completes every share waiting on the entry; a failure with no retry left
 * (or a result the AI could not read) turns them into errors. Never throws: the job is already done.
 */
export async function onAnalysisFinished(
  entryId: string,
  outcome: { ok: true } | { ok: false; reason: ShareErrorReason },
  deps: FlowDeps = realDeps,
  now: Date = new Date(),
): Promise<void> {
  try {
    const intents = await deps.pendingIntentsForEntry(entryId);
    if (intents.length === 0) return;
    const entry = await deps.getEntry(entryId);
    for (const intent of intents) {
      if (outcome.ok && entry) await completeIntent(intent, entry, { immediate: false }, deps, now);
      else await failIntent(intent, entry, outcome.ok ? 'analysis_failed' : outcome.reason, 'final', deps, now);
    }
  } catch (err) {
    logWarning('share completion failed (the job is done anyway)', { entryId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** The analysis failed but the queue will try again: tell the sender now, close the notice when it finally works. */
export async function onAnalysisRetrying(
  entryId: string,
  reason: ShareErrorReason,
  deps: FlowDeps = realDeps,
  now: Date = new Date(),
): Promise<void> {
  try {
    const intents = await deps.pendingIntentsForEntry(entryId);
    if (intents.length === 0) return;
    const entry = await deps.getEntry(entryId);
    for (const intent of intents) await failIntent(intent, entry, reason, 'retrying', deps, now);
  } catch (err) {
    logWarning('share retry notice failed', { entryId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * A Spotify link whose tracks were not known at share time: the Spooty watcher calls this when they arrive, and the
 * waiting share (playlist, recipients' notice) completes. Does nothing while the entry still has no song.
 */
export async function onEntrySongsAvailable(entryId: string, deps: FlowDeps = realDeps, now: Date = new Date()): Promise<void> {
  try {
    const intents = await deps.pendingIntentsForEntry(entryId);
    if (intents.length === 0) return;
    const entry = await deps.getEntry(entryId);
    if (!entry || !hasSongs(entry)) return;
    for (const intent of intents) await completeIntent(intent, entry, { immediate: false }, deps, now);
  } catch (err) {
    logWarning('share completion on songs failed', { entryId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** An open intent this old with no job left is looked at again (the job usually finishes in under a minute). */
export const STUCK_AFTER_MS = 10 * 60 * 1000;

/**
 * The safety net that makes the flow restart-safe: a share whose analysis ended before its intent was recorded (a job
 * that finished in the few milliseconds between the queue and the intent), or whose process stopped between the job and
 * the announcement, would stay open forever. Every few minutes the open intents with no job left are completed from
 * the entry as it is now — or failed when the entry ended in error. An entry still being worked on is left alone.
 * Returns how many were closed. Never throws.
 */
export async function resolveStuckIntents(deps: FlowDeps = realDeps, now: Date = new Date()): Promise<number> {
  let closed = 0;
  try {
    for (const intent of await deps.stuckIntents(new Date(now.getTime() - STUCK_AFTER_MS))) {
      try {
        const entry = await deps.getEntry(intent.entryId);
        if (!entry) continue;
        if (entry.status === 'completed') {
          await completeIntent(intent, entry, { immediate: false }, deps, now);
          closed += 1;
        } else if (entry.status === 'error') {
          await failIntent(intent, entry, 'analysis_failed', 'final', deps, now);
          closed += 1;
        }
      } catch (err) {
        logWarning('stuck share not resolved (tried again later)', { intent: intent.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    logWarning('stuck shares not read', { error: err instanceof Error ? err.message : String(err) });
  }
  return closed;
}

/** A Shazam page that cannot be read: the link is stored in error, and the error stays until the link is sent again. */
export async function recordShareError(
  input: { userId: string; entry: Pick<Entry, 'id' | 'sourceUrl'>; reason: ShareErrorReason; options: ShareOptions },
  deps: Pick<FlowDeps, 'createInboxItem' | 'closeErrorsForLink'> = realDeps,
  now: Date = new Date(),
): Promise<void> {
  const notice = composeShareError(input.reason, { sourceUrl: input.entry.sourceUrl, options: input.options });
  await deps.closeErrorsForLink(input.userId, input.entry.sourceUrl, now);
  // the sheet shows the error right now: stored as read, it stays there until removed or fixed
  await deps.createInboxItem(
    { userId: input.userId, kind: 'share_result', level: 'error', title: notice.title, body: notice.body, entryId: input.entry.id, linkKey: input.entry.sourceUrl, data: notice.data, read: true },
    now,
  );
}
