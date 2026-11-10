import { describe, expect, it } from 'vitest';
import {
  assignThemes,
  assignToThemes,
  centerAndNormalize,
  centerOne,
  cosine,
  decideState,
  discoverCollections,
  groupVectors,
  isCoherent,
  isTypeByMembers,
  isTypeLike,
  matchToExisting,
  mergeSame,
  splitInChildren,
  withinTypeBar,
  type Group,
} from './collectionsCluster';
import { COLLECTION_PARAMS } from './collectionsParams';

// Raccolte, tasks 1 and 5 (spec 2026-11-09-library-collections-auto-topics-design.md §3.1, §5; ADR-0022): the pure rules that turn vectors into groups, and
// groups into collections that are born, stay and die. Synthetic vectors only (no Ollama in tests, project rule); everything here is deterministic.

/** A small deterministic random generator (the same numbers on every run and every machine). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const gauss = (rand: () => number): number => rand() + rand() + rand() + rand() - 2;

const DIM = 48;
const unit = (v: Float32Array): Float32Array => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n === 0 ? v : v.map((x) => x / n);
};
const randomDirection = (rand: () => number): Float32Array => unit(Float32Array.from({ length: DIM }, () => gauss(rand)));
const around = (dir: Float32Array, noise: number, rand: () => number): Float32Array =>
  unit(dir.map((x) => x + noise * gauss(rand) / Math.sqrt(DIM)));
/** A vector at `deg` degrees on a plane: the cosine between two of them is cos of the angle between. */
const ang = (deg: number): Float32Array => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]);
const cosDeg = (deg: number): number => Math.cos((deg * Math.PI) / 180);

/** Random directions that are far from each other (cosine under 0.3 in absolute value): drawn again, from the same stream, until they are. */
function farDirections(count: number, rand: () => number): Float32Array[] {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const dirs = Array.from({ length: count }, () => randomDirection(rand));
    let far = true;
    for (let i = 0; i < dirs.length; i += 1) for (let j = i + 1; j < dirs.length; j += 1) if (Math.abs(cosine(dirs[i], dirs[j])) >= 0.3) far = false;
    if (far) return dirs;
  }
  throw new Error('no directions far enough from each other');
}

interface Planted {
  items: Array<{ id: string; vector: Float32Array }>;
  dirs: Float32Array[];
}
/** Clusters planted around random directions; the entries are interleaved in «date order» (round robin), ids `c<cluster>-<n>`. */
function planted(counts: number[], noise = 0.35, seed = 7): Planted {
  const rand = rng(seed);
  const dirs = farDirections(counts.length, rand);
  const made = counts.map((c, k) => Array.from({ length: c }, (_, n) => ({ id: `c${k}-${n}`, vector: around(dirs[k], noise, rand) })));
  const items: Planted['items'] = [];
  for (let n = 0; n < Math.max(...counts); n += 1) for (const list of made) if (list[n]) items.push(list[n]);
  return { items, dirs };
}
const membersOf = (groups: Group[]): string[][] => groups.map((g) => [...g.members].sort()).sort((a, b) => a[0].localeCompare(b[0]));
const P = { groupTau: 0.42, mergeTau: 0.54 };

describe('cosine', () => {
  it('is 1 for the same direction, 0 for orthogonal, -1 for opposite', () => {
    expect(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([2, 4, 6]))).toBeCloseTo(1, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 5]))).toBeCloseTo(0, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([-3, 0]))).toBeCloseTo(-1, 6);
  });

  it('a zero vector is similar to nothing (0, never NaN), and vectors of different length are an error', () => {
    expect(cosine(new Float32Array(3), Float32Array.from([1, 2, 3]))).toBe(0);
    expect(cosine(new Float32Array(3), new Float32Array(3))).toBe(0);
    expect(() => cosine(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3]))).toThrow(/length/);
  });
});

describe('centerAndNormalize: the library mean is subtracted (without it every entry looks like every other)', () => {
  it('gives unit vectors, and returns the mean it subtracted (of the unit vectors)', () => {
    const { vectors, mean } = centerAndNormalize([Float32Array.from([3, 0, 0]), Float32Array.from([0, 2, 0]), Float32Array.from([0, 0, 5])]);
    for (const v of vectors) expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    expect(Array.from(mean).map((x) => +x.toFixed(5))).toEqual([0.33333, 0.33333, 0.33333]);
  });

  it('vectors that share a big common part are far apart again once it is taken away', () => {
    const common = unit(Float32Array.from({ length: DIM }, () => 1));
    const alt = unit(Float32Array.from({ length: DIM }, (_, i) => (i % 2 === 0 ? 1 : -1)));
    const a = unit(common.map((x, i) => x + 0.2 * alt[i]));
    const b = unit(common.map((x, i) => x - 0.2 * alt[i]));
    expect(cosine(a, b)).toBeGreaterThan(0.9);
    const { vectors } = centerAndNormalize([a, b]);
    expect(cosine(vectors[0], vectors[1])).toBeLessThan(0);
  });

  it('a vector equal to the mean becomes the zero vector (no NaN), and an empty library is empty', () => {
    const v = Float32Array.from([1, 2, 3]);
    const { vectors } = centerAndNormalize([v, v]);
    expect(Array.from(vectors[0])).toEqual([0, 0, 0]);
    expect(centerAndNormalize([])).toEqual({ vectors: [], mean: new Float32Array(0) });
  });

  it('does not change its input', () => {
    const input = [Float32Array.from([3, 4]), Float32Array.from([1, 1])];
    centerAndNormalize(input);
    expect(Array.from(input[0])).toEqual([3, 4]);
  });

  it('centerOne gives a new entry the same vector the batch gives it (same mean)', () => {
    const all = [Float32Array.from([3, 0, 1]), Float32Array.from([0, 2, 1]), Float32Array.from([1, 1, 5])];
    const { vectors, mean } = centerAndNormalize(all);
    for (let i = 0; i < all.length; i += 1) {
      const one = centerOne(all[i], mean);
      for (let k = 0; k < one.length; k += 1) expect(one[k]).toBeCloseTo(vectors[i][k], 5);
    }
  });
});

