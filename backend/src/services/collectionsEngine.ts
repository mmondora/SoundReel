/**
 * The engine of the collections (Raccolte, task 7; spec 2026-11-09-library-collections-auto-topics-design.md §5, §9; ADR-0022): the nightly CONSOLIDATION that
 * turns the vectors of a user into collections, the FAST LANE that puts one new entry in the collections it is close to, and the PREVIEW of a pass that writes
 * nothing. The rules are the pure ones of `collectionsCluster.ts` (the same pipeline the calibration of phase 0 used, `discoverCollections`), the names come
 * from `collectionsNaming.ts` (the local model proposes, the code decides), the store is `collectionsStore.ts`; the facts the store does not hold (what a post
 * says, whether it has songs from the content or films) come in through `deps.features`. Nothing here is a module-level side effect: every dependency is handed
 * in, so the tests run with the in-memory store, a fake namer and synthetic vectors.
 *
 * What a pass does, in order (and why):
 *  1. reads the vectors of the user (his entries and those shared with him) in the order of the dates, leaves out the ones whose length is not the usual one
 *     (a vector of an older model), centres them on the library mean and finds the groups of at least 3 entries (`watchingSize`: 3-4 are only «watching»);
 *  2. a group that is music or films is that TYPE and a group that is not tight is not published (`discoverCollections`); a big group gives children;
 *  3. each group inherits id AND name of the existing collection that holds at least half of the OLD members (`matchToExisting`: no collection «dances»); the
 *     groups of the top level are matched first, so that a group can never take the id of a child; the hidden and the merged ones are matched like the others,
 *     or the group would be born again as a new collection the day after the user hid or merged it;
 *  4. each group that needs a name is named (one call to the model, in order of size, so that the names already chosen are told to the model): a name given by
 *     the user is never touched; a name of the engine stays while the group is the same one (`IDENTITY_SHARE`); a group that cannot be named is not published
 *     (`watching`, `UNNAMED`) and is tried again the night after;
 *  5. groups with the same name and almost the same centre are one (`mergeSame`); two groups that still have the same name give it to ONE (the user's, then the
 *     one that already holds it, then the larger) and the other stays unnamed;
 *  6. each group is born at 5 entries, stays at 3 and 4 if it was active, is gone below 3 (`decideState`); an unnamed one is never published;
 *  7. every entry joins at most two themes (`assignToThemes`), its own group always; the children keep their own members and the parent holds them too; the
 *     entries about music or films that the assignment adds join a theme only while it stays under the bar that makes a group a type (`withinTypeBar`);
 *  8. the corrections of the user are applied LAST: an entry taken out never comes back (it takes the next theme), an entry put in stays, a renamed collection keeps
 *     its name, a hidden one stays hidden, a merged one keeps feeding the collection it was merged into;
 *  9. everything is saved in ONE transaction (`store.saveCollections`).
 * Two passes on the same data give the same ids, names and members (nothing flickers) and the second one asks the model nothing.
 *
 * Passes and fast lanes never overlap (one lock for the process): the fast lane rewrites the members of a collection, the pass rewrites them all.
 */
import { randomUUID } from 'crypto';
import { logInfo } from '../utils/logger';
import {
  assignThemes,
  assignToThemes,
  centerAndNormalize,
  centerOne,
  cleanName,
  cosine,
  decideState,
  discoverCollections,
  matchToExisting,
  mergeSame,
  normalizeVector,
  withinTypeBar,
  type Candidate,
  type Group,
} from './collectionsCluster';
import { COLLECTION_PARAMS, type CollectionParams } from './collectionsParams';
import { NAMEABLE_SEEDS, chooseName, nameGroup as nameWithModel, seedGroupOf, type NamedGroup, type NamingGroup, type NamingMember } from './collectionsNaming';
import type { CollectionInput, CollectionOrigin, CollectionRow, CollectionState, CollectionsStore, StoredVector } from './collectionsStore';

