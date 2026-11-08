/**
 * Batch operations of the playlist manager (copy / move / remove / undo / reorder).
 *
 * The backend adds and removes ONE song per call (and numbers positions server-side), so a batch is a
 * sequential run with progress. It never fails silently: every song ends up in exactly one bucket
 * (added, already there, removed, failed with its reason, or not attempted because the run was aborted
 * after repeated failures), and a one-level undo plan is built from what really succeeded.
 */
import type { PlaylistDetail } from '../types';

/** The three playlist calls the manager needs; the page wires them to services/api.ts. */
export interface PlaylistApi {
  add(playlistId: string, songKey: string): Promise<PlaylistDetail>;
  remove(playlistId: string, songKey: string): Promise<PlaylistDetail>;
  reorder(playlistId: string, songKeys: string[]): Promise<PlaylistDetail>;
}

export type OpKind = 'copy' | 'move' | 'remove' | 'undo';

export interface Progress {
  op: OpKind;
  done: number;
  total: number;
  key: string | null;
}

export type ProgressFn = (p: Progress) => void;

export interface FailedItem {
  key: string;
  error: string;
  /** Which call failed (a move runs an add phase and a remove phase). */
  step: 'add' | 'remove' | 'reorder';
}

export interface BatchResult {
  ok: string[];
  failed: Array<{ key: string; error: string }>;
  notAttempted: string[];
  /** The playlist as returned by the last successful call. */
  last: PlaylistDetail | null;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // The backend answers JSON ({"error":"playlist not found"}); show just the message.
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* not JSON */
  }
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

/**
 * Runs `worker` for every key, one at a time. After `maxConsecutiveFailures` failures in a row (backend down,
 * permission refused…) the rest is reported as `notAttempted` instead of failing a hundred more times.
 */
export async function runBatch(
  keys: readonly string[],
  worker: (key: string) => Promise<PlaylistDetail>,
  opts: {
    onStep?: (done: number, key: string) => void;
    maxConsecutiveFailures?: number;
  } = {},
): Promise<BatchResult> {
  const max = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const result: BatchResult = { ok: [], failed: [], notAttempted: [], last: null };
  let consecutive = 0;

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (consecutive >= max) {
      result.notAttempted.push(...keys.slice(i));
      break;
    }
    try {
      result.last = await worker(key);
      result.ok.push(key);
      consecutive = 0;
    } catch (err) {
      result.failed.push({ key, error: errorMessage(err) });
      consecutive += 1;
    }
    opts.onStep?.(i + 1, key);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface CopyPlan {
  toAdd: string[];
  alreadyThere: string[];
}

/** Which of `keys` still need adding to a playlist that currently holds `targetKeys`. */
export function planCopy(keys: readonly string[], targetKeys: readonly string[]): CopyPlan {
  const present = new Set(targetKeys);
  const seen = new Set<string>();
  const toAdd: string[] = [];
  const alreadyThere: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    (present.has(key) ? alreadyThere : toAdd).push(key);
  }
  return { toAdd, alreadyThere };
}