describe('groupVectors (spec §3.1)', () => {
  it('finds three planted clusters of 6 + 7 + 5 and nothing else', () => {
    const { items } = planted([6, 7, 5]);
    const groups = groupVectors(items, P);
    expect(groups).toHaveLength(3);
    expect(membersOf(groups)).toEqual([
      Array.from({ length: 6 }, (_, n) => `c0-${n}`).sort(),
      Array.from({ length: 7 }, (_, n) => `c1-${n}`).sort(),
      Array.from({ length: 5 }, (_, n) => `c2-${n}`).sort(),
    ]);
  });

  it('two nearly identical clusters are ONE group (the centres are merged)', () => {
    const rand = rng(21);
    const dir = randomDirection(rand);
    const twin = unit(dir.map((x) => x + 0.05 * gauss(rand)));
    const mixed: Array<{ id: string; vector: Float32Array }> = [];
    for (let n = 0; n < 5; n += 1) {
      mixed.push({ id: `a${n}`, vector: around(dir, 0.2, rand) });
      mixed.push({ id: `b${n}`, vector: around(twin, 0.2, rand) });
    }
    expect(groupVectors(mixed, { groupTau: 0.97, mergeTau: 0.5 })).toHaveLength(1);
    expect(groupVectors(mixed, { groupTau: 0.97, mergeTau: 1.5 }).length).toBeGreaterThan(1);       // without the merge they stay apart
  });

  it('merging goes on until no two centres are close enough, and a merged centre counts again (0°, 18°, 40°: A and B join, C is too far from their new centre)', () => {
    const items = [
      ...[0, 1, -1].map((d, n) => ({ id: `a${n}`, vector: ang(d) })),
      ...[18, 19, 17].map((d, n) => ({ id: `b${n}`, vector: ang(d) })),
      ...[40, 41, 39].map((d, n) => ({ id: `c${n}`, vector: ang(d) })),
    ];
    const groups = groupVectors(items, { groupTau: 0.995, mergeTau: 0.9 });
    expect(membersOf(groups)).toEqual([['a0', 'a1', 'a2', 'b0', 'b1', 'b2'], ['c0', 'c1', 'c2']]);
    // and with a lower bar the chain goes all the way (the merged centre is at 9°, 31° from C: cos 0.857)
    expect(groupVectors(items, { groupTau: 0.995, mergeTau: 0.85 })).toHaveLength(1);
  });

  it('a vector joins the group whose centre is the MOST similar, not the first one that is similar enough', () => {
    const items = [
      { id: 'g0', vector: ang(0) },
      { id: 'g1', vector: ang(50) },
      { id: 'v', vector: ang(30) },
    ];
    const groups = groupVectors(items, { groupTau: cosDeg(40), mergeTau: 0.999 });
    expect(membersOf(groups)).toEqual([['g0'], ['g1', 'v']]);
  });

  it('a vector under the bar opens a group of its own (a lone outlier is a group of one)', () => {
    const { items } = planted([6, 6]);
    const withOutlier = [...items, { id: 'lone', vector: Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)) }];
    const groups = groupVectors(withOutlier, P);
    expect(groups.some((g) => g.members.length === 1 && g.members[0] === 'lone')).toBe(true);
  });

  it('the passes put every vector back to the nearest centre (a vector that joined an early group that later turned out to be farther goes where it belongs)', () => {
    // 0°, 30°, 47° form the first group (its centre moves to ≈ 26°); 65° is too far from it and opens a second group, 47° is then nearer to that one
    const items = [0, 30, 47, 65, 67, 63, 66].map((d) => ({ id: `v${d}`, vector: ang(d) }));
    const p = { groupTau: cosDeg(35), mergeTau: 0.9999 };
    const holding = (groups: Group[], id: string): string[] => groups.find((g) => g.members.includes(id))?.members ?? [];
    expect(holding(groupVectors(items, p), 'v47')).toContain('v65');
    expect(holding(groupVectors(items, { ...p, passes: 0 }), 'v47')).toContain('v0');
    expect(holding(groupVectors(items, { ...p, passes: 0 }), 'v47')).not.toContain('v65');
    expect(holding(groupVectors(items, { ...p, passes: 1 }), 'v47')).toContain('v65');           // one pass is enough here, and is a pass
  });

  it('the bar to join is inclusive: the same direction twice is one group even when the bar is 1 (before the passes, which would put it back anyway)', () => {
    const items = [{ id: 'a', vector: ang(0) }, { id: 'b', vector: ang(0) }];
    expect(membersOf(groupVectors(items, { groupTau: 1, mergeTau: 2, passes: 0 }))).toEqual([['a', 'b']]);
  });

  it('a vector that is exactly as near to two centres goes to the first one', () => {
    const items = [{ id: 'v0', vector: Float32Array.from([1, 0]) }, { id: 'v1', vector: Float32Array.from([0, 1]) }, { id: 'v2', vector: Float32Array.from([1, 1]) }];
    expect(groupVectors(items, { groupTau: 0.5, mergeTau: 2, passes: 0 }).map((g) => g.members)).toEqual([['v0', 'v2'], ['v1']]);
  });

  it('the bar to merge is inclusive, and of two equal pairs the first one merges first', () => {
    const same = [{ id: 'a', vector: ang(0) }, { id: 'b', vector: ang(0) }];
    expect(groupVectors(same, { groupTau: 2, mergeTau: 1 }).map((g) => g.members)).toEqual([['a', 'b']]);
    // A, B and C at 0°, 90° and 180°: A–B and B–C are equally unrelated; A and B merge first and their new centre is then too far from C
    const three = [{ id: 'a', vector: Float32Array.from([1, 0]) }, { id: 'b', vector: Float32Array.from([0, 1]) }, { id: 'c', vector: Float32Array.from([-1, 0]) }];
    expect(groupVectors(three, { groupTau: 0.5, mergeTau: 0, passes: 0 }).map((g) => g.members)).toEqual([['a', 'b'], ['c']]);
  });

  it('the length of a vector does not matter: the same directions, three times as long, give the same groups', () => {
    const items = [{ id: 'a', vector: Float32Array.from([10, 0]) }, { id: 'b', vector: Float32Array.from([7, 7]) }, { id: 'c', vector: Float32Array.from([9, 1]) }];
    const p = { groupTau: 0.8, mergeTau: 2 };
    const groups = groupVectors(items, p).map((g) => g.members);
    expect(groups).toEqual([['a', 'c'], ['b']]);
    expect(groupVectors(items.map((it) => ({ id: it.id, vector: it.vector.map((x) => x * 3) })), p).map((g) => g.members)).toEqual(groups);
  });

  it('members stay in the order of the entries even after a merge, and the groups in the order of their FIRST member (an early entry may move to a later group)', () => {
    // 0° and 5° are one group, 50° and 55° the other; they merge, and the entries are interleaved
    const interleaved = [0, 50, 55, 5].map((d, i) => ({ id: `v${i}`, vector: ang(d) }));
    expect(groupVectors(interleaved, { groupTau: cosDeg(30), mergeTau: 0.6 }).map((g) => g.members)).toEqual([['v0', 'v1', 'v2', 'v3']]);
    // v0 (85°) opens the first group, and the passes move it to the group that opened second (105°): that group is now the first one
    const moved = [85, 55, 105, 110, 45].map((d, i) => ({ id: `v${i}`, vector: ang(d) }));
    expect(groupVectors(moved, { groupTau: cosDeg(32), mergeTau: 2 }).map((g) => g.members)).toEqual([['v0', 'v2', 'v3'], ['v1', 'v4']]);
  });

  it('members come in the order of the entries, and the groups in the order of their first member', () => {
    const { items } = planted([4, 4, 4]);
    const groups = groupVectors(items, P);
    const order = new Map(items.map((it, i) => [it.id, i]));
    for (const g of groups) expect(g.members.map((m) => order.get(m))).toEqual([...g.members.map((m) => order.get(m) as number)].sort((a, b) => a - b));
    const firsts = groups.map((g) => order.get(g.members[0]) as number);
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  });

  it('the centre of a group is the unit vector of the mean of its members, and its coherence is how close they are to it', () => {
    const { items } = planted([6, 6]);
    const [g] = groupVectors(items, P);
    expect(Math.hypot(...g.centroid)).toBeCloseTo(1, 5);
    const sum = new Float32Array(DIM);
    for (const id of g.members) for (let k = 0; k < DIM; k += 1) sum[k] += items.find((it) => it.id === id)!.vector[k];
    expect(cosine(unit(sum), g.centroid)).toBeCloseTo(1, 5);
    const mean = g.members.reduce((s, id) => s + cosine(items.find((it) => it.id === id)!.vector, g.centroid), 0) / g.members.length;
    expect(g.coherence).toBeCloseTo(mean, 5);
    expect(g.vectors).toHaveLength(g.members.length);
  });

  it('is deterministic: the same entries give the same groups, member by member', () => {
    const { items } = planted([7, 5, 6, 4], 0.35, 13);
    expect(groupVectors(items, P).map((g) => g.members)).toEqual(groupVectors(items, P).map((g) => g.members));
  });

  it('nothing is nothing, one is one, the same vector twice is one group', () => {
    expect(groupVectors([], P)).toEqual([]);
    const v = ang(10);
    expect(groupVectors([{ id: 'a', vector: v }], P).map((g) => g.members)).toEqual([['a']]);
    expect(groupVectors([{ id: 'a', vector: v }, { id: 'b', vector: v }], P).map((g) => g.members)).toEqual([['a', 'b']]);
  });
});