/** The name a group that cannot be named yet has in the table (a name is required there); it is never shown: such a collection is only «watching». */
export const UNNAMED = 'Senza nome';

/**
 * The second round of inheritance, for a collection that was the UNION of several groups (the same name and close centres: `mergeSame`) or that split in three:
 * none of the groups is half of it, so the rule of the spec (half of the OLD members) gives the id to nobody and the collection, with its name and the
 * corrections the user made on it, would be born again every night. A group that is mostly inside the old collection (`RELAXED_NEW_SHARE`) and is at least a
 * quarter of it (`RELAXED_OLD_SHARE`) takes it, the largest overlap first; a small group that merely lies inside a big collection never does.
 */
export const RELAXED_OLD_SHARE = 0.25;
export const RELAXED_NEW_SHARE = 0.5;

/**
 * A name the engine gave stays while the group is the same one: when the old members are at least this share of the NEW group. Inheriting needs half of the
 * OLD members; this is the other side, a group that grew to four times its size by taking in other things is asked its name again.
 */
export const IDENTITY_SHARE = 0.25;

/** A name as the engine compares them: no case, no accents, no punctuation and NO SPACES (`Claude Code` and `ClaudeCode` are one name). */
const nameKey = (name: string): string => cleanName(name).replace(/ /g, '');

/** Edit distance (insertions, deletions, substitutions) between two short strings. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length];
}

/** A name this near to a name of the list (at most 2 letters apart, and long enough for that to mean a misspelling) IS that name: «Intelligence Artificiale». */
export const SNAP_MIN_LENGTH = 8;
export const SNAP_MAX_DISTANCE = 2;

function snapToSeed(name: string): string {
  const key = nameKey(name);
  if (key.length < SNAP_MIN_LENGTH) return name;
  for (const seed of NAMEABLE_SEEDS) if (editDistance(key, nameKey(seed.name)) <= SNAP_MAX_DISTANCE) return seed.name;
  return name;
}

/** What the engine asks to know about each entry (the store holds the vectors, not this). */
export interface EntryFeatures {
  /** What the post says (the summary, else the caption): the model is shown it and the evidence of a name is looked for in it. */
  text: string;
  tags: string[];
  /** The entry has songs from the CONTENT of the post (never the audio fingerprint of the background track): it talks about music. */
  hasContentSongs: boolean;
  hasFilms: boolean;
}

export interface EngineDeps {
  store: CollectionsStore;
  /** The facts about these entries, in one question; an entry that is missing is read as «says nothing». */
  features: (userId: string, entryIds: string[]) => Promise<Map<string, EntryFeatures>>;
  /** One question to the local model (`nameGroup`); null when there is no name. May throw: it is read as null. */
  nameGroup: (group: NamingGroup) => Promise<NamedGroup | null>;
  /** The id of a collection that is born. */
  newId: () => string;
  /** The numbers of the discovery (default: the calibrated ones). */
  params?: CollectionParams;
}

/** A collection as a pass decides it (and, for a real pass, saves it). */
export interface PlannedCollection {
  /** The id it has or will have (in a preview a placeholder `new:<n>` for a collection that does not exist yet: see `isNew`). */
  id: string;
  /** The collection does not exist yet: the pass makes it. */
  isNew: boolean;
  name: string;
  nameBy: 'auto' | 'user';
  /** The name it had before this pass; null for a new one. */
  previousName: string | null;
  groupLabel: string | null;
  parentId: string | null;
  /** What the pass decides. */
  state: 'active' | 'watching';
  /** What the store will keep: a hidden or merged collection stays so, whatever the pass decides. */
  effectiveState: CollectionState;
  origin: CollectionOrigin;
  kind: 'group' | 'child';
  centroid: Float32Array;
  coherence: number | null;
  /** The best first. */
  members: Array<{ entryId: string; score: number }>;
}

