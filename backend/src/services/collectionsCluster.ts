/**
 * The pure rules of the collections (Raccolte, tasks 1 and 5; spec 2026-11-09-library-collections-auto-topics-design.md §3.1, §4.4, §5; ADR-0022): vectors
 * are centred on the library mean and grouped; groups become collections that are born, stay and die; an entry belongs to at most two themes; a group
 * that is about music or films is that type and not a theme; a big group with structure splits into children; two collections that are the same merge.
 *
 * Nothing here touches the network, the database or the clock, and everything is deterministic: the same vectors give the same groups, in the same
 * order, with the same ties broken the same way. Vectors are plain `Float32Array`s and are read as DIRECTIONS (their length does not matter).
 */
import { COLLECTION_PARAMS, type CollectionParams } from './collectionsParams';

/** A group of entries that talk about the same thing: the ids in the order of the entries, the centre, and what lets the group be judged and split on its own. */
export interface Group {
  members: string[];
  /** The unit vector of the mean of the members. */
  centroid: Float32Array;
  /** The vectors of the members, in the same order as `members` (set by `groupVectors`). */
  vectors?: Float32Array[];
  /** The mean cosine of the members to the centre: how tight the group is (set by `groupVectors`). */
  coherence?: number;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// vectors
// ---------------------------------------------------------------------------------------------------------------------------------------------------

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** A copy of the vector with length 1; the zero vector stays the zero vector (it is similar to nothing). */
export function normalizeVector(v: ArrayLike<number>): Float32Array {
  const norm = Math.sqrt(dot(v, v));
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm;
  return out;
}

/** Cosine similarity: 1 the same direction, 0 unrelated, -1 opposite. The zero vector is similar to nothing (0, never NaN); different lengths are an error. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`vectors of different length (${a.length} and ${b.length})`);
  const na = Math.sqrt(dot(a, a));
  const nb = Math.sqrt(dot(b, b));
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/**
 * Length 1, the mean of the library subtracted, length 1 again (spec §3.1): without the subtraction every entry looks like every other (the useful bar
 * was 0.84 and the groups worse). Returns the mean of the unit vectors, which is what a NEW entry is centred with (`centerOne`).
 */
export function centerAndNormalize(vectors: Float32Array[]): { vectors: Float32Array[]; mean: Float32Array } {
  if (vectors.length === 0) return { vectors: [], mean: new Float32Array(0) };
  const units = vectors.map(normalizeVector);
  const dim = units[0].length;
  const sum = new Float64Array(dim);
  for (const u of units) for (let i = 0; i < dim; i += 1) sum[i] += u[i];
  const mean = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) mean[i] = sum[i] / units.length;
  return { vectors: units.map((u) => subtractAndNormalize(u, mean)), mean };
}

/** The vector of ONE entry, centred with the mean that the whole library was centred with (a new entry between two nightly passes). */
export function centerOne(vector: Float32Array, mean: Float32Array): Float32Array {
  return subtractAndNormalize(normalizeVector(vector), mean);
}