describe('decideState: born at 5, watching at 3–4, gone below 3, and an active one does not flicker (spec §5.4, Michele: «5 voci»)', () => {
  it.each([
    [0, null, 'gone'], [1, null, 'gone'], [2, null, 'gone'], [3, null, 'watching'], [4, null, 'watching'], [5, null, 'active'], [6, null, 'active'], [100, null, 'active'],
    [4, 'watching', 'watching'], [5, 'watching', 'active'], [2, 'watching', 'gone'],
    [5, 'active', 'active'], [4, 'active', 'active'], [3, 'active', 'active'], [2, 'active', 'gone'], [0, 'active', 'gone'],
  ] as const)('%i entries, was %s → %s', (size, previous, expected) => {
    expect(decideState(size, previous)).toBe(expected);
  });

  it('the numbers are the ones of the parameters', () => {
    expect(COLLECTION_PARAMS.birthSize).toBe(5);
    expect(COLLECTION_PARAMS.watchingSize).toBe(3);
  });
});

describe('matchToExisting: a new group inherits id and name of the old collection that holds at least half of the OLD members', () => {
  const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const group = (members: string[]): Group => ({ members, centroid: Float32Array.from([1, 0]) });

  it('unchanged data: every group keeps the id it had, twice in a row (no flicker)', () => {
    const existing = [{ id: 'col-a', memberIds: ids('a', 6) }, { id: 'col-b', memberIds: ids('b', 8) }];
    const groups = [group(ids('a', 6)), group(ids('b', 8))];
    const first = matchToExisting(groups, existing);
    expect(first.map((m) => m.inheritsId)).toEqual(['col-a', 'col-b']);
    expect(matchToExisting(groups, existing)).toEqual(first);
  });

  it('a group that gained two members keeps its id', () => {
    const out = matchToExisting([group([...ids('a', 6), 'new1', 'new2'])], [{ id: 'col-a', memberIds: ids('a', 6) }]);
    expect(out[0].inheritsId).toBe('col-a');
  });

  it('40 % of the old members is not enough, 50 % is', () => {
    const old = { id: 'col-a', memberIds: ids('a', 10) };
    expect(matchToExisting([group([...ids('a', 4), ...ids('x', 8)])], [old])[0].inheritsId).toBeNull();
    expect(matchToExisting([group([...ids('a', 5), ...ids('x', 8)])], [old])[0].inheritsId).toBe('col-a');
    expect(matchToExisting([group([...ids('a', 9), ...ids('x', 8)])], [old])[0].inheritsId).toBe('col-a');
  });

  it('a split: the larger overlap keeps the id, the other group is new', () => {
    const old = { id: 'col-big', memberIds: ids('m', 20) };
    const out = matchToExisting([group(ids('m', 8)), group(ids('m', 20).slice(8))], [old]);
    expect(out.map((m) => m.inheritsId)).toEqual([null, 'col-big']);
  });

  it('each old id is inherited ONCE, even when two groups hold half of it (the larger overlap wins; the first group on a tie)', () => {
    const old = { id: 'col-a', memberIds: ids('a', 12) };
    const tie = matchToExisting([group(ids('a', 12).slice(0, 6)), group(ids('a', 12).slice(6))], [old]);
    expect(tie.map((m) => m.inheritsId)).toEqual(['col-a', null]);
    const larger = matchToExisting([group(ids('a', 12).slice(4)), group(ids('a', 9))], [old]);          // 8 and 9 of the 12
    expect(larger.map((m) => m.inheritsId)).toEqual([null, 'col-a']);
  });

  it('a group that holds exactly half of two old collections takes the id that comes first, whatever the order they were given in', () => {
    const olds = [{ id: 'col-b', memberIds: ids('b', 6) }, { id: 'col-a', memberIds: ids('a', 6) }];
    const out = matchToExisting([group([...ids('a', 3), ...ids('b', 3)])], olds);
    expect(out[0].inheritsId).toBe('col-a');
  });

  it('a group takes ONE id: of two old collections it holds, the one it shares most members with', () => {
    const olds = [{ id: 'col-a', memberIds: ids('a', 6) }, { id: 'col-b', memberIds: ids('b', 10) }];
    const out = matchToExisting([group([...ids('a', 6), ...ids('b', 10)])], olds);
    expect(out[0].inheritsId).toBe('col-b');
  });

  it('the answer follows the order of the groups; no old collections, or nothing in common, is «new» for all', () => {
    expect(matchToExisting([group(ids('a', 5)), group(ids('b', 5))], []).map((m) => m.inheritsId)).toEqual([null, null]);
    expect(matchToExisting([group(ids('q', 5))], [{ id: 'col-a', memberIds: ids('a', 5) }])[0].inheritsId).toBeNull();
    expect(matchToExisting([], [{ id: 'col-a', memberIds: ids('a', 5) }])).toEqual([]);
  });

  it('an old collection with no members is never inherited', () => {
    expect(matchToExisting([group(ids('a', 5))], [{ id: 'col-empty', memberIds: [] }])[0].inheritsId).toBeNull();
  });

  it('returns each group itself, untouched', () => {
    const g = group(ids('a', 5));
    expect(matchToExisting([g], [{ id: 'col-a', memberIds: ids('a', 5) }])[0].group).toBe(g);
  });
});