export interface ConsolidationResult {
  userId: string;
  /** Entries that have a vector of the usual length. */
  entries: number;
  /** Vectors of another length, left out. */
  skippedDimensions: number;
  collections: PlannedCollection[];
  /** Active and named. */
  published: number;
  watching: number;
  created: number;
  inherited: number;
  /** Questions asked to the model. */
  modelCalls: number;
  /** Existing collections that no group stands behind any more (the store deletes them, or keeps the ones the user touched). */
  dropped: number;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the lock
// ---------------------------------------------------------------------------------------------------------------------------------------------------

let tail: Promise<unknown> = Promise.resolve();

/** One at a time, in the order they ask: a failure of one does not stop the next. */
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(() => job());
  tail = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The vectors that have the length most of them have (a vector of an older model has another); the rest are counted and left out. */
function usableVectors(stored: StoredVector[]): { kept: StoredVector[]; skipped: number } {
  const lengths = new Map<number, number>();
  for (const v of stored) lengths.set(v.vector.length, (lengths.get(v.vector.length) ?? 0) + 1);
  let usual = -1;
  let most = 0;
  for (const [length, count] of lengths) {
    if (count > most || (count === most && length > usual)) {
      usual = length;
      most = count;
    }
  }
  const kept = stored.filter((v) => v.vector.length === usual);
  return { kept, skipped: stored.length - kept.length };
}

function centreOf(ids: string[], vectors: Map<string, Float32Array>): Float32Array | null {
  const present = ids.map((id) => vectors.get(id)).filter((v): v is Float32Array => v !== undefined);
  if (present.length === 0) return null;
  const sum = new Float64Array(present[0].length);
  for (const v of present) for (let k = 0; k < sum.length; k += 1) sum[k] += v[k];
  return normalizeVector(sum);
}

/** @internal exported for the tests of the rules of inheritance */
export interface Existing {
  row: CollectionRow;
  /** The automatic members: the ones the grouping found (what an old collection is made of for the overlap). */
  auto: string[];
}

/** One working collection while a pass decides. @internal exported for the tests of the rules of inheritance */
export interface Cand {
  index: number;
  kind: 'group' | 'child';
  parent: number | null;
  group: Group;
  old: Existing | null;
  /** The collection this one was merged into by the user, when the old one is `merged` (a merged collection is an alias that feeds its target). */
  aliasOf: string | null;
  name: string | null;
  nameBy: 'auto' | 'user';
  id: string;
  isNew: boolean;
  /** Folded into another by `mergeSame`. */
  folded: boolean;
  state: 'active' | 'watching' | 'gone';
  members: Map<string, number>;
}

/**
 * Groups with the same name (spaces, case and accents do not count) and almost the same centre are ONE collection (spec §5.6, `mergeSame`): the larger stays and
 * the others are `folded` into it. What the one that stays takes from them: the old collection they were (so the id and the name are not lost), the children
 * (a child of a folded group is now a child of the one that stays), and the entries (the union, with a new centre and the coherence of the union on it). A
 * merged collection of the user (an alias) is never folded. Changes the candidates in place.
 * @internal exported for the tests
 */
export function foldSameName(cands: Cand[], vectorOf: Map<string, Float32Array>): void {
  const mergeable = cands.filter((c) => c.name !== null && c.aliasOf === null);
  const merged = mergeSame(mergeable.map((c) => ({ id: String(c.index), name: nameKey(c.name as string), centroid: c.group.centroid, memberIds: c.group.members })));
  for (const m of merged) {
    if (m.mergedIds.length === 0) continue;
    const keeper = cands[Number(m.id)];
    for (const gone of m.mergedIds.map((id) => cands[Number(id)])) {
      gone.folded = true;
      keeper.old = keeper.old ?? gone.old;
      if (keeper.old && keeper.isNew) {
        keeper.id = keeper.old.row.id;
        keeper.isNew = false;
      }
      for (const child of cands) if (child.parent === gone.index) child.parent = keeper.index;
    }
    const members = [...m.memberIds];
    const vectors = members.map((id) => vectorOf.get(id) as Float32Array);
    keeper.group = { members, centroid: m.centroid, vectors, coherence: vectors.reduce((t, v) => t + cosine(v, m.centroid), 0) / vectors.length };
  }
}

/** The collection a merged one went into, following the merges to the end; null when the chain is broken (the target is gone) or goes round. @internal exported for the tests */
export function resolveTarget(row: CollectionRow, byId: Map<string, Existing>): string | null {
  let current = row;
  const seen = new Set<string>();
  while (current.state === 'merged') {
    if (!current.parentId || seen.has(current.id)) return null;
    seen.add(current.id);
    const next = byId.get(current.parentId)?.row;
    if (!next) return null;
    current = next;
  }
  return current.id;
}

/**
 * `matchToExisting` for the candidates that are still without an id, against the existing collections that are still free. A candidate is recognised by what it
 * HOLDS (`holds`), not only by its own entries: an old collection is made of the entries of its group AND the ones the assignment added, so a group of 8 that
 * held 40 would otherwise never be half of it and would be born again every night.
 */
function inherit(cands: Cand[], holds: (c: Cand) => string[], pool: Existing[], taken: Set<string>, params: CollectionParams): void {
  const free = pool.filter((e) => !taken.has(e.row.id));
  if (cands.length === 0 || free.length === 0) return;
  const matched = matchToExisting(cands.map((c) => ({ ...c.group, members: holds(c) })), free.map((e) => ({ id: e.row.id, memberIds: e.auto })), params);
  matched.forEach((m, i) => {
    if (m.inheritsId === null) return;
    cands[i].old = free.find((e) => e.row.id === m.inheritsId) as Existing;
    taken.add(m.inheritsId);
  });
}

/** The second round (see `RELAXED_OLD_SHARE`): the candidates that are still without an id, against the existing collections that are still free. @internal exported for its tests */
export function inheritRelaxed(cands: Cand[], holds: (c: Cand) => string[], pool: Existing[], taken: Set<string>): void {
  const pairs: Array<{ cand: Cand; old: Existing; overlap: number }> = [];
  for (const cand of cands) {
    const held = holds(cand);
    for (const old of pool) {
      if (old.auto.length === 0) continue;
      const members = new Set(old.auto);
      const overlap = held.filter((m) => members.has(m)).length;
      if (overlap > 0 && overlap >= RELAXED_OLD_SHARE * old.auto.length - 1e-9 && overlap >= RELAXED_NEW_SHARE * held.length - 1e-9) pairs.push({ cand, old, overlap });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap || a.cand.index - b.cand.index || (a.old.row.id < b.old.row.id ? -1 : a.old.row.id > b.old.row.id ? 1 : 0));
  for (const { cand, old } of pairs) {
    if (cand.old || taken.has(old.row.id)) continue;
    cand.old = old;
    taken.add(old.row.id);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the plan: every decision of a pass, with nothing written
// ---------------------------------------------------------------------------------------------------------------------------------------------------

interface Plan {
  entries: number;
  skippedDimensions: number;
  collections: PlannedCollection[];
  created: number;
  inherited: number;
  modelCalls: number;
  dropped: CollectionRow[];
}

async function plan(userId: string, deps: EngineDeps, makeId: () => string): Promise<Plan> {
  const params = deps.params ?? COLLECTION_PARAMS;
  const { store } = deps;
  const stored = await store.vectorsOf(userId);
  const { kept, skipped } = usableVectors(stored);
  const existingRows = await store.listCollections(userId);
  const corrections = await store.corrections(userId);
  const existing: Existing[] = [];
  for (const row of existingRows) {
    const members = await store.membersOf(row.id);
    existing.push({ row, auto: members.filter((m) => m.source === 'auto').map((m) => m.entryId) });
  }
  const existingById = new Map(existing.map((e) => [e.row.id, e]));
  const removed = new Set(corrections.removed.map((r) => `${r.collectionId}|${r.entryId}`));

  // 1. the vectors, centred on the library mean
  const { vectors: centred } = centerAndNormalize(kept.map((v) => v.vector));
  const items = kept.map((v, i) => ({ id: v.entryId, vector: centred[i] }));
  const vectorOf = new Map(items.map((it) => [it.id, it.vector]));
  const features = items.length > 0 ? await deps.features(userId, items.map((it) => it.id)) : new Map<string, EntryFeatures>();
  const featureOf = (id: string): EntryFeatures => features.get(id) ?? { text: '', tags: [], hasContentSongs: false, hasFilms: false };
  const musicIds = items.filter((it) => featureOf(it.id).hasContentSongs).map((it) => it.id);
  const filmIds = items.filter((it) => featureOf(it.id).hasFilms).map((it) => it.id);

  // 2. the groups that can be collections
  const found = discoverCollections(
    items,
    { typeCentres: { music: centreOf(musicIds, vectorOf), films: centreOf(filmIds, vectorOf) }, flagged: { music: new Set(musicIds), films: new Set(filmIds) } },
    params,
    params.watchingSize,
  );
  const cands: Cand[] = found.candidates.map((c: Candidate, index) => ({
    index,
    kind: c.kind,
    parent: c.parent,
    group: c.group,
    old: null,
    aliasOf: null,
    name: null,
    nameBy: 'auto',
    id: '',
    isNew: true,
    folded: false,
    state: 'watching',
    members: new Map(),
  }));

  // 3. ids and names are inherited: the top level first, so that a group never takes the id of a child. What a group holds is its own entries and the ones the
  // assignment would add (the same assignment the pass makes below, here among every top group: it only has to recognise the old collection)
  const tops = cands.filter((c) => c.kind === 'group');
  const added = assignToThemes(items, tops.map((c) => ({ id: String(c.index), centroid: c.group.centroid })), params);
  const holds = (c: Cand): string[] => (c.kind === 'group' ? [...new Set([...c.group.members, ...(added.get(String(c.index)) ?? []).map((m) => m.entryId)])] : c.group.members);
  const taken = new Set<string>();
  const kids = cands.filter((c) => c.kind === 'child');
  const topPool = existing.filter((e) => e.row.parentId === null || e.row.state === 'merged');
  inherit(tops, holds, topPool, taken, params);
  inherit(kids, holds, existing, taken, params);
  inheritRelaxed(tops, holds, topPool, taken);
  inheritRelaxed(kids, holds, existing, taken);
  for (const c of cands) {
    if (c.old) {
      c.id = c.old.row.id;
      c.isNew = false;
      if (c.old.row.state === 'merged') c.aliasOf = resolveTarget(c.old.row, existingById);
    } else {
      c.id = makeId();
    }
  }
  const inheritedCount = cands.filter((c) => c.old).length;

  // 4. the names
  let modelCalls = 0;
  const inUse = new Map<string, string>();
  for (const e of existing) if (e.row.state !== 'merged' && e.row.name !== UNNAMED) inUse.set(nameKey(e.row.name), e.row.name);
  const namingMember = (id: string): NamingMember => ({ text: featureOf(id).text, tags: featureOf(id).tags });
  const identityKept = (c: Cand): boolean => {
    if (!c.old) return false;
    const old = new Set(c.old.auto);
    return c.group.members.filter((m) => old.has(m)).length >= IDENTITY_SHARE * c.group.members.length - 1e-9;
  };
  for (const c of [...cands].sort((a, b) => b.group.members.length - a.group.members.length || a.index - b.index)) {
    const old = c.old?.row ?? null;
    const wantsName = c.group.members.length >= params.birthSize;
    if (old && old.nameBy === 'user') {
      c.name = old.name;
      c.nameBy = 'user';
    } else if (old && old.name !== UNNAMED && (identityKept(c) || !wantsName)) {
      c.name = old.name;
    } else if (wantsName) {
      const others = [...inUse.values()].filter((n) => !old || nameKey(n) !== nameKey(old.name));
      let named: NamedGroup | null = null;
      modelCalls += 1;
      try {
        named = await deps.nameGroup({ members: c.group.members.map(namingMember), existing: others, nameBy: null });
      } catch {
        named = null;                                  // a model that is down or odd is a group without a name tonight
      }
      c.name = named ? snapToSeed(named.name) : null;
      if (c.name) inUse.set(nameKey(c.name), c.name);
    }
  }

  // 5. the same name, almost the same centre: one collection
  foldSameName(cands, vectorOf);
  const live = cands.filter((c) => !c.folded);

  // two different groups with one name: the user's, then the one that already holds it, then the larger, keep it; the others try the tag most of their posts
  // share (spec §5.5 c: the model has had its say), and wait without a name when there is none or it is taken too
  const keyOf = (c: Cand): string => nameKey(c.name as string);
  const bySameName = new Map<string, Cand[]>();
  for (const c of live) {
    if (c.name === null || c.old?.row.state === 'hidden' || c.old?.row.state === 'merged') continue;
    bySameName.set(keyOf(c), [...(bySameName.get(keyOf(c)) ?? []), c]);
  }
  for (const group of bySameName.values()) {
    const rank = (c: Cand): number[] => [c.nameBy === 'user' ? 0 : 1, c.old && nameKey(c.old.row.name) === keyOf(c) ? 0 : 1, -c.group.members.length, c.index];
    const ordered = [...group].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let k = 0; k < ra.length; k += 1) if (ra[k] !== rb[k]) return ra[k] - rb[k];
      return 0;
    });
    for (const loser of ordered.slice(1)) {
      if (loser.nameBy === 'user') continue;
      const byTag = chooseName(null, loser.group.members.map(namingMember));
      const taken = byTag ? [...live].some((o) => o !== loser && o.name !== null && o.aliasOf === null && nameKey(o.name) === nameKey(byTag.name)) : true;
      loser.name = byTag && !taken ? snapToSeed(byTag.name) : null;
    }
  }

  // 6. born, alive or gone
  for (const c of live) {
    // a group stands on its own entries, less the ones the user took out of this collection; the ones he put in change nothing about it (the store keeps them)
    const id = c.old?.row.id ?? '';
    const own = new Set(c.group.members.filter((m) => !removed.has(`${id}|${m}`)));
    const previous = c.old ? 'active' : null;                      // a collection that has a name was active (an unnamed one is only watching whatever its size)
    const decided = decideState(own.size, previous);
    c.state = decided === 'gone' ? 'gone' : c.name === null ? 'watching' : decided;
  }
  const survivors = live.filter((c) => c.state !== 'gone');

  // 7. who is in what: the group itself, and at most two themes per entry among the published ones (the merged ones do not take entries: they feed their target)
  const published = (c: Cand): boolean => c.kind === 'group' && c.name !== null && c.aliasOf === null;           // (a group with a name is active: only one that has none is left watching)
  const themes = survivors.filter(published);
  const joined = assignToThemes(items, themes.map((t) => ({ id: t.id, centroid: t.group.centroid })), params, (entryId, themeId) => removed.has(`${themeId}|${entryId}`));
  const scoreIn = (c: Cand, id: string): number => cosine(vectorOf.get(id) as Float32Array, c.group.centroid);
  const flaggedIds = { music: new Set(musicIds), films: new Set(filmIds) };
  for (const c of survivors) {
    const mine = c.group.members.filter((id) => !removed.has(`${c.id}|${id}`));
    for (const id of mine) c.members.set(id, scoreIn(c, id));
    // what the assignment adds never turns a theme into a type: its own entries were under the bar, the ones that come to it must keep it so
    for (const m of withinTypeBar(mine, joined.get(c.id) ?? [], flaggedIds, params.typeMemberShare)) c.members.set(m.entryId, m.score);
  }
  // (the parent holds the entries of its children without more work: a child is a sub-group of its parent's group, so they are among the parent's own)

  // 8. a merged collection keeps feeding the collection it was merged into
  const planned: PlannedCollection[] = [];
  const byId = new Map<string, PlannedCollection>();
  for (const c of survivors) {
    const old = c.old?.row ?? null;
    const userNamed = c.nameBy === 'user';
    const name = c.name ?? UNNAMED;
    const sorted = [...c.members].map(([entryId, score]) => ({ entryId, score })).sort((a, b) => b.score - a.score || (a.entryId < b.entryId ? -1 : 1));
    const parentCand = c.parent !== null ? cands[c.parent] : null;
    const entry: PlannedCollection = {
      id: c.id,
      isNew: c.isNew,
      name,
      nameBy: c.nameBy,
      previousName: old ? old.name : null,
      groupLabel: userNamed ? old?.groupLabel ?? null : seedGroupOf(name),
      parentId: parentCand && published(parentCand) && parentCand.state === 'active' ? parentCand.id : null,
      state: c.state as 'active' | 'watching',
      effectiveState: old && (old.state === 'hidden' || old.state === 'merged') ? old.state : (c.state as 'active' | 'watching'),
      origin: old?.origin === 'manual' ? 'manual' : c.name !== null && seedGroupOf(name) !== null ? 'seed' : 'found',
      kind: c.kind,
      centroid: c.group.centroid,
      coherence: c.group.coherence ?? null,
      members: sorted,
    };
    planned.push(entry);
    byId.set(c.id, entry);
  }
  for (const c of survivors) {
    if (!c.aliasOf) continue;
    const target = byId.get(c.aliasOf);
    const mine = byId.get(c.id);
    if (!target || !mine) continue;
    const have = new Map(target.members.map((m) => [m.entryId, m]));
    for (const m of mine.members) {
      if (removed.has(`${target.id}|${m.entryId}`)) continue;
      const there = have.get(m.entryId);
      if (!there) target.members.push({ ...m });
      else if (m.score > there.score) there.score = m.score;
    }
    target.members.sort((a, b) => b.score - a.score || (a.entryId < b.entryId ? -1 : 1));
  }

  const used = new Set(survivors.filter((c) => c.old).map((c) => (c.old as Existing).row.id));
  return {
    entries: items.length,
    skippedDimensions: skipped,
    collections: planned,
    created: survivors.filter((c) => c.isNew).length,
    inherited: inheritedCount,
    modelCalls,
    dropped: existingRows.filter((r) => !used.has(r.id)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the three doors
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The nightly pass for one user: decides everything (`plan`) and saves it in one transaction. Passes of the same process never overlap. A pass that fails
 * writes nothing; the next night tries again.
 */
export function consolidate(userId: string, deps: EngineDeps): Promise<ConsolidationResult> {
  return exclusive(async () => {
    const out = await plan(userId, deps, deps.newId);
    const rows: CollectionInput[] = out.collections.map((c) => ({
      id: c.id,
      name: c.name,
      groupLabel: c.groupLabel,
      parentId: c.parentId,
      state: c.state,
      origin: c.origin,
      centroid: c.centroid,
      coherence: c.coherence,
      members: c.members,
    }));
    await deps.store.saveCollections(userId, rows);
    const result: ConsolidationResult = {
      userId,
      entries: out.entries,
      skippedDimensions: out.skippedDimensions,
      collections: out.collections,
      published: out.collections.filter((c) => c.state === 'active' && c.name !== UNNAMED).length,
      watching: out.collections.filter((c) => c.state === 'watching').length,
      created: out.created,
      inherited: out.inherited,
      modelCalls: out.modelCalls,
      dropped: out.dropped.length,
    };
    logInfo(`collections: pass for ${userId} done`, { entries: result.entries, published: result.published, watching: result.watching, created: result.created, inherited: result.inherited, modelCalls: result.modelCalls, dropped: result.dropped });
    return result;
  });
}

export interface PreviewItem {
  /** null: a collection the pass would make. */
  id: string | null;
  name: string;
  size: number;
  state: string;
  memberIds: string[];
}

/** Everything a pass would decide, in detail, and what it would drop: what the script reads to say «new», «renamed», «unchanged». Writes nothing. */
export async function planConsolidation(userId: string, deps: EngineDeps): Promise<{ result: Omit<ConsolidationResult, 'dropped'> & { dropped: CollectionRow[] } }> {
  let temp = 0;
  const out = await plan(userId, deps, () => `new:${++temp}`);
  return {
    result: {
      userId,
      entries: out.entries,
      skippedDimensions: out.skippedDimensions,
      collections: out.collections,
      published: out.collections.filter((c) => c.state === 'active' && c.name !== UNNAMED).length,
      watching: out.collections.filter((c) => c.state === 'watching').length,
      created: out.created,
      inherited: out.inherited,
      modelCalls: out.modelCalls,
      dropped: out.dropped,
    },
  };
}

/**
 * The decisions of a pass, with NOTHING written (the model IS asked: that is how real names are seen): name, size, state and members of each collection; `id`
 * is null for the ones the pass would make. A hidden or merged collection shows as such (what the store keeps), not as what its group would be.
 */
export async function rebuildPreview(userId: string, deps: EngineDeps): Promise<PreviewItem[]> {
  const { result } = await planConsolidation(userId, deps);
  return result.collections.map((c) => ({ id: c.isNew ? null : c.id, name: c.name, size: c.members.length, state: c.effectiveState, memberIds: c.members.map((m) => m.entryId) }));
}

export interface AssignOneDeps {
  store: CollectionsStore;
  /** Adds AUTOMATIC members to existing collections; never removes anything (in the database an insert that leaves what is there alone). */
  addMembers: (userId: string, additions: Array<{ collectionId: string; entryId: string; score: number }>) => Promise<void>;
  params?: CollectionParams;
}

/**
 * The fast lane (spec §5.2): a new entry whose vector is already stored joins the ACTIVE collections of the top level whose centre it is close enough to (at
 * most two, the nearest first), unless it was taken out of one by hand or is already in it. It adds, it never takes away, and it never makes, renames or
 * deletes a collection: the night puts everything in its place. Returns the ids it joined.
 */
export function assignOne(userId: string, entryId: string, deps: AssignOneDeps): Promise<string[]> {
  return exclusive(async () => {
    const params = deps.params ?? COLLECTION_PARAMS;
    const { kept } = usableVectors(await deps.store.vectorsOf(userId));
    const target = kept.find((v) => v.entryId === entryId);
    if (!target) return [];
    const { mean } = centerAndNormalize(kept.map((v) => v.vector));
    const vector = centerOne(target.vector, mean);
    const corrections = await deps.store.corrections(userId);
    const removed = new Set(corrections.removed.filter((r) => r.entryId === entryId).map((r) => r.collectionId));
    const centres = (await deps.store.listCollections(userId))
      .filter((c) => c.state === 'active' && c.parentId === null && c.centroid !== null && c.centroid.length === vector.length && !removed.has(c.id))
      .map((c) => ({ id: c.id, centroid: c.centroid as Float32Array }));
    const additions: Array<{ collectionId: string; entryId: string; score: number }> = [];
    for (const id of assignThemes(vector, centres, params.assignTau, params.maxThemesPerEntry)) {
      if ((await deps.store.membersOf(id)).some((m) => m.entryId === entryId)) continue;
      additions.push({ collectionId: id, entryId, score: cosine(vector, (centres.find((c) => c.id === id) as { centroid: Float32Array }).centroid) });
    }
    if (additions.length > 0) await deps.addMembers(userId, additions);
    return additions.map((a) => a.collectionId);
  });
}

/** The real name-giver: one question to the local model through the gpu-router. */
export const nameWithLocalModel = (group: NamingGroup): Promise<NamedGroup | null> => nameWithModel(group);

/** The id of a collection that is born. */
export const newCollectionId = (): string => randomUUID();