/** Moves every selected element one step up (-1) or down (+1), keeping their relative order; blocks stop at the edge. */
export function moveBlock(order: readonly string[], selected: ReadonlySet<string>, dir: -1 | 1): string[] {
  const out = [...order];
  if (dir === -1) {
    for (let i = 1; i < out.length; i += 1) {
      if (selected.has(out[i]) && !selected.has(out[i - 1])) [out[i - 1], out[i]] = [out[i], out[i - 1]];
    }
  } else {
    for (let i = out.length - 2; i >= 0; i -= 1) {
      if (selected.has(out[i]) && !selected.has(out[i + 1])) [out[i + 1], out[i]] = [out[i], out[i + 1]];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export type UndoStep =
  | { kind: 'remove'; playlistId: string; keys: string[] }
  /** Adds the songs back; `restoreOrder` then rewrites the playlist order as it was. */
  | { kind: 'add'; playlistId: string; keys: string[]; restoreOrder?: string[] };

export interface UndoPlan {
  steps: UndoStep[];
}

export interface UndoOutcome {
  failed: FailedItem[];
  notAttempted: string[];
  /** Latest known state of every playlist the undo touched. */
  details: Record<string, PlaylistDetail>;
}

export async function executeUndo(api: PlaylistApi, plan: UndoPlan, onProgress?: ProgressFn): Promise<UndoOutcome> {
  const total = plan.steps.reduce((n, s) => n + s.keys.length, 0);
  let done = 0;
  const outcome: UndoOutcome = { failed: [], notAttempted: [], details: {} };

  for (const step of plan.steps) {
    const res = await runBatch(
      step.keys,
      (key) => (step.kind === 'remove' ? api.remove(step.playlistId, key) : api.add(step.playlistId, key)),
      { onStep: (_n, key) => { done += 1; onProgress?.({ op: 'undo', done, total, key }); } },
    );
    for (const f of res.failed) outcome.failed.push({ ...f, step: step.kind });
    outcome.notAttempted.push(...res.notAttempted);
    if (res.last) outcome.details[step.playlistId] = res.last;

    if (step.kind === 'add' && step.restoreOrder && res.ok.length > 0) {
      try {
        outcome.details[step.playlistId] = await api.reorder(step.playlistId, step.restoreOrder);
      } catch (err) {
        outcome.failed.push({ key: '(order)', error: errorMessage(err), step: 'reorder' });
      }
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface OpOutcome {
  op: 'copy' | 'move' | 'remove';
  /** Distinct songs the user asked for. */
  requested: number;
  added: string[];
  alreadyThere: string[];
  removed: string[];
  failed: FailedItem[];
  notAttempted: string[];
  sourceId: string | null;
  targetId: string | null;
  /** Latest playlist states returned by the backend (no extra GET needed). */
  source: PlaylistDetail | null;
  target: PlaylistDetail | null;
  undo: UndoPlan | null;
  /** The keys a "retry errors" would run again (failed + not attempted of the first failing phase). */
  retryKeys: string[];
}

function emptyOutcome(op: OpOutcome['op'], requested: number): OpOutcome {
  return {
    op,
    requested,
    added: [],
    alreadyThere: [],
    removed: [],
    failed: [],
    notAttempted: [],
    sourceId: null,
    targetId: null,
    source: null,
    target: null,
    undo: null,
    retryKeys: [],
  };
}

const unique = (keys: readonly string[]): string[] => [...new Set(keys)];

/** F5: add the songs to the target playlist (the ones already there are skipped, not duplicated). */
export async function executeCopy(
  api: PlaylistApi,
  args: { targetId: string; keys: readonly string[]; targetKeys: readonly string[]; onProgress?: ProgressFn },
): Promise<OpOutcome> {
  const keys = unique(args.keys);
  const plan = planCopy(keys, args.targetKeys);
  const outcome = emptyOutcome('copy', keys.length);
  outcome.targetId = args.targetId;
  outcome.alreadyThere = plan.alreadyThere;

  const res = await runBatch(plan.toAdd, (k) => api.add(args.targetId, k), {
    onStep: (done, key) => args.onProgress?.({ op: 'copy', done, total: plan.toAdd.length, key }),
  });
  outcome.added = res.ok;
  outcome.failed = res.failed.map((f) => ({ ...f, step: 'add' as const }));
  outcome.notAttempted = res.notAttempted;
  outcome.target = res.last;
  outcome.retryKeys = [...res.failed.map((f) => f.key), ...res.notAttempted];
  if (res.ok.length > 0) outcome.undo = { steps: [{ kind: 'remove', playlistId: args.targetId, keys: res.ok }] };
  return outcome;
}

/**
 * F6: copy first, then remove from the source ONLY what is now safely in the target (added or already there),
 * so a failure can never lose a song.
 */
export async function executeMove(
  api: PlaylistApi,
  args: {
    sourceId: string;
    targetId: string;
    keys: readonly string[];
    /** Source playlist order before the move (used to restore it on undo). */
    sourceKeys: readonly string[];
    targetKeys: readonly string[];
    onProgress?: ProgressFn;
  },
): Promise<OpOutcome> {
  const keys = unique(args.keys);
  const plan = planCopy(keys, args.targetKeys);
  const outcome = emptyOutcome('move', keys.length);
  outcome.sourceId = args.sourceId;
  outcome.targetId = args.targetId;
  outcome.alreadyThere = plan.alreadyThere;

  const added = await runBatch(plan.toAdd, (k) => api.add(args.targetId, k), {
    onStep: (done, key) => args.onProgress?.({ op: 'move', done, total: plan.toAdd.length + keys.length, key }),
  });
  outcome.added = added.ok;
  outcome.target = added.last;
  outcome.failed.push(...added.failed.map((f) => ({ ...f, step: 'add' as const })));
  outcome.notAttempted = added.notAttempted;

  const safe = keys.filter((k) => added.ok.includes(k) || plan.alreadyThere.includes(k));
  const removed = await runBatch(safe, (k) => api.remove(args.sourceId, k), {
    onStep: (done, key) =>
      args.onProgress?.({ op: 'move', done: plan.toAdd.length + done, total: plan.toAdd.length + safe.length, key }),
  });
  outcome.removed = removed.ok;
  outcome.source = removed.last;
  outcome.failed.push(...removed.failed.map((f) => ({ ...f, step: 'remove' as const })));
  outcome.notAttempted.push(...removed.notAttempted);
  outcome.retryKeys = unique([
    ...added.failed.map((f) => f.key),
    ...added.notAttempted,
    ...removed.failed.map((f) => f.key),
    ...removed.notAttempted,
  ]);

  const steps: UndoStep[] = [];
  if (added.ok.length > 0) steps.push({ kind: 'remove', playlistId: args.targetId, keys: added.ok });
  if (removed.ok.length > 0) {
    steps.push({ kind: 'add', playlistId: args.sourceId, keys: removed.ok, restoreOrder: [...args.sourceKeys] });
  }
  if (steps.length > 0) outcome.undo = { steps };
  return outcome;
}

/** F8: remove the songs from a playlist. */
export async function executeRemove(
  api: PlaylistApi,
  args: { playlistId: string; keys: readonly string[]; sourceKeys: readonly string[]; onProgress?: ProgressFn },
): Promise<OpOutcome> {
  const keys = unique(args.keys);
  const outcome = emptyOutcome('remove', keys.length);
  outcome.sourceId = args.playlistId;

  const res = await runBatch(keys, (k) => api.remove(args.playlistId, k), {
    onStep: (done, key) => args.onProgress?.({ op: 'remove', done, total: keys.length, key }),
  });
  outcome.removed = res.ok;
  outcome.source = res.last;
  outcome.failed = res.failed.map((f) => ({ ...f, step: 'remove' as const }));
  outcome.notAttempted = res.notAttempted;
  outcome.retryKeys = [...res.failed.map((f) => f.key), ...res.notAttempted];
  if (res.ok.length > 0) {
    outcome.undo = {
      steps: [{ kind: 'add', playlistId: args.playlistId, keys: res.ok, restoreOrder: [...args.sourceKeys] }],
    };
  }
  return outcome;
}

/** True when the outcome has anything the user must look at. */
export function hasProblems(outcome: Pick<OpOutcome, 'failed' | 'notAttempted'>): boolean {
  return outcome.failed.length > 0 || outcome.notAttempted.length > 0;
}