describe('assignThemes: at most two themes per entry, the best first, only those that are close enough', () => {
  const themes = [
    { id: 'wine', centroid: ang(0) },
    { id: 'food', centroid: ang(25) },
    { id: 'travel', centroid: ang(40) },
    { id: 'tech', centroid: ang(120) },
  ];

  it('an entry between two themes gets both, the nearer first; never three', () => {
    expect(assignThemes(ang(10), themes, cosDeg(30))).toEqual(['wine', 'food']);
    expect(assignThemes(ang(30), themes, cosDeg(35))).toEqual(['food', 'travel']);         // wine (30°), food (5°), travel (10°): all three are close, two are taken
    expect(assignThemes(ang(30), themes, cosDeg(35), 3)).toEqual(['food', 'travel', 'wine']);      // the maximum is the caller's to give
  });

  it('an entry near one theme gets one; near none gets none; the bar is inclusive', () => {
    expect(assignThemes(ang(122), themes, cosDeg(30))).toEqual(['tech']);
    expect(assignThemes(ang(200), themes, cosDeg(30))).toEqual([]);
    expect(assignThemes(ang(30), [{ id: 'x', centroid: ang(0) }], cosDeg(30) - 1e-6)).toEqual(['x']);
    expect(assignThemes(ang(31), [{ id: 'x', centroid: ang(0) }], cosDeg(30))).toEqual([]);
    expect(assignThemes(ang(0), [{ id: 'x', centroid: ang(0) }], 1)).toEqual(['x']);                // exactly at the bar (cosine 1) is in
  });

  it('a tie goes to the id that comes first (the same answer every time), and no themes is no answer', () => {
    expect(assignThemes(ang(10), [{ id: 'b', centroid: ang(0) }, { id: 'a', centroid: ang(20) }], cosDeg(30))).toEqual(['a', 'b']);
    expect(assignThemes(ang(10), [], cosDeg(30))).toEqual([]);
  });
});

describe('isTypeLike: a group that is about music or films is that type, not a theme', () => {
  const types = { music: ang(0), films: ang(90) };

  it('a group near the centre of the music entries is music, near the films is films, far from both is nothing', () => {
    expect(isTypeLike(ang(10), types, cosDeg(25))).toBe('music');
    expect(isTypeLike(ang(80), types, cosDeg(25))).toBe('films');
    expect(isTypeLike(ang(45), types, cosDeg(25))).toBeNull();
  });

  it('the bar is inclusive (exactly at it is in), an equal distance goes to music, and a type that is not known is never a match, even for a bar below zero', () => {
    expect(isTypeLike(ang(0), { music: ang(0), films: null }, 1)).toBe('music');
    expect(isTypeLike(Float32Array.from([1, 1]), { music: Float32Array.from([1, 0]), films: Float32Array.from([0, 1]) }, 0.5)).toBe('music');
    expect(isTypeLike(ang(0), { music: null, films: null }, -0.5)).toBeNull();
  });

  it('near both: the nearer one; the bar is inclusive; a type that is not known is not tested', () => {
    expect(isTypeLike(ang(40), { music: ang(0), films: ang(60) }, cosDeg(45))).toBe('films');
    expect(isTypeLike(ang(20), types, cosDeg(20) - 1e-6)).toBe('music');
    expect(isTypeLike(ang(21), types, cosDeg(20))).toBeNull();
    expect(isTypeLike(ang(10), { music: null, films: ang(90) }, cosDeg(25))).toBeNull();
    expect(isTypeLike(ang(10), { music: null, films: null }, cosDeg(25))).toBeNull();
  });
});

describe('isTypeByMembers: a group whose entries are mostly about music or films is that type, whatever its centre says', () => {
  const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const flagged = { music: new Set(ids('m', 4)), films: new Set(ids('f', 5)) };

  it('music when at least the share of the members has songs from the content, films likewise; the bar is inclusive', () => {
    expect(isTypeByMembers(['m0', 'm1', 'm2', 'x'], flagged, 0.75)).toBe('music');          // 3 of 4 = 0.75
    expect(isTypeByMembers(['m0', 'm1', 'x', 'y'], flagged, 0.75)).toBeNull();               // 2 of 4
    expect(isTypeByMembers(['f0', 'f1', 'f2', 'f3'], flagged, 0.7)).toBe('films');
    expect(isTypeByMembers(['f0', 'f1', 'x', 'y', 'z'], flagged, 0.7)).toBeNull();           // 2 of 5
    expect(isTypeByMembers(['x', 'y', 'z'], flagged, 0)).toBeNull();                          // nobody flagged is never a type, even with a bar of zero
  });

  it('when both reach the bar the larger share wins, and an equal share goes to music (like isTypeLike)', () => {
    const both = { music: new Set(['a', 'b', 'c']), films: new Set(['a', 'b', 'c', 'd']) };
    expect(isTypeByMembers(['a', 'b', 'c', 'd'], both, 0.5)).toBe('films');                  // 0.75 against 1
    const split = { music: new Set(['a', 'b']), films: new Set(['c', 'd']) };
    expect(isTypeByMembers(['a', 'b', 'c', 'd'], split, 0.5)).toBe('music');                 // 0.5 against 0.5
  });

  it('no members is nothing; a member that is not in a set simply does not count; the default bar is the parameter', () => {
    expect(isTypeByMembers([], flagged, 0.5)).toBeNull();
    const n = 20;
    const need = Math.ceil(COLLECTION_PARAMS.typeMemberShare * n);
    const music = new Set(ids('p', need));
    const group = [...ids('p', need), ...ids('q', n - need)];
    expect(isTypeByMembers(group, { music, films: new Set() })).toBe('music');
    expect(isTypeByMembers(group.slice(1), { music, films: new Set() })).toBeNull();          // one flagged member less: under the bar
  });
});

describe('isCoherent: the members of a published group are close to its centre', () => {
  it('a tight group is coherent, a loose blob is not', () => {
    const rand = rng(31);
    const dir = randomDirection(rand);
    const tight = groupVectors(Array.from({ length: 10 }, (_, n) => ({ id: `t${n}`, vector: around(dir, 0.3, rand) })), { groupTau: 0.2, mergeTau: 0.9 })[0];
    const blob = groupVectors(Array.from({ length: 30 }, (_, n) => ({ id: `r${n}`, vector: randomDirection(rand) })), { groupTau: -1, mergeTau: 2 })[0];
    expect(tight.members).toHaveLength(10);
    expect(blob.members).toHaveLength(30);
    expect(isCoherent(tight, 0.5)).toBe(true);
    expect(isCoherent(blob, 0.5)).toBe(false);
  });

  it('the bar is inclusive, and a group that cannot be judged (no coherence, no vectors) is not coherent', () => {
    const g: Group = { members: ['a'], centroid: ang(0), coherence: 0.4 };
    expect(isCoherent(g, 0.4)).toBe(true);
    expect(isCoherent(g, 0.41)).toBe(false);
    expect(isCoherent({ members: ['a'], centroid: ang(0) }, 0)).toBe(false);
  });

  it('a group that carries its vectors but not its coherence is judged from them', () => {
    const g: Group = { members: ['a', 'b'], centroid: ang(0), vectors: [ang(0), ang(60)] };
    expect(isCoherent(g, 0.7)).toBe(true);            // mean cosine to ang(0) = (1 + 0.5) / 2 = 0.75
    expect(isCoherent(g, 0.8)).toBe(false);
  });
});