function subtractAndNormalize(unit: Float32Array, mean: Float32Array): Float32Array {
  const diff = new Float32Array(unit.length);
  for (let i = 0; i < unit.length; i += 1) diff[i] = unit[i] - mean[i];
  return normalizeVector(diff);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// grouping
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface GroupingParams {
  /** An entry joins the group whose centre is at least this similar; else it opens one. */
  groupTau: number;
  /** Two groups whose centres are at least this similar are one. */
  mergeTau: number;
  /** Passes that put every entry back to the nearest centre (default: the parameters). */
  passes?: number;
}

/** A running group while it is built: the sum of its unit vectors (accumulated in doubles) and the unit vector of that sum. */
class Cluster {
  members: number[] = [];
  readonly sum: Float64Array;
  centre: Float32Array;

  constructor(dim: number) {
    this.sum = new Float64Array(dim);
    this.centre = new Float32Array(dim);
  }

  add(index: number, unit: Float32Array): void {
    this.members.push(index);
    for (let i = 0; i < unit.length; i += 1) this.sum[i] += unit[i];
    this.refresh();
  }

  refresh(): void {
    this.centre = normalizeVector(this.sum);
  }

  rebuild(indices: number[], units: Float32Array[]): void {
    this.members = indices;
    this.sum.fill(0);
    for (const idx of indices) for (let i = 0; i < this.sum.length; i += 1) this.sum[i] += units[idx][i];
    this.refresh();
  }
}

/** The centre that is nearest to the vector, the lowest index winning a tie; -1 when there are no centres. */
function nearest(unit: Float32Array, clusters: Cluster[]): { index: number; similarity: number } {
  let index = -1;
  let similarity = -Infinity;
  for (let g = 0; g < clusters.length; g += 1) {
    const s = dot(unit, clusters[g].centre);
    if (s > similarity) {
      similarity = s;
      index = g;
    }
  }
  return { index, similarity };
}

/**
 * Spec §3.1. The entries come in the order of their DATE. (1) Each joins the group with the most similar centre if the cosine is at least `groupTau`,
 * else it opens one; (2) a few passes put every entry back to the nearest centre (a group's centre moves while it fills, an early entry may belong
 * elsewhere); (3) groups whose centres are at least `mergeTau` similar merge, the closest pair first, until there are none. The vectors are expected to be
 * centred on the library mean (`centerAndNormalize`). The groups come out in the order of their first member, the members in the order of the entries.
 */
export function groupVectors(items: Array<{ id: string; vector: Float32Array }>, p: GroupingParams): Group[] {
  if (items.length === 0) return [];
  const passes = p.passes ?? COLLECTION_PARAMS.groupingPasses;
  const dim = items[0].vector.length;
  const units = items.map((it) => normalizeVector(it.vector));

  // 1. in date order, each entry joins the nearest centre if it is close enough, else opens a group
  let clusters: Cluster[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const { index, similarity } = nearest(units[i], clusters);
    if (index >= 0 && similarity >= p.groupTau) {
      clusters[index].add(i, units[i]);
    } else {
      const fresh = new Cluster(dim);
      fresh.add(i, units[i]);
      clusters.push(fresh);
    }
  }

  // 2. every entry back to the nearest centre (all of them are looked at against the centres of the start of the pass)
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Map<number, number[]>();
    let moved = false;
    const owner = new Array<number>(units.length);
    clusters.forEach((c, g) => c.members.forEach((m) => { owner[m] = g; }));
    for (let i = 0; i < units.length; i += 1) {
      const { index } = nearest(units[i], clusters);
      if (index !== owner[i]) moved = true;
      const list = next.get(index);
      if (list) list.push(i);
      else next.set(index, [i]);
    }
    if (!moved) break;
    const rebuilt: Cluster[] = [];
    for (let g = 0; g < clusters.length; g += 1) {
      const indices = next.get(g);
      if (!indices || indices.length === 0) continue;          // a group that lost everybody is gone
      const c = new Cluster(dim);
      c.rebuild(indices, units);
      rebuilt.push(c);
    }
    clusters = rebuilt;
  }

  // 3. merge the closest pair of centres while it is close enough (the similarities are kept, only the row of the merged group is made again)
  clusters = mergeClusters(clusters, units, p.mergeTau);

  return clusters
    .map((c) => ({ ...c, members: [...c.members].sort((a, b) => a - b) }))
    .sort((a, b) => a.members[0] - b.members[0])
    .map((c) => toGroup(c.members, c.centre, items, units));
}