describe('splitInChildren: a big group with structure gives children, one without does not', () => {
  const split = { splitMinMembers: 60, childMinSize: 8, childTau: 0.42 };

  /** A group of `n` entries: two sub-clusters (of `a` and `b` entries) around two directions that share a big common part, the rest scattered. */
  function bigGroup(a: number, b: number, rest: number, seed: number): Group {
    const rand = rng(seed);
    const common = randomDirection(rand);
    const d1 = randomDirection(rand);
    const d2 = randomDirection(rand);
    const vecs: Array<{ id: string; vector: Float32Array }> = [];
    for (let n = 0; n < a; n += 1) vecs.push({ id: `a${n}`, vector: around(unit(common.map((x, i) => 0.9 * x + 0.9 * d1[i])), 0.25, rand) });
    for (let n = 0; n < b; n += 1) vecs.push({ id: `b${n}`, vector: around(unit(common.map((x, i) => 0.9 * x + 0.9 * d2[i])), 0.25, rand) });
    for (let n = 0; n < rest; n += 1) vecs.push({ id: `r${n}`, vector: around(common, 1.2, rand) });
    const sum = new Float32Array(DIM);
    for (const v of vecs) for (let k = 0; k < DIM; k += 1) sum[k] += v.vector[k];
    return { members: vecs.map((v) => v.id), centroid: unit(sum), vectors: vecs.map((v) => v.vector) };
  }

  it('70 entries with two sub-groups of 20 split into children, with exactly the sub-group members', () => {
    const children = splitInChildren(bigGroup(20, 20, 30, 3), split);
    expect(children).toHaveLength(2);
    const sets = children.map((c) => new Set(c.members));
    const a = sets.find((s) => s.has('a0')) as Set<string>;
    const b = sets.find((s) => s.has('b0')) as Set<string>;
    expect([...a].filter((m) => m.startsWith('a')).length).toBeGreaterThanOrEqual(18);
    expect([...b].filter((m) => m.startsWith('b')).length).toBeGreaterThanOrEqual(18);
    expect([...a].filter((m) => m.startsWith('b')).length).toBe(0);
  });

  it('the children belong to the parent (nobody is invented) and carry what a group carries', () => {
    const parent = bigGroup(20, 20, 30, 3);
    const parentIds = new Set(parent.members);
    for (const child of splitInChildren(parent, split)) {
      expect(child.members.every((m) => parentIds.has(m))).toBe(true);
      expect(Math.hypot(...child.centroid)).toBeCloseTo(1, 5);
      expect(child.vectors).toHaveLength(child.members.length);
      expect(child.members.length).toBeGreaterThanOrEqual(split.childMinSize);
    }
  });

  it('exactly 60 entries split (the bar is inclusive), and a sub-group of exactly the minimum size is a child', () => {
    expect(splitInChildren(bigGroup(20, 20, 20, 3), split)).toHaveLength(2);
    const parent = bigGroup(20, 20, 30, 3);
    const sizes = splitInChildren(parent, split).map((c) => c.members.length);
    const smallest = Math.min(...sizes);
    expect(splitInChildren(parent, { ...split, childMinSize: smallest }).map((c) => c.members.length)).toEqual(sizes);
    expect(splitInChildren(parent, { ...split, childMinSize: smallest + 1 }).length).toBeLessThan(sizes.length);
  });

  it('the coherence of a child is the mean cosine of its members to its centre', () => {
    for (const child of splitInChildren(bigGroup(20, 20, 30, 3), split)) {
      const mean = (child.vectors as Float32Array[]).reduce((t, v) => t + cosine(v, child.centroid), 0) / child.members.length;
      expect(child.coherence).toBeCloseTo(mean, 6);
      expect(child.coherence as number).toBeLessThanOrEqual(1);
    }
  });

  it('70 entries without structure do not split', () => {
    expect(splitInChildren(bigGroup(0, 0, 70, 5), split)).toEqual([]);
  });

  it('fewer than 60 entries never split, even with structure', () => {
    expect(splitInChildren(bigGroup(20, 20, 10, 3), split)).toEqual([]);
  });

  it('sub-groups under 8 are not children', () => {
    expect(splitInChildren(bigGroup(6, 6, 60, 3), split)).toEqual([]);
  });

  it('one child alone is not a split', () => {
    expect(splitInChildren(bigGroup(12, 4, 56, 3), split)).toEqual([]);
  });

  it('a group that carries no vectors cannot be split', () => {
    expect(splitInChildren({ members: Array.from({ length: 80 }, (_, i) => `m${i}`), centroid: ang(0) }, split)).toEqual([]);
  });
});

describe('mergeSame: two collections with almost the same centre and the same name (after cleaning) are one', () => {
  const col = (id: string, name: string, centroid: Float32Array, members: string[]) => ({ id, name, centroid, memberIds: members });
  const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it('the larger one stays; the members are the union, once each; the other id is said to be merged away', () => {
    const out = mergeSame([col('a', 'Vino', ang(0), ids('x', 6)), col('b', 'vino ', ang(5), [...ids('x', 2), ...ids('y', 6)])]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('b');
    expect(out[0].mergedIds).toEqual(['a']);
    expect([...out[0].memberIds].sort()).toEqual([...ids('x', 6), ...ids('y', 6)].sort());
    expect(out[0].name).toBe('vino ');
  });

  it('the name is compared as a person would: case, accents and spaces do not make another name', () => {
    expect(mergeSame([col('a', 'Casa e design', ang(0), ids('x', 6)), col('b', 'CASA  E  DESIGN', ang(3), ids('y', 5))])).toHaveLength(1);
    expect(mergeSame([col('a', 'Musica', ang(0), ids('x', 6)), col('b', 'Música', ang(3), ids('y', 5))])).toHaveLength(1);
  });

  it('close centres with different names stay apart, and the same name with far centres stays apart', () => {
    expect(mergeSame([col('a', 'Vino', ang(0), ids('x', 6)), col('b', 'Cibo', ang(5), ids('y', 5))])).toHaveLength(2);
    expect(mergeSame([col('a', 'Vino', ang(0), ids('x', 6)), col('b', 'Vino', ang(100), ids('y', 5))])).toHaveLength(2);
  });

  it('on a tie in size the id that comes first stays; three of the same name become one', () => {
    const tie = mergeSame([col('b', 'Vino', ang(0), ids('x', 5)), col('a', 'Vino', ang(2), ids('y', 5))]);
    expect(tie[0].id).toBe('a');
    const three = mergeSame([col('a', 'Vino', ang(0), ids('x', 5)), col('b', 'Vino', ang(2), ids('y', 6)), col('c', 'Vino', ang(4), ids('z', 7))]);
    expect(three).toHaveLength(1);
    expect(three[0].id).toBe('c');
    expect([...three[0].mergedIds].sort()).toEqual(['a', 'b']);
  });

  it('the centre of the merged one is the unit vector of the centres weighed by their size; the others come back untouched', () => {
    const out = mergeSame([col('a', 'Vino', ang(0), ids('x', 2)), col('b', 'Vino', ang(10), ids('y', 8)), col('c', 'Altro', ang(90), ids('z', 5))]);
    expect(out).toHaveLength(2);
    const merged = out.find((o) => o.id === 'b')!;
    expect(Math.hypot(...merged.centroid)).toBeCloseTo(1, 5);
    expect(cosine(merged.centroid, ang(8))).toBeGreaterThan(cosine(merged.centroid, ang(5)));       // nearer to the bigger one
    expect(out.find((o) => o.id === 'c')!.mergedIds).toEqual([]);
  });

  it('exactly at the bar is in; a name that cleans to nothing is no name; the merged ids come back in order', () => {
    expect(mergeSame([col('a', 'Vino', ang(0), ids('x', 6)), col('b', 'Vino', ang(0), ids('y', 5))], 1)).toHaveLength(1);
    expect(mergeSame([col('a', '#@"', ang(0), ids('x', 5)), col('b', '***', ang(0), ids('y', 5))])).toHaveLength(2);
    const out = mergeSame([col('z', 'Vino', ang(0), ids('x', 5)), col('a', 'Vino', ang(1), ids('y', 5)), col('m', 'Vino', ang(2), ids('w', 9))]);
    expect(out[0].id).toBe('m');
    expect(out[0].mergedIds).toEqual(['a', 'z']);
  });

  it('without a bar it uses the one for the same name (sameNameTau, lower than the one that merges groups: the name already says they are one thing)', () => {
    const degFor = (c: number): number => (Math.acos(c) * 180) / Math.PI;
    expect(COLLECTION_PARAMS.sameNameTau).toBeLessThan(COLLECTION_PARAMS.mergeTau);
    const near = degFor(COLLECTION_PARAMS.sameNameTau + 0.02);
    const far = degFor(COLLECTION_PARAMS.sameNameTau - 0.02);
    expect(mergeSame([col('a', 'Vino', ang(0), ids('x', 6)), col('b', 'Vino', ang(near), ids('y', 5))])).toHaveLength(1);
    expect(mergeSame([col('a', 'Vino', ang(0), ids('x', 6)), col('b', 'Vino', ang(far), ids('y', 5))])).toHaveLength(2);
    // an explicit bar still rules: the stricter one of the groups keeps the two apart
    expect(mergeSame([col('a', 'Vino', ang(0), ids('x', 6)), col('b', 'Vino', ang(near), ids('y', 5))], COLLECTION_PARAMS.mergeTau)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// discoverCollections and assignToThemes: the ONE pipeline that the calibration preview and the engine share (task 7)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const NO_TYPE_CONTEXT = { typeCentres: { music: null, films: null }, flagged: { music: new Set<string>(), films: new Set<string>() } };

describe('discoverCollections: groups → type and coherence gates → children (the same pipeline for the calibration and for the engine)', () => {
  it('looks at groups of at least `minGroup` entries: the birth size by default, the «watching» size when the engine asks for it', () => {
    const { items } = planted([8, 4, 3, 2], 0.3, 21);
    const byDefault = discoverCollections(items, NO_TYPE_CONTEXT);
    expect(byDefault.groups.map((g) => g.members.length).sort()).toEqual([8]);
    const watching = discoverCollections(items, NO_TYPE_CONTEXT, COLLECTION_PARAMS, COLLECTION_PARAMS.watchingSize);
    expect(watching.groups.map((g) => g.members.length).sort()).toEqual([3, 4, 8]);
    expect(watching.candidates.map((c) => [c.kind, c.parent, c.group.members.length]).sort()).toEqual([['group', null, 3], ['group', null, 4], ['group', null, 8]]);
  });

  it('a group that is about music by its centre is absorbed and is not a candidate; one that is too loose is `loose`', () => {
    const { items, dirs } = planted([8, 7, 9], 0.3, 22);
    const out = discoverCollections(items, { typeCentres: { music: dirs[2], films: null }, flagged: { music: new Set(), films: new Set() } });
    expect(out.absorbed.map((a) => [a.group.members.length, a.type, a.by, a.kind])).toEqual([[9, 'music', 'centre', 'group']]);
    expect(out.candidates.map((c) => c.group.members.length).sort()).toEqual([7, 8]);
    const loose = discoverCollections(items, NO_TYPE_CONTEXT, { ...COLLECTION_PARAMS, groupTau: -1, mergeTau: 2, minCoherence: 0.99 });
    expect(loose.candidates).toHaveLength(0);
    expect(loose.loose).toHaveLength(1);
  });

  it('candidates carry no assignment: that is the caller\'s (the engine decides after the names and the states which themes can take entries)', () => {
    const { items } = planted([8, 7], 0.3, 23);
    const out = discoverCollections(items, NO_TYPE_CONTEXT);
    expect(out.candidates.every((c) => c.kind === 'group' && c.parent === null)).toBe(true);
    expect(Object.keys(out.candidates[0]).sort()).toEqual(['group', 'kind', 'parent']);
  });
});

describe('assignToThemes: every entry joins at most two themes, with the score it has there', () => {
  const themes = [
    { id: 'wine', centroid: ang(0) },
    { id: 'food', centroid: ang(25) },
    { id: 'tech', centroid: ang(120) },
  ];
  const items = [
    { id: 'near-wine', vector: ang(3) },
    { id: 'between', vector: ang(12) },
    { id: 'tech-one', vector: ang(118) },
    { id: 'lost', vector: ang(200) },
  ];

  it('gives each theme the entries that joined it, in the order of the entries, with the cosine as score', () => {
    const out = assignToThemes(items, themes, { assignTau: cosDeg(30), maxThemesPerEntry: 2 });
    expect([...out.keys()].sort()).toEqual(['food', 'tech', 'wine']);
    expect(out.get('wine')!.map((m) => m.entryId)).toEqual(['near-wine', 'between']);
    expect(out.get('food')!.map((m) => m.entryId)).toEqual(['near-wine', 'between']);
    expect(out.get('tech')!.map((m) => m.entryId)).toEqual(['tech-one']);
    expect(out.get('wine')![0].score).toBeCloseTo(cosDeg(3), 5);
    expect(out.get('food')![1].score).toBeCloseTo(cosDeg(13), 5);
  });

  it('an entry that is far from every theme is in none', () => {
    const out = assignToThemes(items, themes, { assignTau: cosDeg(30), maxThemesPerEntry: 2 });
    expect([...out.values()].flat().some((m) => m.entryId === 'lost')).toBe(false);
  });

  it('a theme with nobody is there with an empty list (the caller asks by id)', () => {
    const out = assignToThemes([{ id: 'x', vector: ang(200) }], themes, { assignTau: cosDeg(30), maxThemesPerEntry: 2 });
    expect([...out.entries()].map(([id, list]) => [id, list.length]).sort()).toEqual([['food', 0], ['tech', 0], ['wine', 0]]);
  });

  it('a pair the caller excludes never happens: the entry takes the next theme (the entries taken out of a collection by hand do not come back)', () => {
    const out = assignToThemes(items, themes, { assignTau: cosDeg(30), maxThemesPerEntry: 1 }, (entryId, themeId) => entryId === 'near-wine' && themeId === 'wine');
    expect(out.get('wine')!.map((m) => m.entryId)).toEqual(['between']);
    expect(out.get('food')!.map((m) => m.entryId)).toEqual(['near-wine']);
  });

  it('the maximum is the one of the parameters', () => {
    const three = assignToThemes([{ id: 'x', vector: ang(10) }], [...themes, { id: 'wine2', centroid: ang(5) }], { assignTau: cosDeg(30), maxThemesPerEntry: 3 });
    expect([...three.values()].filter((l) => l.length > 0)).toHaveLength(3);
  });
});

describe('discoverCollections: a big group and its children, with the gate of coherence for each', () => {
  /** A group of 70 (two sub-topics around a shared part, and the rest) among 250 scattered entries, centred on the library mean: the way the engine sees it. */
  function bigWorld(noiseGames = 0.2): Array<{ id: string; vector: Float32Array }> {
    const rand = rng(31);
    const common = randomDirection(rand);
    const d1 = randomDirection(rand);
    const d2 = randomDirection(rand);
    const sub = (d: Float32Array): Float32Array => unit(common.map((x, i) => 1.5 * x + 0.8 * d[i]));
    const raw: Array<{ id: string; vector: Float32Array }> = [];
    for (let i = 0; i < 20; i += 1) raw.push({ id: `anime${i}`, vector: around(sub(d1), 0.2, rand) });
    for (let i = 0; i < 20; i += 1) raw.push({ id: `games${i}`, vector: around(sub(d2), noiseGames, rand) });
    for (let i = 0; i < 30; i += 1) raw.push({ id: `art${i}`, vector: around(common, 0.8, rand) });
    for (let i = 0; i < 250; i += 1) raw.push({ id: `noise${i}`, vector: randomDirection(rand) });
    const { vectors } = centerAndNormalize(raw.map((r) => r.vector));
    return raw.map((r, i) => ({ id: r.id, vector: vectors[i] }));
  }
  const at = (n: number): typeof COLLECTION_PARAMS => ({ ...COLLECTION_PARAMS, minCoherence: n });
  const coherence = (g: Group | undefined): number => g?.coherence as number;
  const isParent = (g: Group): boolean => g.members.length >= 60;

  it('a parent that is too loose is not a candidate, but its children (tight on their own) still are, with no parent', () => {
    const items = bigWorld();
    const all = discoverCollections(items, NO_TYPE_CONTEXT, at(0), COLLECTION_PARAMS.watchingSize);
    const parent = all.candidates.find((c) => isParent(c.group))?.group;
    const kids = all.candidates.filter((c) => c.kind === 'child').map((c) => c.group);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    const bar = (coherence(parent) + Math.min(...kids.map(coherence))) / 2;
    expect(coherence(parent)).toBeLessThan(bar);                             // the parent is looser than every child, so a bar sits between them
    const out = discoverCollections(items, NO_TYPE_CONTEXT, at(bar), COLLECTION_PARAMS.watchingSize);
    expect(out.loose.some(isParent)).toBe(true);
    expect(out.candidates.some((c) => c.kind === 'group' && isParent(c.group))).toBe(false);
    const children = out.candidates.filter((c) => c.kind === 'child');
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(children.every((c) => c.parent === null)).toBe(true);
  });

  it('a child that is too loose is not a candidate (it is loose), and a tight one is', () => {
    const items = bigWorld(0.9);
    const all = discoverCollections(items, NO_TYPE_CONTEXT, at(0), COLLECTION_PARAMS.watchingSize);
    const kids = all.candidates.filter((c) => c.kind === 'child');
    const anime = kids.find((c) => c.group.members[0].startsWith('anime'))?.group;
    const games = kids.find((c) => c.group.members[0].startsWith('games'))?.group;
    expect(coherence(games)).toBeLessThan(coherence(anime));
    const bar = (coherence(games) + coherence(anime)) / 2;
    const out = discoverCollections(items, NO_TYPE_CONTEXT, at(bar), COLLECTION_PARAMS.watchingSize);
    const kept = out.candidates.filter((c) => c.kind === 'child');
    expect(kept.some((c) => c.group.members[0].startsWith('anime'))).toBe(true);
    expect(kept.some((c) => c.group.members[0].startsWith('games'))).toBe(false);
    expect(out.loose.some((g) => g.members[0].startsWith('games'))).toBe(true);
  });

  it('a child that is music or films by its members is a type, never a candidate', () => {
    const items = bigWorld();
    const music = new Set(items.filter((it) => it.id.startsWith('anime')).map((it) => it.id));
    const out = discoverCollections(items, { typeCentres: { music: null, films: null }, flagged: { music, films: new Set() } }, COLLECTION_PARAMS, COLLECTION_PARAMS.watchingSize);
    expect(out.absorbed.some((a) => a.kind === 'child' && a.type === 'music' && a.group.members[0].startsWith('anime'))).toBe(true);
    expect(out.candidates.some((c) => c.kind === 'child' && c.group.members[0].startsWith('anime'))).toBe(false);
  });
});

describe('withinTypeBar: what may be assigned to a theme without making it a type (spec §3.1: no published theme is mostly music or films)', () => {
  const ids = (prefix: string, n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `${prefix}${from + i}`);
  const extra = (entryId: string, score: number): { entryId: string; score: number } => ({ entryId, score });
  const filmsOnly = (members: string[]): { music: Set<string>; films: Set<string> } => ({ music: new Set(), films: new Set(members) });
  const keptIds = (kept: Array<{ entryId: string }>): string[] => kept.map((x) => x.entryId);

  it('entries that are not about music or films all join, however many they are', () => {
    const own = ids('o', 10);
    const extras = ids('p', 40).map((id, i) => extra(id, 0.9 - i * 0.01));
    expect(withinTypeBar(own, extras, filmsOnly(own), 0.7)).toEqual(extras);
  });

  it('an entry with films joins while the share of films stays under the bar, the best score first, and not when it would reach it', () => {
    // 6 of 10 own entries have films (60 %): 7/11, 8/12 and 9/13 are under 70 %, 10/14 is over it
    const own = ids('o', 10);
    const films = filmsOnly([...own.slice(0, 6), ...ids('f', 6)]);
    const extras = ids('f', 6).map((id, i) => extra(id, 0.9 - i * 0.01));
    expect(keptIds(withinTypeBar(own, extras, films, 0.7))).toEqual(['f0', 'f1', 'f2']);
  });

  it('reaching the bar is already too much (7 of 10 is 70 %), and the same entry would have joined a theme that is one entry bigger', () => {
    const films = filmsOnly([...ids('o', 6), 'f0']);
    expect(withinTypeBar(ids('o', 9), [extra('f0', 0.8)], films, 0.7)).toEqual([]);
    expect(keptIds(withinTypeBar(ids('o', 10), [extra('f0', 0.8)], films, 0.7))).toEqual(['f0']);
  });

  it('the bar is the one asked for, and by default the one that makes a group a type (typeMemberShare)', () => {
    const own = ids('o', 10);
    const films = filmsOnly([...own.slice(0, 6), ...ids('f', 6)]);
    const extras = ids('f', 6).map((id, i) => extra(id, 0.9 - i * 0.01));
    expect(withinTypeBar(own, extras, films, 0.95)).toEqual(extras);
    expect(keptIds(withinTypeBar(own, extras, films, 0.65))).toEqual(['f0']);
    // no bar given: 70 % (7 of 10 is already a type)
    expect(withinTypeBar(ids('o', 9), [extra('f0', 0.8)], filmsOnly([...ids('o', 6), 'f0']))).toEqual([]);
    expect(keptIds(withinTypeBar(ids('o', 10), [extra('f0', 0.8)], filmsOnly([...ids('o', 6), 'f0'])))).toEqual(['f0']);
  });

  it('the answer keeps the order of the extras, and the ones that are left out are the worst scores whatever the order they come in', () => {
    const own = ids('o', 10);
    const films = filmsOnly([...own.slice(0, 6), ...ids('f', 6)]);
    const extras = ids('f', 6).map((id, i) => extra(id, 0.9 - i * 0.01)).reverse();      // the worst first
    expect(keptIds(withinTypeBar(own, extras, films, 0.7))).toEqual(['f2', 'f1', 'f0']);
  });

  it('on equal scores the order of the names decides, so that two nights give the same answer', () => {
    const own = ids('o', 10);
    const names = ['fd', 'fc', 'fb', 'fa'];
    const films = filmsOnly([...own.slice(0, 6), ...names]);
    expect(keptIds(withinTypeBar(own, names.map((n) => extra(n, 0.9)), films, 0.7))).toEqual(['fc', 'fb', 'fa']);
  });

  it('the entries that are not about music or films come first: they dilute the share, so more of the others fit', () => {
    const own = ids('o', 10);
    const films = filmsOnly([...own.slice(0, 6), ...ids('f', 4)]);
    const filmExtras = ids('f', 4).map((id, i) => extra(id, 0.9 - i * 0.01));
    const plainExtras = ids('p', 10).map((id, i) => extra(id, 0.5 - i * 0.01));
    expect(keptIds(withinTypeBar(own, [...filmExtras, ...plainExtras], films, 0.7)).sort()).toEqual([...ids('f', 4), ...ids('p', 10)].sort());
  });

  it('music and films are counted apart (an entry is not music or films by being either: the share of EACH is what makes a type)', () => {
    // 5 own entries with songs and 5 with films: 50 % of each. Seven more with songs: 11/16 (69 %) is the last that fits, 12/17 (70.6 %) does not
    const own = ids('o', 10);
    const flagged = { music: new Set([...own.slice(0, 5), ...ids('m', 7)]), films: new Set(own.slice(5)) };
    const extras = ids('m', 7).map((id, i) => extra(id, 0.9 - i * 0.01));
    expect(keptIds(withinTypeBar(own, extras, flagged, 0.7))).toEqual(ids('m', 6));
  });

  it('an entry with both songs and films counts for both (5 of 7 is 71 %, over the bar, for whichever of the two already had 4 of 6)', () => {
    const own = ids('o', 6);
    const songsAlready = { music: new Set([...own.slice(0, 4), 'x']), films: new Set([...own.slice(4), 'x']) };
    const filmsAlready = { music: new Set([...own.slice(4), 'x']), films: new Set([...own.slice(0, 4), 'x']) };
    expect(withinTypeBar(own, [extra('x', 0.8)], songsAlready, 0.7)).toEqual([]);
    expect(withinTypeBar(own, [extra('x', 0.8)], filmsAlready, 0.7)).toEqual([]);
    // an entry with only films is not songs: it dilutes the 4 of 6 with songs (4/7 = 57 %) and the films stay at 3/7
    expect(keptIds(withinTypeBar(own, [extra('x', 0.8)], { music: new Set(own.slice(0, 4)), films: new Set([...own.slice(4), 'x']) }, 0.7))).toEqual(['x']);
  });

  it('the entries the theme already has are never taken out, and are not counted twice', () => {
    const own = ids('o', 10);
    const films = filmsOnly([...own.slice(0, 7), ...ids('f', 3)]);                   // 70 % of its own entries have films
    const extras = [extra('o0', 0.99), extra('o3', 0.95), ...ids('f', 3).map((id, i) => extra(id, 0.9 - i * 0.01))];
    expect(keptIds(withinTypeBar(own, extras, films, 0.7))).toEqual(['o0', 'o3']);
  });

  it('an entry the theme already has does not make room for the others: it is in the theme once, not counted again as a new one', () => {
    // 10 own entries, 6 with films; four of the own ones (without films) come back among the extras, with six new entries with films: still only three fit
    const own = ids('o', 10);
    const films = filmsOnly([...own.slice(0, 6), ...ids('f', 6)]);
    const extras = [...own.slice(6).map((id, i) => extra(id, 0.95 - i * 0.01)), ...ids('f', 6).map((id, i) => extra(id, 0.9 - i * 0.01))];
    expect(keptIds(withinTypeBar(own, extras, films, 0.7))).toEqual([...own.slice(6), 'f0', 'f1', 'f2']);
  });

  it('with nothing to add the answer is empty, and the extras are never changed in place', () => {
    expect(withinTypeBar(ids('o', 10), [], filmsOnly(ids('o', 6)), 0.7)).toEqual([]);
    const extras = [extra('f1', 0.5), extra('f0', 0.9)];
    const copy = JSON.parse(JSON.stringify(extras));
    withinTypeBar(ids('o', 10), extras, filmsOnly([...ids('o', 6), 'f0', 'f1']), 0.7);
    expect(extras).toEqual(copy);
  });
});