function mergeClusters(input: Cluster[], units: Float32Array[], mergeTau: number): Cluster[] {
  const clusters = [...input];
  const alive = clusters.map(() => true);
  const n = clusters.length;
  const sim: Float64Array[] = clusters.map(() => new Float64Array(n));
  for (let a = 0; a < n; a += 1) for (let b = a + 1; b < n; b += 1) sim[a][b] = sim[b][a] = dot(clusters[a].centre, clusters[b].centre);
  for (;;) {
    let bestA = -1;
    let bestB = -1;
    let best = -Infinity;
    for (let a = 0; a < n; a += 1) {
      if (!alive[a]) continue;
      for (let b = a + 1; b < n; b += 1) {
        if (alive[b] && sim[a][b] > best) {
          best = sim[a][b];
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0 || best < mergeTau) break;
    clusters[bestA].rebuild([...clusters[bestA].members, ...clusters[bestB].members], units);
    alive[bestB] = false;
    for (let k = 0; k < n; k += 1) {
      if (alive[k] && k !== bestA) sim[bestA][k] = sim[k][bestA] = dot(clusters[bestA].centre, clusters[k].centre);
    }
  }
  return clusters.filter((_, i) => alive[i]);
}

function toGroup(members: number[], centre: Float32Array, items: Array<{ id: string; vector: Float32Array }>, units: Float32Array[]): Group {
  let total = 0;
  for (const m of members) total += dot(units[m], centre);
  return {
    members: members.map((m) => items[m].id),
    centroid: centre,
    vectors: members.map((m) => items[m].vector),
    coherence: members.length > 0 ? total / members.length : 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// life of a collection
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export type CollectionState = 'watching' | 'active' | 'gone';

/**
 * Born at `birthSize` entries (5: Michele, «5 voci»), only «watching» (not shown) from `watchingSize` (3) to 4, gone below 3. An active collection stays
 * active down to 3 (hysteresis: it must not be born and die at every entry).
 */
export function decideState(size: number, previous: 'watching' | 'active' | null, p: { birthSize: number; watchingSize: number } = COLLECTION_PARAMS): CollectionState {
  if (size >= p.birthSize) return 'active';
  if (size >= p.watchingSize) return previous === 'active' ? 'active' : 'watching';
  return 'gone';
}

/**
 * A new group inherits the id (and so the name) of the old collection it shares the most members with, when those are at least `inheritFraction` (half) of
 * the OLD members; each old id is inherited ONCE (the larger overlap first, the first group on a tie), and each group takes ONE id. The answer follows the
 * order of the groups.
 */
export function matchToExisting(
  groups: Group[],
  existing: Array<{ id: string; memberIds: string[] }>,
  p: { inheritFraction: number } = COLLECTION_PARAMS,
): Array<{ group: Group; inheritsId: string | null }> {
  const sets = existing.map((e) => new Set(e.memberIds));
  const pairs: Array<{ group: number; old: number; overlap: number }> = [];
  groups.forEach((group, g) => {
    sets.forEach((set, o) => {
      if (set.size === 0) return;
      let overlap = 0;
      for (const m of new Set(group.members)) if (set.has(m)) overlap += 1;
      if (overlap > 0 && overlap >= p.inheritFraction * set.size - 1e-9) pairs.push({ group: g, old: o, overlap });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.group - b.group || (existing[a.old].id < existing[b.old].id ? -1 : existing[a.old].id > existing[b.old].id ? 1 : 0));
  const inherits: Array<string | null> = groups.map(() => null);
  const takenGroup = new Set<number>();
  const takenOld = new Set<number>();
  for (const pair of pairs) {
    if (takenGroup.has(pair.group) || takenOld.has(pair.old)) continue;
    inherits[pair.group] = existing[pair.old].id;
    takenGroup.add(pair.group);
    takenOld.add(pair.old);
  }
  return groups.map((group, g) => ({ group, inheritsId: inherits[g] }));
}

/** Six decimals: the cosines of float vectors that are «the same» differ in the last digits, and a tie must be broken the same way every time. */
const quantum = (x: number): number => Math.round(x * 1e6);

/**
 * The themes an entry belongs to: at most `maxThemesPerEntry` (2), the nearest first, only those at least `tau` close; a tie goes to the id that comes first.
 * The caller adds the parent of each.
 */
export function assignThemes(
  vector: Float32Array,
  centroids: Array<{ id: string; centroid: Float32Array }>,
  tau: number,
  max: number = COLLECTION_PARAMS.maxThemesPerEntry,
): string[] {
  return centroids
    .map((c) => ({ id: c.id, similarity: cosine(vector, c.centroid) }))
    .filter((c) => c.similarity >= tau)
    .sort((a, b) => quantum(b.similarity) - quantum(a.similarity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, max)
    .map((c) => c.id);
}

/**
 * A group whose centre is at least `absorbTau` close to the centre of the entries that talk about music, or about films, is that TYPE (it is already
 * «Musica» or «Film e serie»), not a theme. Near both: the nearer one (music on a tie). A type that is not known is not tested.
 */
export function isTypeLike(
  centroid: Float32Array,
  typeCentroids: { music: Float32Array | null; films: Float32Array | null },
  absorbTau: number,
): 'music' | 'films' | null {
  const music = typeCentroids.music ? cosine(centroid, typeCentroids.music) : -Infinity;
  const films = typeCentroids.films ? cosine(centroid, typeCentroids.films) : -Infinity;
  const best = quantum(films) > quantum(music) ? 'films' : 'music';
  const similarity = best === 'films' ? films : music;
  return similarity >= absorbTau ? best : null;
}

/**
 * The same question asked of the MEMBERS instead of the centre: a group is music (films) when at least `share` of its entries have songs from the content
 * (films). The centre of a child inside a big group is far from the centre of the whole library's music, so `isTypeLike` misses it; the members do not lie.
 * The larger share wins when both reach the bar; an equal share goes to music (as in `isTypeLike`). No members, or nobody flagged, is never a type.
 */
export function isTypeByMembers(
  members: readonly string[],
  flagged: { music: ReadonlySet<string>; films: ReadonlySet<string> },
  share: number = COLLECTION_PARAMS.typeMemberShare,
): 'music' | 'films' | null {
  if (members.length === 0) return null;
  let music = 0;
  let films = 0;
  for (const id of members) {
    if (flagged.music.has(id)) music += 1;
    if (flagged.films.has(id)) films += 1;
  }
  if (music === 0 && films === 0) return null;
  const best = films > music ? 'films' : 'music';
  const count = best === 'films' ? films : music;
  return count / members.length >= share ? best : null;
}

/**
 * What may be assigned to a theme without turning it into a type (spec §3.1: no published theme is mostly music or films). The theme's OWN entries were already
 * under the bar when it was found; the entries the assignment adds are not, and a theme that gathers the films of its neighbours ends up over it («Anime», 63 %
 * with its own entries, 74 % with what was assigned). So an extra that is about neither music nor films always joins (they only dilute the share); one that is
 * joins, the best score first, while the share of EACH kind stays under `share`, counted as `isTypeByMembers` counts it. The entries the theme already has stay
 * whatever they are. Answers the extras that stay, in the order they came in.
 */
export function withinTypeBar(
  own: readonly string[],
  extras: ReadonlyArray<{ entryId: string; score: number }>,
  flagged: { music: ReadonlySet<string>; films: ReadonlySet<string> },
  share: number = COLLECTION_PARAMS.typeMemberShare,
): Array<{ entryId: string; score: number }> {
  const have = new Set(own);
  const isFlagged = (id: string): boolean => flagged.music.has(id) || flagged.films.has(id);
  const fresh = extras.filter((x) => !have.has(x.entryId));
  let size = have.size + fresh.filter((x) => !isFlagged(x.entryId)).length;
  let music = 0;
  let films = 0;
  for (const id of have) {
    if (flagged.music.has(id)) music += 1;
    if (flagged.films.has(id)) films += 1;
  }
  const kept = new Set(fresh.filter((x) => !isFlagged(x.entryId)).map((x) => x.entryId));
  for (const x of fresh.filter((e) => isFlagged(e.entryId)).sort((a, b) => b.score - a.score || (a.entryId < b.entryId ? -1 : 1))) {
    const withMusic = music + (flagged.music.has(x.entryId) ? 1 : 0);
    const withFilms = films + (flagged.films.has(x.entryId) ? 1 : 0);
    if (Math.max(withMusic, withFilms) / (size + 1) >= share) continue;
    music = withMusic;
    films = withFilms;
    size += 1;
    kept.add(x.entryId);
  }
  return extras.filter((x) => have.has(x.entryId) || kept.has(x.entryId));
}

/** How tight a group is: its `coherence`, or worked out from its vectors; NaN when it carries neither (it cannot be judged). */
function coherenceOf(group: Group): number {
  if (typeof group.coherence === 'number') return group.coherence;
  if (group.vectors && group.vectors.length > 0 && group.vectors.length === group.members.length) {
    let total = 0;
    for (const v of group.vectors) total += cosine(v, group.centroid);
    return total / group.vectors.length;
  }
  return Number.NaN;
}

/** A group is published only if its members are on average at least `minCoherence` close to its centre; a group that cannot be judged is not published. */
export function isCoherent(group: Group, minCoherence: number): boolean {
  const c = coherenceOf(group);
  return Number.isFinite(c) && c >= minCoherence;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// children and merging
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A collection with at least `splitMinMembers` (60) entries and structure inside gives children: the group is looked at again with its OWN mean taken away,
 * and the sub-groups of at least `childMinSize` (8) entries are the children (at least two, else there is no split). An entry that is in no child stays in
 * the parent only. A group that carries no vectors cannot be split. The children keep the centre and the coherence of the original space.
 */
export function splitInChildren(
  group: Group,
  p: { splitMinMembers: number; childMinSize: number; childTau: number } = COLLECTION_PARAMS,
): Group[] {
  const vectors = group.vectors;
  if (!vectors || vectors.length !== group.members.length || group.members.length < p.splitMinMembers) return [];
  const { vectors: centred } = centerAndNormalize(vectors);
  const subs = groupVectors(group.members.map((id, i) => ({ id, vector: centred[i] })), { groupTau: p.childTau, mergeTau: p.childTau + 0.12 })
    .filter((g) => g.members.length >= p.childMinSize);
  if (subs.length < 2) return [];
  const at = new Map(group.members.map((id, i) => [id, i]));
  return subs.map((sub) => {
    const own = sub.members.map((id) => vectors[at.get(id) as number]);
    const sum = new Float64Array(own[0].length);
    for (const v of own) {
      const u = normalizeVector(v);
      for (let i = 0; i < sum.length; i += 1) sum[i] += u[i];
    }
    const centroid = normalizeVector(sum);
    return {
      members: sub.members,
      centroid,
      vectors: own,
      coherence: own.reduce((t, v) => t + cosine(v, centroid), 0) / own.length,
    };
  });
}

export interface MergeableCollection {
  id: string;
  name: string;
  centroid: Float32Array;
  memberIds: string[];
}

export interface MergedCollection extends MergeableCollection {
  /** The ids that were folded into this one (empty when nothing merged). */
  mergedIds: string[];
}

/** A name as a person compares it: no case, no accents, no punctuation, one space between words. */
export function cleanName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Two collections with almost the same centre (`mergeTau`, by default `sameNameTau`: lower than the one that merges groups, because the SAME NAME already
 * says they are one thing) AND the same name after cleaning are one (spec §5.6). The larger one stays (the id that comes
 * first on a tie) with its name; the members are the union, once each; the centre is the unit vector of the centres weighed by size. The others come back
 * untouched, with an empty `mergedIds`. The answer follows the order of the input.
 */
export function mergeSame(collections: MergeableCollection[], mergeTau: number = COLLECTION_PARAMS.sameNameTau): MergedCollection[] {
  const parent = collections.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const keys = collections.map((c) => cleanName(c.name));
  for (let a = 0; a < collections.length; a += 1) {
    for (let b = a + 1; b < collections.length; b += 1) {
      if (keys[a] !== '' && keys[a] === keys[b] && cosine(collections[a].centroid, collections[b].centroid) >= mergeTau) {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const components = new Map<number, number[]>();
  collections.forEach((_, i) => {
    const root = find(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  });
  const out: Array<{ first: number; value: MergedCollection }> = [];
  for (const indices of components.values()) {
    const keeperIndex = [...indices].sort((a, b) => collections[b].memberIds.length - collections[a].memberIds.length || (collections[a].id < collections[b].id ? -1 : 1))[0];
    const keeper = collections[keeperIndex];
    if (indices.length === 1) {
      out.push({ first: indices[0], value: { ...keeper, mergedIds: [] } });
      continue;
    }
    const members: string[] = [];
    const seen = new Set<string>();
    for (const i of [keeperIndex, ...indices.filter((x) => x !== keeperIndex)]) {
      for (const m of collections[i].memberIds) if (!seen.has(m)) { seen.add(m); members.push(m); }
    }
    const sum = new Float64Array(keeper.centroid.length);
    for (const i of indices) {
      const u = normalizeVector(collections[i].centroid);
      const w = Math.max(1, collections[i].memberIds.length);
      for (let k = 0; k < sum.length; k += 1) sum[k] += u[k] * w;
    }
    out.push({
      first: Math.min(...indices),
      value: {
        id: keeper.id,
        name: keeper.name,
        centroid: normalizeVector(sum),
        memberIds: members,
        mergedIds: indices.filter((x) => x !== keeperIndex).map((x) => collections[x].id).sort(),
      },
    });
  }
  return out.sort((a, b) => a.first - b.first).map((o) => o.value);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the pipeline (shared by the calibration preview and the engine)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** What the types need to be recognised: the centre of the entries that talk about music (and films) and who they are. */
export interface TypeContext {
  typeCentres: { music: Float32Array | null; films: Float32Array | null };
  flagged: { music: ReadonlySet<string>; films: ReadonlySet<string> };
}

/** A group (or a child of a big group) that can become a collection: not a type, tight enough. */
export interface Candidate {
  kind: 'group' | 'child';
  /** Index (in `candidates`) of the published group a child belongs to; null for a group, and for a child whose parent is not a candidate. */
  parent: number | null;
  group: Group;
}

/** A group (or child) taken for music or films: it is that type already, not a theme. `by`: seen from its centre (`isTypeLike`) or from its members (`isTypeByMembers`). */
export interface Absorbed {
  group: Group;
  kind: 'group' | 'child';
  type: 'music' | 'films';
  by: 'centre' | 'members';
}

export interface Discovery {
  /** Every group of at least `minGroup` entries, whatever became of it. */
  groups: Group[];
  absorbed: Absorbed[];
  loose: Group[];
  candidates: Candidate[];
}

/**
 * The discovery with the pure rules and nothing else (no names, no places, no database, no assignment): groups of at least `minGroup` entries (the birth
 * size by default: the engine asks for the «watching» size too); a group that is music or films (by its centre or by its members) is a TYPE and not a theme;
 * a group that is not coherent is not a candidate; a big group is split in children (which go through the same two gates; a loose parent can still have good
 * children). The vectors are expected centred on the library mean.
 */
export function discoverCollections(
  items: Array<{ id: string; vector: Float32Array }>,
  ctx: TypeContext,
  params: CollectionParams = COLLECTION_PARAMS,
  minGroup: number = params.birthSize,
): Discovery {
  const groups = groupVectors(items, { groupTau: params.groupTau, mergeTau: params.mergeTau, passes: params.groupingPasses })
    .filter((g) => g.members.length >= minGroup);
  const absorbed: Absorbed[] = [];
  const loose: Group[] = [];
  const candidates: Candidate[] = [];
  const typeOf = (g: Group): { type: 'music' | 'films'; by: 'centre' | 'members' } | null => {
    const byCentre = isTypeLike(g.centroid, ctx.typeCentres, params.absorbTau);
    if (byCentre) return { type: byCentre, by: 'centre' };
    const byMembers = isTypeByMembers(g.members, ctx.flagged, params.typeMemberShare);
    return byMembers ? { type: byMembers, by: 'members' } : null;
  };
  for (const g of groups) {
    const type = typeOf(g);
    if (type) {
      absorbed.push({ group: g, kind: 'group', ...type });
      continue;
    }
    let parent: number | null = null;
    if (isCoherent(g, params.minCoherence)) {
      parent = candidates.length;
      candidates.push({ kind: 'group', parent: null, group: g });
    } else {
      loose.push(g);
    }
    for (const child of splitInChildren(g, params)) {
      const childType = typeOf(child);
      if (childType) absorbed.push({ group: child, kind: 'child', ...childType });
      else if (!isCoherent(child, params.minCoherence)) loose.push(child);
      else candidates.push({ kind: 'child', parent, group: child });
    }
  }
  return { groups, absorbed, loose, candidates };
}

/**
 * Every entry joins at most `maxThemesPerEntry` of the themes (the nearest first, only those at least `assignTau` close: `assignThemes`), except the pairs
 * `excluded` says never to make (the entries taken out of a collection by hand). The answer has every theme (empty when nobody joined it), and each list
 * follows the order of the entries, with the cosine to the centre of the theme as the score.
 */
export function assignToThemes(
  items: Array<{ id: string; vector: Float32Array }>,
  themes: Array<{ id: string; centroid: Float32Array }>,
  params: Pick<CollectionParams, 'assignTau' | 'maxThemesPerEntry'>,
  excluded?: (entryId: string, themeId: string) => boolean,
): Map<string, Array<{ entryId: string; score: number }>> {
  const out = new Map<string, Array<{ entryId: string; score: number }>>(themes.map((t) => [t.id, []]));
  const centroidOf = new Map(themes.map((t) => [t.id, t.centroid]));
  for (const item of items) {
    const candidates = excluded ? themes.filter((t) => !excluded(item.id, t.id)) : themes;
    for (const id of assignThemes(item.vector, candidates, params.assignTau, params.maxThemesPerEntry)) {
      (out.get(id) as Array<{ entryId: string; score: number }>).push({ entryId: item.id, score: cosine(item.vector, centroidOf.get(id) as Float32Array) });
    }
  }
  return out;
}
