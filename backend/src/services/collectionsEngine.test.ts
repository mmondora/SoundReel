import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCollectionsStore, type CollectionInput, type CollectionRow } from './collectionsStore';
import { assignToThemes, centerAndNormalize, cosine } from './collectionsCluster';
import { seedGroupOf, type NamedGroup, type NamingGroup } from './collectionsNaming';
import { COLLECTION_PARAMS } from './collectionsParams';
import {
  UNNAMED,
  assignOne,
  consolidate,
  foldSameName,
  inheritRelaxed,
  planConsolidation,
  rebuildPreview,
  resolveTarget,
  type AssignOneDeps,
  type Cand,
  type EngineDeps,
  type EntryFeatures,
  type Existing,
  type PlannedCollection,
} from './collectionsEngine';

// Raccolte, task 7 (spec 2026-11-09-library-collections-auto-topics-design.md §5, §9; plan task 7): the nightly consolidation of the collections, with the
// in-memory store and synthetic vectors (no database, no model, no network). The names come from a fake namer that reads the first word of the posts.

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// synthetic world
// ---------------------------------------------------------------------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const DIM = 48;
const gauss = (rand: () => number): number => rand() + rand() + rand() + rand() - 2;
const unit = (v: Float32Array): Float32Array => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n === 0 ? v : v.map((x) => x / n);
};
const randomDir = (rand: () => number): Float32Array => unit(Float32Array.from({ length: DIM }, () => gauss(rand)));
const around = (dir: Float32Array, noise: number, rand: () => number): Float32Array => unit(dir.map((x) => x + (noise * gauss(rand)) / Math.sqrt(DIM)));
const dot = (a: Float32Array, b: Float32Array): number => a.reduce((t, x, i) => t + x * b[i], 0);

function farDirs(count: number, rand: () => number): Float32Array[] {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const dirs = Array.from({ length: count }, () => randomDir(rand));
    let far = true;
    for (let i = 0; i < dirs.length; i += 1) for (let j = i + 1; j < dirs.length; j += 1) if (Math.abs(dot(dirs[i], dirs[j])) >= 0.2) far = false;
    if (far) return dirs;
  }
  throw new Error('no directions far enough');
}

const MIKE = 'mike';
const SARA = 'sara';

/** The names the fake namer gives to a group whose posts start with this word. */
const NAMES: Record<string, string> = {
  wine: 'Vino',
  food: 'Ristoranti',
  tech: 'Intelligenza artificiale',
  home: 'Casa e design',
  anime: 'Anime',
  games: 'Giochi',
  art: 'Arte e cultura',
  wineb: 'Vino',
};

/** A little world: entries with a vector in the store and the facts the engine asks for; a fake namer that counts its calls. */
class Lab {
  readonly store = new MemoryCollectionsStore();
  readonly features = new Map<string, EntryFeatures>();
  readonly calls: NamingGroup[] = [];
  names: Record<string, string | undefined> = { ...NAMES };
  /** Called instead of the default namer when set. */
  namer: ((g: NamingGroup) => Promise<NamedGroup | null>) | null = null;
  private clock = Date.UTC(2026, 0, 1);
  private nextId = 0;
  readonly vectors = new Map<string, Float32Array>();

  async add(id: string, vector: Float32Array, over: Partial<EntryFeatures> & { owner?: string; key?: string } = {}): Promise<void> {
    this.clock += 60_000;
    this.store.registerEntry({ id, ownerUser: over.owner ?? MIKE, createdAt: new Date(this.clock).toISOString() });
    await this.store.saveVector(id, 'test-model', Array.from(vector), `hash-${id}`);
    this.vectors.set(id, vector);
    const key = over.key ?? id.replace(/\d+$/, '');
    this.features.set(id, { text: over.text ?? `${key} post ${id}`, tags: over.tags ?? [`#${key}`], hasContentSongs: over.hasContentSongs ?? false, hasFilms: over.hasFilms ?? false });
  }

  async cluster(key: string, dir: Float32Array, n: number, rand: () => number, over: Partial<EntryFeatures> & { owner?: string; noise?: number; from?: number } = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let i = over.from ?? 0; i < (over.from ?? 0) + n; i += 1) {
      const id = `${key}${i}`;
      await this.add(id, around(dir, over.noise ?? 0.3, rand), { ...over, key });
      ids.push(id);
    }
    return ids;
  }

  async noise(count: number, rand: () => number, owner = MIKE): Promise<void> {
    for (let i = 0; i < count; i += 1) await this.add(`noise${i}`, randomDir(rand), { key: 'noise', owner });
  }

  /** What the fake namer says: the name of the word most posts of the group start with, or nothing. */
  private async defaultNamer(g: NamingGroup): Promise<NamedGroup | null> {
    const counts = new Map<string, number>();
    for (const m of g.members) counts.set(m.text.split(' ')[0], (counts.get(m.text.split(' ')[0]) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    const name = best ? this.names[best] : undefined;
    return name ? { name, group: seedGroupOf(name) } : null;
  }

  deps(over: Partial<EngineDeps> = {}): EngineDeps {
    return {
      store: this.store,
      features: async (_user, ids) => new Map(ids.flatMap((id) => (this.features.has(id) ? [[id, this.features.get(id) as EntryFeatures] as const] : []))),
      nameGroup: async (g) => {
        this.calls.push(g);
        return this.namer ? this.namer(g) : this.defaultNamer(g);
      },
      newId: () => `c${++this.nextId}`,
      ...over,
    };
  }

  /** A fast path that writes through the store (the real one is a SQL insert): rewrites every collection with the new member. */
  assignDeps(): AssignOneDeps {
    return {
      store: this.store,
      addMembers: async (userId, additions) => {
        const rows = await this.store.listCollections(userId);
        const inputs: CollectionInput[] = [];
        for (const r of rows) {
          const members = (await this.store.membersOf(r.id)).filter((m) => m.source === 'auto').map((m) => ({ entryId: m.entryId, score: m.score }));
          for (const a of additions) if (a.collectionId === r.id && !members.some((m) => m.entryId === a.entryId)) members.push({ entryId: a.entryId, score: a.score });
          inputs.push({ id: r.id, name: r.name, groupLabel: r.groupLabel, parentId: r.state === 'merged' ? null : r.parentId, state: r.state === 'watching' ? 'watching' : 'active', origin: r.origin, centroid: r.centroid, coherence: r.coherence, members });
        }
        await this.store.saveCollections(userId, inputs);
      },
    };
  }

  async rows(user = MIKE): Promise<CollectionRow[]> {
    return this.store.listCollections(user);
  }

  async byName(name: string, user = MIKE): Promise<CollectionRow | undefined> {
    return (await this.rows(user)).find((r) => r.name === name);
  }

  async memberIds(id: string): Promise<string[]> {
    return (await this.store.membersOf(id)).map((m) => m.entryId).sort();
  }

  /** The whole answer of the store for a user: what two passes on the same data must reproduce exactly. */
  async snapshot(user = MIKE): Promise<unknown> {
    const rows = await this.rows(user);
    return Promise.all(rows.map(async (r) => ({ id: r.id, name: r.name, nameBy: r.nameBy, groupLabel: r.groupLabel, parentId: r.parentId, state: r.state, origin: r.origin, members: await this.memberIds(r.id) })));
  }
}

const wineIds = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `wine${from + i}`);

/** Three topics, a group too small to be born and the noise of a real library: the usual start. */
async function threeTopics(lab: Lab, seed = 3): Promise<{ dirs: Float32Array[]; rand: () => number }> {
  const rand = rng(seed);
  const dirs = farDirs(5, rand);
  await lab.cluster('wine', dirs[0], 8, rand);
  await lab.cluster('food', dirs[1], 7, rand);
  await lab.cluster('tech', dirs[2], 6, rand);
  await lab.cluster('home', dirs[3], 3, rand);
  await lab.noise(30, rand);
  return { dirs, rand };
}

let lab: Lab;
beforeEach(() => {
  lab = new Lab();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// inheritRelaxed: the second round of inheritance, on its boundaries
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe('inheritRelaxed: a group takes an old collection that was a union or a split when it is mostly inside it and a good part of it', () => {
  const cand = (index: number, members: string[], old: Existing | null = null): Cand => ({
    index, kind: 'group', parent: null, group: { members, centroid: new Float32Array(2) }, old, aliasOf: null, name: null, nameBy: 'auto', id: '', isNew: true, folded: false, state: 'watching', members: new Map(),
  });
  const oldOf = (id: string, auto: string[]): Existing => ({
    row: { id, ownerUser: 'mike', name: 'X', nameBy: 'auto', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, size: auto.length, coherence: null, createdAt: '', updatedAt: '' },
    auto,
  });
  const names = (prefix: string, n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `${prefix}${from + i}`);
  const holds = (c: Cand): string[] => c.group.members;
  const run = (cands: Cand[], pool: Existing[], taken: Set<string> = new Set()): void => inheritRelaxed(cands, holds, pool, taken);

  it('a quarter of the old members is the least: exactly a quarter is in, one less is out', () => {
    const pool = [oldOf('o', names('a', 20))];
    const exact = cand(0, names('a', 5));
    run([exact], pool);
    expect(exact.old?.row.id).toBe('o');
    const under = cand(0, names('a', 4));
    run([under], pool);
    expect(under.old).toBeNull();
  });

  it('half of what the group holds must be inside the old collection: exactly half is in, a little less is out, and 60 % is plenty (the bar is not higher)', () => {
    const pool = [oldOf('o', names('a', 8))];
    const half = cand(0, [...names('a', 5), ...names('z', 5)]);       // 5 of 10
    run([half], pool);
    expect(half.old?.row.id).toBe('o');
    const less = cand(0, [...names('a', 4), ...names('z', 6)]);       // 4 of 10
    run([less], pool);
    expect(less.old).toBeNull();
    const sixty = cand(0, [...names('a', 6), ...names('z', 4)]);      // 6 of 10
    run([sixty], [oldOf('o', names('a', 12))]);
    expect(sixty.old?.row.id).toBe('o');
  });

  it('the larger overlap goes first, the first group on a tie; an old collection goes to one group only', () => {
    const pool = [oldOf('o', names('a', 30))];
    const small = cand(0, names('a', 8));
    const big = cand(1, names('a', 12, 8));
    run([small, big], pool);
    expect(big.old?.row.id).toBe('o');
    expect(small.old).toBeNull();
    const first = cand(0, names('a', 8));
    const second = cand(1, names('a', 8, 8));
    run([second, first], [oldOf('o', names('a', 30))]);                // the first of the two (by index) wins the tie, whatever the order they are listed in
    expect(first.old?.row.id).toBe('o');
    expect(second.old).toBeNull();
  });

  it('a group takes the old collection it overlaps most, and takes one only', () => {
    const near = oldOf('near', names('a', 20));
    const far = oldOf('far', [...names('a', 6), ...names('q', 14)]);
    const group = cand(0, names('a', 10));
    run([group], [far, near]);
    expect(group.old?.row.id).toBe('near');
  });

  it('a group that already has its collection keeps it, and one that is already taken is not offered again', () => {
    const mine = oldOf('mine', names('b', 10));
    const better = oldOf('better', names('a', 10));
    const has = cand(0, names('a', 10), mine);
    run([has], [better]);
    expect(has.old?.row.id).toBe('mine');
    const taken = new Set(['better']);
    const wants = cand(1, names('a', 10));
    run([wants], [better], taken);
    expect(wants.old).toBeNull();
  });

  it('an old collection that has no automatic members is never taken, and neither is one the group does not touch', () => {
    const group = cand(0, names('a', 10));
    run([group], [oldOf('empty', []), oldOf('elsewhere', names('z', 10))]);
    expect(group.old).toBeNull();
  });

  it('what it takes is remembered as taken', () => {
    const taken = new Set<string>();
    run([cand(0, names('a', 10))], [oldOf('o', names('a', 12))], taken);
    expect([...taken]).toEqual(['o']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// consolidate
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe('foldSameName: groups with one name and almost one centre are one collection', () => {
  const vec = (x: number, y: number): Float32Array => unit(Float32Array.from([x, y, 0]));
  const vectors = new Map<string, Float32Array>([
    ['k0', vec(1, 0.1)], ['k1', vec(1, -0.1)], ['k2', vec(1, 0.2)], ['k3', vec(1, 0)],
    ['f0', vec(0.8, 0.5)], ['f1', vec(0.8, 0.7)], ['f2', vec(0.7, 0.6)],
    ['g0', vec(0.9, 0.4)], ['g1', vec(0.9, 0.3)],
  ]);
  const K = (): Cand => cand(0, 'Vino', ['k0', 'k1', 'k2', 'k3'], vec(1, 0));
  const F = (): Cand => cand(1, 'Vino', ['f0', 'f1', 'f2'], vec(0.8, 0.6));                      // 0.8 from the centre of K: closer than the 0.45 that says «the same»
  function cand(index: number, name: string | null, members: string[], centroid: Float32Array, over: Partial<Cand> = {}): Cand {
    return { index, kind: 'group', parent: null, group: { members, centroid }, old: null, aliasOf: null, name, nameBy: 'auto', id: `new${index}`, isNew: true, folded: false, state: 'watching', members: new Map(), ...over };
  }
  const oldOf = (id: string): Existing => ({
    row: { id, ownerUser: 'mike', name: 'Vino', nameBy: 'auto', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, size: 4, coherence: null, createdAt: '', updatedAt: '' },
    auto: [],
  });

  it('the larger one stays, the other is folded into it, and the entries are the union once each', () => {
    const [k, f] = [K(), F()];
    foldSameName([k, f], vectors);
    expect([k.folded, f.folded]).toEqual([false, true]);
    expect([...k.group.members].sort()).toEqual(['f0', 'f1', 'f2', 'k0', 'k1', 'k2', 'k3']);
    const small = cand(0, 'Vino', ['f0', 'f1', 'f2'], vec(0.8, 0.6));
    const big = cand(1, 'Vino', ['k0', 'k1', 'k2', 'k3'], vec(1, 0));
    foldSameName([small, big], vectors);
    expect([small.folded, big.folded]).toEqual([true, false]);
  });

  it('the centre of the union is the centres weighed by size, and the coherence is the one of the union round it', () => {
    const [k, f] = [K(), F()];
    foldSameName([k, f], vectors);
    const centre = unit(Float32Array.from([0, 1, 2].map((i) => 4 * vec(1, 0)[i] + 3 * vec(0.8, 0.6)[i])));          // 4 entries at the centre of K, 3 at the one of F
    for (let i = 0; i < 3; i += 1) expect(k.group.centroid[i]).toBeCloseTo(centre[i], 5);
    const own = ['k0', 'k1', 'k2', 'k3', 'f0', 'f1', 'f2'];
    const expected = own.reduce((t, id) => t + cosine(vectors.get(id) as Float32Array, k.group.centroid), 0) / own.length;
    expect(k.group.coherence).toBeCloseTo(expected, 6);
    expect(k.group.vectors).toHaveLength(7);
    // and it is not the coherence of the group that stayed on its own centre
    const alone = ['k0', 'k1', 'k2', 'k3'].reduce((t, id) => t + cosine(vectors.get(id) as Float32Array, vec(1, 0)), 0) / 4;
    expect(Math.abs((k.group.coherence as number) - alone)).toBeGreaterThan(0.001);
  });

  it('the children of the one that is folded become children of the one that stays', () => {
    const [k, f] = [K(), F()];
    const ofGone = cand(2, 'Rosso', ['f0'], vec(0.7, 0.7), { kind: 'child', parent: 1 });
    const ofKeeper = cand(3, 'Bianco', ['k0'], vec(1, 0.3), { kind: 'child', parent: 0 });
    const loose = cand(4, 'Rosato', ['g0'], vec(0.9, 0.4), { kind: 'child', parent: null });
    foldSameName([k, f, ofGone, ofKeeper, loose], vectors);
    expect([ofGone.parent, ofKeeper.parent, loose.parent]).toEqual([0, 0, null]);
  });

  it('the one that stays takes the old collection of the one that is folded when it has none (so the id and the name are not lost), and keeps its own when it has one', () => {
    const [k, f] = [K(), F()];
    f.old = oldOf('oldF');
    f.id = 'oldF';
    f.isNew = false;
    foldSameName([k, f], vectors);
    expect([k.old?.row.id, k.id, k.isNew]).toEqual(['oldF', 'oldF', false]);

    const [k2, f2] = [K(), F()];
    k2.old = oldOf('oldK');
    k2.id = 'oldK';
    k2.isNew = false;
    f2.old = oldOf('oldF');
    f2.id = 'oldF';
    f2.isNew = false;
    foldSameName([k2, f2], vectors);
    expect([k2.old?.row.id, k2.id, k2.isNew]).toEqual(['oldK', 'oldK', false]);
  });

  it('three groups with one name are one: the larger stays and both others are folded', () => {
    const [k, f] = [K(), F()];
    const g = cand(2, 'Vino', ['g0', 'g1'], vec(0.9, 0.35));
    foldSameName([k, f, g], vectors);
    expect([k.folded, f.folded, g.folded]).toEqual([false, true, true]);
    expect(k.group.members).toHaveLength(9);
  });

  it('spaces, case and accents do not make two names different', () => {
    const k = cand(0, 'Claude Code', ['k0', 'k1', 'k2', 'k3'], vec(1, 0));
    const f = cand(1, 'ClaudeCode', ['f0', 'f1', 'f2'], vec(0.8, 0.6));
    foldSameName([k, f], vectors);
    expect(f.folded).toBe(true);
  });

  it('nothing is folded when the names differ, when the centres are far apart, when a group has no name, or when a group is a merged collection of the user', () => {
    const differ = [K(), { ...F(), name: 'Birra' }];
    foldSameName(differ, vectors);
    expect(differ.map((c) => c.folded)).toEqual([false, false]);

    const far = [K(), cand(1, 'Vino', ['f0', 'f1', 'f2'], vec(0.2, 1))];                        // 0.2 from the centre of K
    foldSameName(far, vectors);
    expect(far.map((c) => c.folded)).toEqual([false, false]);

    const unnamed = [cand(0, null, ['k0', 'k1', 'k2', 'k3'], vec(1, 0)), cand(1, null, ['f0', 'f1', 'f2'], vec(0.8, 0.6))];
    foldSameName(unnamed, vectors);
    expect(unnamed.map((c) => c.folded)).toEqual([false, false]);

    const keeper = K();
    const alias = { ...F(), aliasOf: 'somewhere' };
    const before = keeper.group;
    foldSameName([keeper, alias], vectors);
    expect([keeper.folded, alias.folded, keeper.group]).toEqual([false, false, before]);
  });

  it('a group that nothing is folded into keeps its own entries, centre and coherence (the same object)', () => {
    const k = K();
    const before = k.group;
    foldSameName([k], vectors);
    expect(k.group).toBe(before);
    expect(k.group.coherence).toBeUndefined();
  });
});

describe('resolveTarget: where a merged collection keeps feeding', () => {
  const row = (id: string, state: CollectionRow['state'], parentId: string | null): Existing => ({
    row: { id, ownerUser: 'mike', name: id, nameBy: 'auto', groupLabel: null, parentId, state, origin: 'found', centroid: null, size: 0, coherence: null, createdAt: '', updatedAt: '' },
    auto: [],
  });
  const world = (...rows: Existing[]): Map<string, Existing> => new Map(rows.map((r) => [r.row.id, r]));

  it('a collection that is not merged is its own target', () => {
    const w = world(row('a', 'active', null));
    expect(resolveTarget(w.get('a')!.row, w)).toBe('a');
  });

  it('a merged one feeds the collection it was merged into, however many merges lie between (a into b, b into c)', () => {
    const w = world(row('a', 'merged', 'b'), row('b', 'merged', 'c'), row('c', 'active', null));
    expect(resolveTarget(w.get('a')!.row, w)).toBe('c');
    expect(resolveTarget(w.get('b')!.row, w)).toBe('c');
  });

  it('a merge that goes round in a circle has no target (and does not loop forever)', () => {
    const w = world(row('a', 'merged', 'b'), row('b', 'merged', 'a'));
    expect(resolveTarget(w.get('a')!.row, w)).toBeNull();
    expect(resolveTarget(w.get('b')!.row, w)).toBeNull();
  });

  it('a merged one that points nowhere, or at a collection that is not there, has no target', () => {
    const w = world(row('a', 'merged', null), row('b', 'merged', 'gone'));
    expect(resolveTarget(w.get('a')!.row, w)).toBeNull();
    expect(resolveTarget(w.get('b')!.row, w)).toBeNull();
  });
});

describe('consolidate: the groups of a user become collections', () => {
  it('a user with no vectors: an empty answer, no crash, the model is never asked', async () => {
    const out = await consolidate(MIKE, lab.deps());
    expect(out.entries).toBe(0);
    expect(out.collections).toEqual([]);
    expect(lab.calls).toHaveLength(0);
    expect(await lab.rows()).toEqual([]);
  });

  it('three topics are named and born; the group of 3 is only «watching», with no name and no question to the model', async () => {
    await threeTopics(lab);
    const out = await consolidate(MIKE, lab.deps());
    const rows = await lab.rows();
    expect(rows.map((r) => [r.name, r.state]).sort()).toEqual([['Intelligenza artificiale', 'active'], ['Ristoranti', 'active'], [UNNAMED, 'watching'], ['Vino', 'active']]);
    expect(lab.calls).toHaveLength(3);                                      // wine, food, tech: not the group of 3, not the noise
    expect(out.published).toBe(3);
    expect(out.watching).toBe(1);
    expect(out.created).toBe(4);
    expect(out.modelCalls).toBe(3);
    expect(out.entries).toBe(54);
  });

  it('every entry of a group is in its collection (and the noise is in none); the collections come from the table of names: heading and origin', async () => {
    await threeTopics(lab);
    await consolidate(MIKE, lab.deps());
    const wine = (await lab.byName('Vino')) as CollectionRow;
    expect(await lab.memberIds(wine.id)).toEqual(expect.arrayContaining(wineIds(8)));
    expect((await lab.memberIds(wine.id)).filter((m) => m.startsWith('noise'))).toEqual([]);
    expect([wine.groupLabel, wine.origin, wine.nameBy]).toEqual(['Cibo e bevande', 'seed', 'auto']);
    const tech = (await lab.byName('Intelligenza artificiale')) as CollectionRow;
    expect(tech.groupLabel).toBe('Tecnologia');
    const small = (await lab.byName(UNNAMED)) as CollectionRow;
    expect([small.groupLabel, small.origin]).toEqual([null, 'found']);
    expect(small.size).toBeGreaterThanOrEqual(3);
    expect(small.size).toBeLessThan(5);
  });

  it('a name that is not in the list is a «found» collection under «Altre» (no heading)', async () => {
    await threeTopics(lab);
    lab.names.tech = 'Droni';
    await consolidate(MIKE, lab.deps());
    const droni = (await lab.byName('Droni')) as CollectionRow;
    expect([droni.groupLabel, droni.origin]).toEqual([null, 'found']);
  });

  it('keeps the centre and the coherence of the group, and the scores of the members (the nearest first)', async () => {
    await threeTopics(lab);
    await consolidate(MIKE, lab.deps());
    const wine = (await lab.byName('Vino')) as CollectionRow;
    expect(wine.centroid).not.toBeNull();
    expect(wine.coherence as number).toBeGreaterThan(COLLECTION_PARAMS.minCoherence);
    const members = await lab.store.membersOf(wine.id);
    expect(members.length).toBeGreaterThanOrEqual(8);
    expect(members.every((m) => m.score <= 1 + 1e-6)).toBe(true);
    expect([...members].sort((a, b) => b.score - a.score)).toEqual(members);
  });

  it('two passes on the same data give the same ids, names and members: nothing flickers, and the model is not asked again', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const first = await lab.snapshot();
    const asked = lab.calls.length;
    const second = await consolidate(MIKE, deps);
    expect(await lab.snapshot()).toEqual(first);
    expect(lab.calls.length).toBe(asked);
    expect(second.created).toBe(0);
    expect(second.inherited).toBe(4);
    expect(second.modelCalls).toBe(0);
  });

  it('a new entry near the centre of a collection joins it at the next pass, and the collection keeps its id', async () => {
    const { dirs, rand } = await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const before = (await lab.byName('Vino')) as CollectionRow;
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    await consolidate(MIKE, deps);
    const after = (await lab.byName('Vino')) as CollectionRow;
    expect(after.id).toBe(before.id);
    expect(await lab.memberIds(after.id)).toContain('wine8');
  });

  it('is born at exactly 5 entries and not at 4; an active one stays at 3 and 4; below 3 it is gone (spec §5.4)', async () => {
    const rand = rng(5);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 4, rand);
    await lab.noise(25, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    expect(await lab.byName(UNNAMED)).toMatchObject({ state: 'watching', size: 4 });
    expect(lab.calls).toHaveLength(0);                                      // a group of 4 is not worth a question

    await lab.add('wine4', around(d, 0.3, rand), { key: 'wine' });
    await consolidate(MIKE, deps);
    const born = (await lab.rows()).find((r) => r.state === 'active') as CollectionRow;
    expect(born.name).toBe('Vino');
    expect(born.size).toBeGreaterThanOrEqual(5);

    lab.store.deleteEntry('wine0');
    lab.store.deleteEntry('wine1');                                         // 3 left
    await consolidate(MIKE, deps);
    expect(await lab.byName('Vino')).toMatchObject({ id: born.id, state: 'active' });

    lab.store.deleteEntry('wine2');                                         // 2 left: gone
    await consolidate(MIKE, deps);
    expect(await lab.byName('Vino')).toBeUndefined();
  });

  it('the vectors of a user are only his: two users never mix, and one does not change the other\'s collections', async () => {
    const rand = rng(9);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('wine', dirs[0], 6, rand, { owner: SARA, from: 100 });
    await lab.cluster('food', dirs[1], 7, rand, { owner: SARA });
    await lab.noise(20, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const mike = await lab.rows(MIKE);
    expect(mike.map((r) => r.name)).toEqual(['Vino']);
    expect((await lab.memberIds(mike[0].id)).every((m) => m.startsWith('wine') && Number(m.slice(4)) < 100 || m.startsWith('noise'))).toBe(true);
    expect(await lab.rows(SARA)).toEqual([]);
    await consolidate(SARA, deps);
    const sara = await lab.rows(SARA);
    expect(sara.map((r) => r.name).sort()).toEqual(['Ristoranti', 'Vino']);
    expect((await lab.memberIds(sara.find((r) => r.name === 'Vino')?.id as string)).some((m) => Number(m.slice(4)) < 100 && m.startsWith('wine'))).toBe(false);
    expect((await lab.rows(MIKE)).map((r) => r.id)).toEqual(mike.map((r) => r.id));
  });

  it('a vector of another length (an old model) is left out, not a crash', async () => {
    await threeTopics(lab);
    lab.store.registerEntry({ id: 'odd', ownerUser: MIKE });
    await lab.store.saveVector('odd', 'old-model', [1, 0, 0], 'h-odd');
    const out = await consolidate(MIKE, lab.deps());
    expect(out.skippedDimensions).toBe(1);
    expect(out.entries).toBe(54);
    expect((await lab.rows()).length).toBe(4);
  });

  it('a group that is about music (songs from the content in most of its entries) is the type «Musica», not a theme', async () => {
    const rand = rng(4);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('music', dirs[1], 9, rand, { hasContentSongs: true });
    await lab.noise(25, rand);
    lab.names.music = 'Anime';                                              // the model would happily name it: it must never be asked
    await consolidate(MIKE, lab.deps());
    expect((await lab.rows()).map((r) => r.name)).toEqual(['Vino']);
    expect(lab.calls).toHaveLength(1);
  });
});

describe('consolidate: the naming', () => {
  it('a name the model could not give: the group stays «watching» with no name and is asked again at the next pass, with the same id', async () => {
    await threeTopics(lab);
    lab.names.wine = undefined;
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const unnamed = (await lab.rows()).filter((r) => r.name === UNNAMED);
    expect(unnamed.map((r) => [r.state, r.size >= 8])).toContainEqual(['watching', true]);
    expect(lab.calls).toHaveLength(3);

    lab.names.wine = 'Vino';
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    expect(wine.state).toBe('active');
    expect(unnamed.map((r) => r.id)).toContain(wine.id);                    // the same collection, now named
    expect(lab.calls).toHaveLength(4);                                      // only the unnamed one was asked again
  });

  it('a model that throws is a group that stays unnamed, not a failed pass', async () => {
    await threeTopics(lab);
    lab.namer = async () => {
      throw new Error('router down');
    };
    const out = await consolidate(MIKE, lab.deps());
    expect((await lab.rows()).every((r) => r.state === 'watching' && r.name === UNNAMED)).toBe(true);
    expect(out.published).toBe(0);
  });

  it('a name the user gave is never touched, and the model is not asked about it', async () => {
    const { dirs, rand } = await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    await lab.store.rename(MIKE, wine.id, 'Le mie bottiglie');
    const asked = lab.calls.length;
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    await consolidate(MIKE, deps);
    const after = (await lab.rows()).find((r) => r.id === wine.id) as CollectionRow;
    expect([after.name, after.nameBy]).toEqual(['Le mie bottiglie', 'user']);
    expect(lab.calls.length).toBe(asked);
    expect(await lab.byName('Vino')).toBeUndefined();
  });

  it('a name the engine gave stays while the group is the same one; a group that lost its identity (the old members are a small part of it) is named again', async () => {
    const rand = rng(12);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.noise(200, rand);                                             // a real library: no topic is most of it, so the mean stays small
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    // the group grows to four times its size (the same topic): the name stays and the model is not asked
    await lab.cluster('wine', dirs[0], 24, rand, { from: 8 });
    await consolidate(MIKE, deps);
    expect(await lab.byName('Vino')).toMatchObject({ id: wine.id });
    expect(lab.calls).toHaveLength(1);
    // the posts about wine are now a small part of a group about something else (the model says so): the same collection is named again
    lab.names.food = 'Ristoranti';
    for (const id of [...Array(32)].map((_, i) => `wine${i}`)) lab.features.set(id, { text: `food post ${id}`, tags: ['#food'], hasContentSongs: false, hasFilms: false });
    await lab.cluster('food', dirs[0], 120, rand, { noise: 0.3, from: 0 });
    await consolidate(MIKE, deps);
    expect(await lab.byName('Ristoranti')).toBeDefined();
  });

  it('two different groups that the model names alike: the larger keeps the name, the other stays «watching» and unnamed (and is asked again)', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('wineb', dirs[1], 6, rand, { tags: [] });             // «wineb» is also «Vino» for the fake model, and has no tag to be named by
    await lab.noise(25, rand);
    await consolidate(MIKE, lab.deps());
    const rows = await lab.rows();
    expect(rows.filter((r) => r.name === 'Vino')).toHaveLength(1);
    const small = rows.find((r) => r.name === UNNAMED) as CollectionRow;
    expect(small.state).toBe('watching');
    expect(small.size).toBe(6);
    expect((await lab.byName('Vino'))?.size).toBeGreaterThanOrEqual(8);
  });

  it('a group that loses the name to a bigger one is named by the tag most of its posts share (spec §5.5 c), with no question to the model', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('wineb', dirs[1], 6, rand, { tags: ['#bottiglie', '#altro'] });
    await lab.noise(25, rand);
    await consolidate(MIKE, lab.deps());
    const rows = await lab.rows();
    expect(rows.find((r) => r.name === 'Vino')?.state).toBe('active');
    const second = rows.find((r) => r.name === 'Bottiglie') as CollectionRow;
    expect([second.state, second.origin, second.groupLabel]).toEqual(['active', 'found', null]);
    expect(rows.some((r) => r.name === UNNAMED && r.size >= 5)).toBe(false);
    expect(lab.calls).toHaveLength(2);                                      // one question for each group, none for the second try
  });

  it('a tag that is a name already in use does not name the loser: it stays unnamed', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('wineb', dirs[1], 6, rand, { tags: ['#vino'] });
    await lab.noise(25, rand);
    await consolidate(MIKE, lab.deps());
    expect((await lab.rows()).filter((r) => r.name === 'Vino')).toHaveLength(1);
    expect((await lab.rows()).some((r) => r.name === UNNAMED && r.size >= 6)).toBe(true);
  });

  it('a name the model spells a little wrong is the name of the list («Intelligence Artificiale» is «Intelligenza artificiale»), with its heading', async () => {
    await threeTopics(lab);
    lab.names.tech = 'Intelligence Artificiale';
    await consolidate(MIKE, lab.deps());
    const tech = (await lab.byName('Intelligenza artificiale')) as CollectionRow;
    expect([tech.groupLabel, tech.origin]).toEqual(['Tecnologia', 'seed']);
    expect(await lab.byName('Intelligence Artificiale')).toBeUndefined();
  });

  it('a new name that is not near a name of the list stays as it is, and a short one is never snapped', async () => {
    await threeTopics(lab);
    lab.names.tech = 'Droni';
    lab.names.food = 'Anim';                                                // short: it would be «Anime» for any distance bar
    await consolidate(MIKE, lab.deps());
    expect(await lab.byName('Droni')).toBeDefined();
    expect(await lab.byName('Anim')).toBeDefined();
  });

  it('a collection made of two groups (and of the entries the assignment added) is found again at the next pass: the same id, nothing born, nothing lost', async () => {
    const rand = rng(16);
    const [c, d1, d2] = [randomDir(rand), randomDir(rand), randomDir(rand)];
    await lab.cluster('wine', unit(c.map((x, i) => x + d1[i])), 12, rand, { noise: 1.3 });
    await lab.cluster('wineb', unit(c.map((x, i) => x + d2[i])), 9, rand, { noise: 1.3 });
    await lab.noise(250, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const first = await lab.snapshot();
    const asked = lab.calls.length;
    const second = await consolidate(MIKE, deps);
    expect(await lab.snapshot()).toEqual(first);
    expect(second.created).toBe(0);
    expect(second.dropped).toBe(0);
    expect(lab.calls.length - asked).toBeLessThanOrEqual(1);                // at most the group that was folded into the other is asked again
  });

  it('a collection that holds many more entries than its group (the ones the assignment added) is found by its group the next night: the old members are what it HOLDS', async () => {
    // a lenient assignment: the 8 entries of the topic hold, besides themselves, every entry that leans a little their way (two themes at most for each)
    const rand = rng(41);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('food', dirs[1], 12, rand);
    await lab.noise(80, rand);
    const deps = lab.deps({ params: { ...COLLECTION_PARAMS, assignTau: -1 } });
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    expect((await lab.memberIds(wine.id)).length).toBeGreaterThanOrEqual(24);       // 8 of its own, at least twice as many that joined it
    const second = await consolidate(MIKE, deps);
    expect(second.created).toBe(0);
    expect(second.dropped).toBe(0);
    expect((await lab.byName('Vino'))?.id).toBe(wine.id);
  });

  it('an old collection that was a union of several groups (none of them half of it) goes on in the LARGEST of them, with its id and its name; the others do not take it', async () => {
    const rand = rng(52);
    const dirs = farDirs(4, rand);
    lab.names.winec = 'Vino';
    const a = await lab.cluster('wine', dirs[0], 12, rand);
    const b = await lab.cluster('wineb', dirs[1], 9, rand);
    const c = await lab.cluster('winec', dirs[2], 8, rand);
    await lab.noise(30, rand);
    // last night they were one collection (the same name and close centres), made of the three
    await lab.store.saveCollections(MIKE, [{ id: 'old', name: 'Vino', groupLabel: 'Cibo e bevande', parentId: null, state: 'active', origin: 'seed', centroid: null, coherence: 0.7, members: [...a, ...b, ...c].map((entryId) => ({ entryId, score: 0.7 })) }]);
    const out = await consolidate(MIKE, lab.deps());
    const vino = (await lab.byName('Vino')) as CollectionRow;
    expect(vino.id).toBe('old');
    expect(out.dropped).toBe(0);
    expect(await lab.memberIds('old')).toEqual(expect.arrayContaining(a));      // the largest group is what it is now
    expect(lab.calls.length).toBeGreaterThanOrEqual(2);                         // the other two were asked: they were never the old collection
  });

  it('a group that is mostly inside an old collection but is a small part of it does NOT take its id (a quarter of the old members is the least)', async () => {
    const rand = rng(53);
    const dirs = farDirs(3, rand);
    const a = await lab.cluster('wine', dirs[0], 8, rand);
    await lab.noise(80, rand);
    const big = Array.from({ length: 60 }, (_, i) => ({ entryId: i < 8 ? a[i] : `noise${i}`, score: 0.7 }));      // 8 of 60: under a quarter
    await lab.store.saveCollections(MIKE, [{ id: 'old', name: 'Vino', groupLabel: null, parentId: null, state: 'active', origin: 'seed', centroid: null, coherence: 0.7, members: big }]);
    const out = await consolidate(MIKE, lab.deps());
    expect((await lab.byName('Vino'))?.id).not.toBe('old');
    expect(out.created).toBeGreaterThanOrEqual(1);
  });

  it('«ClaudeCode» and «Claude Code» are one name: the two groups that carry them, if they are close, are one collection', async () => {
    const rand = rng(16);
    const [c, d1, d2] = [randomDir(rand), randomDir(rand), randomDir(rand)];
    lab.names.wine = 'Claude Code';
    lab.names.wineb = 'ClaudeCode';
    await lab.cluster('wine', unit(c.map((x, i) => x + d1[i])), 12, rand, { noise: 1.3 });
    await lab.cluster('wineb', unit(c.map((x, i) => x + d2[i])), 9, rand, { noise: 1.3 });
    await lab.noise(250, rand);
    await consolidate(MIKE, lab.deps());
    const named = (await lab.rows()).filter((r) => /claude/i.test(r.name));
    expect(named).toHaveLength(1);
    expect(named[0].size).toBeGreaterThanOrEqual(21);
  });

  it('the group that already holds a name keeps it when another group grows bigger than it (no flip every night)', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('wineb', dirs[1], 6, rand, { tags: [] });
    await lab.noise(25, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const holder = (await lab.byName('Vino')) as CollectionRow;
    await lab.cluster('wineb', dirs[1], 12, rand, { from: 6, tags: [] });   // now 18 against 8
    await consolidate(MIKE, deps);
    expect(await lab.byName('Vino')).toMatchObject({ id: holder.id });
  });

  it('two groups with the same name and almost the same centre are one collection (the larger stays, the members are the union)', async () => {
    // two sub-topics that share a part and are noisy enough to be two groups (the cosine of their centres is 0.47: above the bar of the same name, 0.45,
    // under the one that merges groups, 0.64); the fake model calls both «Vino»
    const rand = rng(16);
    const [c, d1, d2] = [randomDir(rand), randomDir(rand), randomDir(rand)];
    await lab.cluster('wine', unit(c.map((x, i) => x + d1[i])), 12, rand, { noise: 1.3 });
    await lab.cluster('wineb', unit(c.map((x, i) => x + d2[i])), 9, rand, { noise: 1.3 });
    await lab.noise(250, rand);
    const out = await consolidate(MIKE, lab.deps());
    const named = (await lab.rows()).filter((r) => r.name === 'Vino');
    expect(named).toHaveLength(1);
    expect(named[0].size).toBeGreaterThanOrEqual(21);
    expect(out.collections.filter((c) => c.name === UNNAMED && c.state === 'watching' && c.members.length >= 9)).toHaveLength(0);   // nobody was left without a name
    // its coherence is the one of the UNION (looser than either group on its own), worked out on its new centre
    const merged = out.collections.find((c) => c.name === 'Vino');
    const { vectors: centred } = centerAndNormalize([...lab.vectors.values()]);
    const at = new Map([...lab.vectors.keys()].map((id, i) => [id, i]));
    const meanOf = (ids: string[]): number => ids.reduce((t, id) => t + cosine(centred[at.get(id) as number], merged?.centroid as Float32Array), 0) / ids.length;
    const union = meanOf([...wineIds(12), ...Array.from({ length: 9 }, (_, i) => `wineb${i}`)]);
    const larger = meanOf(wineIds(12));
    expect(Math.abs(union - larger)).toBeGreaterThan(0.01);     // the world tells the two apart (0.695 and 0.722)
    expect(merged?.coherence as number).toBeCloseTo(union, 6);
  });
});

describe('consolidate: the corrections of the user last', () => {
  async function started(): Promise<{ deps: EngineDeps; dirs: Float32Array[]; rand: () => number; wine: CollectionRow; food: CollectionRow }> {
    const { dirs, rand } = await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    return { deps, dirs, rand, wine: (await lab.byName('Vino')) as CollectionRow, food: (await lab.byName('Ristoranti')) as CollectionRow };
  }

  it('a hidden collection stays hidden, keeps its id, and is not made again as a new one', async () => {
    const { deps, wine, dirs, rand } = await started();
    await lab.store.hide(MIKE, wine.id);
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    const out = await consolidate(MIKE, deps);
    const rows = await lab.rows();
    expect(rows.filter((r) => r.name === 'Vino')).toHaveLength(1);
    expect(rows.find((r) => r.id === wine.id)).toMatchObject({ state: 'hidden' });
    expect(out.created).toBe(0);
    expect(await lab.memberIds(wine.id)).toContain('wine8');                // the members are kept up, so that «put back» finds it whole
  });

  it('an entry taken out of a collection does not come back, and is not counted for it', async () => {
    const { deps, wine } = await started();
    await lab.store.removeEntry(MIKE, wine.id, 'wine0');
    await consolidate(MIKE, deps);
    expect(await lab.memberIds(wine.id)).not.toContain('wine0');
    await consolidate(MIKE, deps);
    expect(await lab.memberIds(wine.id)).not.toContain('wine0');
  });

  it('an entry taken out of its first theme takes the next one it is close enough to', async () => {
    const rand = rng(23);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('food', dirs[1], 7, rand);
    const mid = unit(dirs[0].map((x, i) => x + dirs[1][i]));
    await lab.add('mid0', mid, { key: 'wine' });                            // between the two: close to both
    await lab.noise(25, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    const first = await lab.memberIds(wine.id);
    const inBoth = first.includes('mid0') && (await lab.memberIds(food.id)).includes('mid0');
    expect(inBoth).toBe(true);
    await lab.store.removeEntry(MIKE, wine.id, 'mid0');
    await consolidate(MIKE, deps);
    expect(await lab.memberIds(wine.id)).not.toContain('mid0');
    expect(await lab.memberIds(food.id)).toContain('mid0');
  });

  it('an entry put in by hand stays in, and stays in its own collection too', async () => {
    const { deps, wine } = await started();
    await lab.store.addEntry(MIKE, wine.id, 'tech0');
    await consolidate(MIKE, deps);
    await consolidate(MIKE, deps);
    const members = await lab.store.membersOf(wine.id);
    expect(members.find((m) => m.entryId === 'tech0')?.source).toBe('user_add');
    const tech = (await lab.byName('Intelligenza artificiale')) as CollectionRow;
    expect(await lab.memberIds(tech.id)).toContain('tech0');
  });

  it('a collection merged into another stays merged: its group goes on feeding the other, and a new one is not made', async () => {
    const { deps, wine, food, dirs, rand } = await started();
    await lab.store.merge(MIKE, wine.id, food.id);
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    const out = await consolidate(MIKE, deps);
    const rows = await lab.rows();
    expect(rows.find((r) => r.id === wine.id)).toMatchObject({ state: 'merged', parentId: food.id });
    expect(rows.filter((r) => r.name === 'Vino')).toHaveLength(1);
    expect(out.created).toBe(0);
    const members = await lab.memberIds(food.id);
    expect(members).toEqual(expect.arrayContaining([...wineIds(9), 'food0']));
  });

  it('a user who renamed a collection to the name another group gets keeps both: the other group stays unnamed', async () => {
    const { deps, wine } = await started();
    await lab.store.rename(MIKE, wine.id, 'Ristoranti');                    // the user calls the wine collection «Ristoranti»
    await consolidate(MIKE, deps);
    const rows = await lab.rows();
    expect(rows.filter((r) => r.name === 'Ristoranti').map((r) => r.nameBy)).toContain('user');
    expect(rows.filter((r) => r.name === 'Ristoranti')).toHaveLength(1);    // the engine\'s own «Ristoranti» gave way
  });
});

describe('consolidate: what the pass asks and keeps', () => {
  it('the model is told the names that are already in use (the ones of the existing collections and of the bigger groups named before), not its own old name', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const told = lab.calls.map((c) => c.existing ?? []);
    expect(told[0]).toEqual([]);                                            // the first group asked is the biggest: nothing is taken yet
    expect(told[1]).toHaveLength(1);
    expect(told[2]).toHaveLength(2);
    expect(told[2]).toEqual(expect.arrayContaining(told[1]));
    // tonight the group that lost its identity is asked again: the model is told the OTHER names, not the one it had
    lab.calls.length = 0;
    const wine = (await lab.byName('Vino')) as CollectionRow;
    await lab.store.saveCollections(MIKE, (await lab.rows()).map((r) => ({ id: r.id, name: r.id === wine.id ? UNNAMED : r.name, groupLabel: r.groupLabel, parentId: null, state: r.id === wine.id ? 'watching' : 'active', origin: r.origin, centroid: r.centroid, coherence: r.coherence, members: [] })));
    await consolidate(MIKE, deps);
    const wineCall = lab.calls.find((c) => c.members[0].text.startsWith('wine'));
    expect(wineCall?.existing ?? []).not.toContain(UNNAMED);
  });

  it('a collection that shrinks to 4 keeps its name and the model is not asked about it (a group of 4 is not worth a question)', async () => {
    const rand = rng(5);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 6, rand);
    await lab.noise(25, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const asked = lab.calls.length;
    lab.store.deleteEntry('wine0');
    lab.store.deleteEntry('wine1');
    await consolidate(MIKE, deps);
    expect(await lab.byName('Vino')).toMatchObject({ state: 'active' });
    expect(lab.calls.length).toBe(asked);
  });

  it('a collection the user renamed keeps its heading (the one of the name it had), and an entry he took out is not counted for it: below 3 it is no longer active', async () => {
    const { deps, wine } = await (async () => {
      await threeTopics(lab);
      const d = lab.deps();
      await consolidate(MIKE, d);
      return { deps: d, wine: (await lab.byName('Vino')) as CollectionRow };
    })();
    await lab.store.rename(MIKE, wine.id, 'Le mie bottiglie');
    await consolidate(MIKE, deps);
    expect((await lab.rows()).find((r) => r.id === wine.id)?.groupLabel).toBe('Cibo e bevande');
    for (const id of wineIds(6)) await lab.store.removeEntry(MIKE, wine.id, id);       // 8 entries in the group, 6 taken out: 2 are left
    await consolidate(MIKE, deps);
    expect((await lab.rows()).find((r) => r.id === wine.id)?.state).not.toBe('active');
  });

  it('a name the user gave that is a name of the list does not change the heading the collection had (the heading is the one the engine found it under)', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    expect(wine.groupLabel).toBe('Cibo e bevande');
    await lab.store.rename(MIKE, wine.id, 'Scienza');                                        // a name of the list, under another heading («Cultura e svago»)
    await consolidate(MIKE, deps);
    expect((await lab.rows()).find((r) => r.id === wine.id)).toMatchObject({ name: 'Scienza', nameBy: 'user', groupLabel: 'Cibo e bevande' });
  });

  it('the vectors of the most common length are the ones used; on a tie the longer one wins', async () => {
    const rand = rng(6);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 6, rand);
    for (let i = 0; i < 6; i += 1) {
      lab.store.registerEntry({ id: `short${i}`, ownerUser: MIKE });
      await lab.store.saveVector(`short${i}`, 'old', [1, 0, i], `hs${i}`);
    }
    const out = await consolidate(MIKE, lab.deps());
    expect(out.entries).toBe(6);
    expect(out.skippedDimensions).toBe(6);
  });

  it('a name the model gives that is already the name of another collection of the user is given to one: the old holder keeps it', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.noise(25, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const holder = (await lab.byName('Vino')) as CollectionRow;
    await lab.cluster('wineb', dirs[1], 7, rand, { tags: [] });             // a new group the model also calls «Vino»
    await consolidate(MIKE, deps);
    expect((await lab.rows()).filter((r) => r.name === 'Vino')).toHaveLength(1);
    expect((await lab.byName('Vino'))?.id).toBe(holder.id);
  });
});

describe('consolidate: the names that look alike', () => {
  it('a new name three letters from a name of the list is not that name (it is a new one); the bars are exactly 2 letters and 8 of length', async () => {
    await threeTopics(lab);
    lab.names.tech = 'Intelligenti Artificiali';                            // three letters away from «Intelligenza artificiale»
    lab.names.wine = 'Umorismi';                                            // 8 letters, one from «Umorismo»
    lab.names.food = 'Scienzi';                                             // 7 letters, one from «Scienza»: too short to snap
    await consolidate(MIKE, lab.deps());
    expect(await lab.byName('Intelligenti Artificiali')).toBeDefined();
    expect(await lab.byName('Umorismo')).toBeDefined();
    expect(await lab.byName('Scienzi')).toBeDefined();
  });
});

describe('consolidate: ids, merges and the user\'s corrections through them', () => {
  it('a group that is the larger of two merged by name takes the id of the OLD collection the smaller one was', async () => {
    const rand = rng(16);
    const [c, d1, d2] = [randomDir(rand), randomDir(rand), randomDir(rand)];
    const a = await lab.cluster('wine', unit(c.map((x, i) => x + d1[i])), 12, rand, { noise: 1.3 });
    const b = await lab.cluster('wineb', unit(c.map((x, i) => x + d2[i])), 9, rand, { noise: 1.3 });
    await lab.noise(250, rand);
    // last night the nine were a collection of their own
    await lab.store.saveCollections(MIKE, [{ id: 'old', name: 'Vino', groupLabel: 'Cibo e bevande', parentId: null, state: 'active', origin: 'seed', centroid: null, coherence: 0.7, members: b.map((entryId) => ({ entryId, score: 0.7 })) }]);
    await consolidate(MIKE, lab.deps());
    const vino = (await lab.rows()).filter((r) => r.name === 'Vino');
    expect(vino).toHaveLength(1);
    expect(vino[0].id).toBe('old');
    expect(await lab.memberIds('old')).toEqual(expect.arrayContaining([...a, ...b]));
  });

  it('a group never takes the id of a CHILD collection: only a child group does', async () => {
    const rand = rng(61);
    const dirs = farDirs(2, rand);
    const a = await lab.cluster('wine', dirs[0], 8, rand);
    await lab.noise(30, rand);
    await lab.store.saveCollections(MIKE, [
      { id: 'dad', name: 'Altro', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: ['noise0', 'noise1', 'noise2', 'noise3', 'noise4', 'noise5'].map((entryId) => ({ entryId, score: 0.7 })) },
      { id: 'kid', name: 'Vino', groupLabel: null, parentId: 'dad', state: 'active', origin: 'seed', centroid: null, coherence: 0.7, members: a.map((entryId) => ({ entryId, score: 0.7 })) },
    ]);
    await consolidate(MIKE, lab.deps());
    expect((await lab.byName('Vino'))?.id).not.toBe('kid');
  });

  it('a collection merged into one that was merged into another still feeds the LAST one, and the entries taken out of it do not come back through the merge', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    const tech = (await lab.byName('Intelligenza artificiale')) as CollectionRow;
    await lab.store.merge(MIKE, wine.id, food.id);
    await lab.store.merge(MIKE, food.id, tech.id);
    await lab.store.removeEntry(MIKE, tech.id, 'wine0');
    await consolidate(MIKE, deps);
    const members = await lab.memberIds(tech.id);
    expect(members).toEqual(expect.arrayContaining([...wineIds(8).slice(1), 'food0', 'tech0']));
    expect(members).not.toContain('wine0');
    const rows = await lab.rows();
    expect(rows.find((r) => r.id === wine.id)).toMatchObject({ state: 'merged' });
    expect(rows.find((r) => r.id === food.id)).toMatchObject({ state: 'merged', parentId: tech.id });
  });

  it('an entry that two collections hold keeps the better score in a collection that a merged one feeds', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    await lab.store.merge(MIKE, wine.id, food.id);
    await consolidate(MIKE, deps);
    const members = await lab.store.membersOf(food.id);
    expect(new Set(members.map((m) => m.entryId)).size).toBe(members.length);        // once each
    expect([...members].sort((a, b) => b.score - a.score)).toEqual(members);
  });
});

describe('consolidate: a group that is only partly an old collection', () => {
  it('does not take its id when it is mostly something else (under half of what the group holds is in the old collection)', async () => {
    const rand = rng(71);
    const dirs = farDirs(2, rand);
    const a = await lab.cluster('wine', dirs[0], 10, rand);
    await lab.noise(80, rand);
    const old = [...a.slice(0, 4), ...Array.from({ length: 6 }, (_, i) => `noise${i}`)];       // 4 of the 10 are in it: 40 % of the group, 40 % of the old collection
    await lab.store.saveCollections(MIKE, [{ id: 'old', name: 'Vino', groupLabel: null, parentId: null, state: 'active', origin: 'seed', centroid: null, coherence: 0.7, members: old.map((entryId) => ({ entryId, score: 0.7 })) }]);
    await consolidate(MIKE, lab.deps());
    expect((await lab.byName('Vino'))?.id).not.toBe('old');
  });
});

describe('consolidate: big groups, children, parents', () => {
  /** A big group of `a + b + r` entries (two sub-topics around a shared common part) among enough scattered entries that the common part survives the centring. */
  async function bigGroup(): Promise<{ rand: () => number }> {
    const rand = rng(31);
    const common = randomDir(rand);
    const d1 = randomDir(rand);
    const d2 = randomDir(rand);
    const sub = (d: Float32Array): Float32Array => unit(common.map((x, i) => 1.5 * x + 0.8 * d[i]));
    await lab.cluster('anime', sub(d1), 20, rand, { noise: 0.2 });
    await lab.cluster('games', sub(d2), 20, rand, { noise: 0.2 });
    await lab.cluster('art', common, 30, rand, { noise: 0.8 });
    await lab.noise(250, rand);
    return { rand };
  }

  it('a big group with two sub-topics gives its parent and two children, and the children know their parent', async () => {
    await bigGroup();
    await consolidate(MIKE, lab.deps());
    const rows = await lab.rows();
    const parent = rows.find((r) => r.name === 'Arte e cultura') as CollectionRow;
    const children = rows.filter((r) => r.parentId === parent.id);
    expect(parent).toBeDefined();
    expect(parent.parentId).toBeNull();
    expect(children.map((c) => c.name).sort()).toEqual(['Anime', 'Giochi']);
    expect(children.every((c) => c.state === 'active')).toBe(true);
    const parentMembers = await lab.memberIds(parent.id);
    for (const child of children) expect((await lab.memberIds(child.id)).every((m) => parentMembers.includes(m))).toBe(true);
  });

  it('a child holds its own entries and nothing that was assigned: the assignment is for the themes of the top level (even a lenient one gives a child nobody)', async () => {
    await bigGroup();
    await consolidate(MIKE, lab.deps({ params: { ...COLLECTION_PARAMS, assignTau: -1 } }));
    const rows = await lab.rows();
    for (const [name, key] of [['Anime', 'anime'], ['Giochi', 'games']] as const) {
      const members = await lab.memberIds((rows.find((r) => r.name === name) as CollectionRow).id);
      expect(members).toHaveLength(20);
      expect(members.every((m) => m.startsWith(key))).toBe(true);
    }
  });

  it('the children are published even when their parent cannot be named, and then they have no parent', async () => {
    await bigGroup();
    lab.names.art = undefined;
    await consolidate(MIKE, lab.deps());
    const rows = await lab.rows();
    expect(rows.filter((r) => r.state === 'active').map((r) => r.name).sort()).toEqual(['Anime', 'Giochi']);
    expect(rows.filter((r) => r.state === 'active').every((r) => r.parentId === null)).toBe(true);
    expect(rows.some((r) => r.name === UNNAMED && r.state === 'watching')).toBe(true);
  });
});

describe('consolidate: what the assignment adds to a theme never makes it a type (spec §3.1: no published theme is mostly music or films)', () => {
  /** A theme of 10 entries, 6 of them with films (60 %: a theme), among 250 scattered entries that ALL have films: with a lenient assignment every one of them asks to join it. */
  async function filmsAroundATheme(flag: 'hasFilms' | 'hasContentSongs' = 'hasFilms'): Promise<{ rand: () => number }> {
    const rand = rng(21);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 6, rand, { [flag]: true });
    await lab.cluster('wine', d, 4, rand, { from: 6 });
    for (let i = 0; i < 250; i += 1) await lab.add(`noise${i}`, randomDir(rand), { key: 'noise', [flag]: true });
    return { rand };
  }
  const lenient = (over: Partial<typeof COLLECTION_PARAMS> = {}): typeof COLLECTION_PARAMS => ({ ...COLLECTION_PARAMS, assignTau: -1, ...over });
  const filmsIn = (ids: string[]): number => ids.filter((id) => lab.features.get(id)?.hasFilms).length;
  const songsIn = (ids: string[]): number => ids.filter((id) => lab.features.get(id)?.hasContentSongs).length;

  it('the entries with films join the theme while it stays under 70 %, the nearest to its centre first (9 films of 13 is 69 %, 10 of 14 is 71 %)', async () => {
    await filmsAroundATheme();
    const { result } = await planConsolidation(MIKE, lab.deps({ params: lenient() }));
    const vino = result.collections.find((c) => c.name === 'Vino') as PlannedCollection;
    const ids = vino.members.map((m) => m.entryId);
    expect([ids.length, filmsIn(ids)]).toEqual([13, 9]);
    const { vectors: centred } = centerAndNormalize([...lab.vectors.values()]);
    const at = new Map([...lab.vectors.keys()].map((id, i) => [id, i]));
    const nearest = [...lab.vectors.keys()].filter((id) => id.startsWith('noise')).map((id) => ({ id, score: cosine(centred[at.get(id) as number], vino.centroid as Float32Array) })).sort((a, b) => b.score - a.score);
    expect(nearest.slice(0, 3).every((n) => ids.includes(n.id))).toBe(true);
    expect(ids.includes(nearest[3].id)).toBe(false);
  });

  it('the same goes for songs from the content: a theme is not music either', async () => {
    await filmsAroundATheme('hasContentSongs');
    const { result } = await planConsolidation(MIKE, lab.deps({ params: lenient() }));
    const ids = (result.collections.find((c) => c.name === 'Vino') as PlannedCollection).members.map((m) => m.entryId);
    expect([ids.length, songsIn(ids), filmsIn(ids)]).toEqual([13, 9, 0]);
  });

  it('without the bar the same theme would take all 250 (it is the bar that stops it)', async () => {
    await filmsAroundATheme();
    const { result } = await planConsolidation(MIKE, lab.deps({ params: lenient({ typeMemberShare: 1.01 }) }));
    expect((result.collections.find((c) => c.name === 'Vino') as PlannedCollection).members).toHaveLength(260);
  });

  it('the bar is the one of the parameters: at 80 % nine of them fit (15 of 19 is 79 %)', async () => {
    await filmsAroundATheme();
    const { result } = await planConsolidation(MIKE, lab.deps({ params: lenient({ typeMemberShare: 0.8 }) }));
    expect((result.collections.find((c) => c.name === 'Vino') as PlannedCollection).members).toHaveLength(19);
  });

  it('entries that do not have films are never held back, and they make room for the ones that do (250 without and 80 with films: all 340 join)', async () => {
    const rand = rng(21);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 6, rand, { hasFilms: true });
    await lab.cluster('wine', d, 4, rand, { from: 6 });
    await lab.noise(250, rand);
    for (let i = 0; i < 80; i += 1) await lab.add(`film${i}`, randomDir(rand), { key: 'film', hasFilms: true });
    const { result } = await planConsolidation(MIKE, lab.deps({ params: lenient() }));
    expect((result.collections.find((c) => c.name === 'Vino') as PlannedCollection).members).toHaveLength(340);
  });

  it('the entries the user took out of the theme are not part of what it is: with only films left, no more films join', async () => {
    await filmsAroundATheme();
    const deps = lab.deps({ params: lenient() });
    await consolidate(MIKE, deps);
    const vino = (await lab.byName('Vino')) as CollectionRow;
    for (const id of ['wine6', 'wine7', 'wine8', 'wine9']) await lab.store.removeEntry(MIKE, vino.id, id);       // the four without films
    await consolidate(MIKE, deps);
    const ids = await lab.memberIds(vino.id);
    expect(ids.every((id) => id.startsWith('wine'))).toBe(true);
    expect(ids).toEqual(['wine0', 'wine1', 'wine2', 'wine3', 'wine4', 'wine5']);
  });
});

describe('consolidate: a pass that does not write', () => {
  it('a store that refuses the save fails the pass (and nothing is half written)', async () => {
    await threeTopics(lab);
    vi.spyOn(lab.store, 'saveCollections').mockRejectedValueOnce(new Error('db down'));
    await expect(consolidate(MIKE, lab.deps())).rejects.toThrow('db down');
    expect(await lab.rows()).toEqual([]);
  });

  it('two passes started together run one after the other', async () => {
    await threeTopics(lab);
    const order: string[] = [];
    let released = false;
    let first = true;
    const base = lab.deps();
    const deps: EngineDeps = {
      ...base,
      features: async (u, ids) => {
        const me = first ? 'first' : 'second';
        first = false;
        order.push(`${me} start`);
        if (me === 'first') await new Promise((r) => setTimeout(r, 30));
        released = true;
        const out = await base.features(u, ids);
        order.push(`${me} end`);
        return out;
      },
    };
    const a = consolidate(MIKE, deps);
    const b = consolidate(MIKE, deps);
    await Promise.all([a, b]);
    expect(released).toBe(true);
    expect(order).toEqual(['first start', 'first end', 'second start', 'second end']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// rebuildPreview
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe('rebuildPreview: the decisions of a pass, with nothing written', () => {
  it('lists what a pass would make (name, size, state, members); the new ones have no id yet; the model IS asked (that is what the names are for)', async () => {
    await threeTopics(lab);
    const save = vi.spyOn(lab.store, 'saveCollections');
    const out = await rebuildPreview(MIKE, lab.deps());
    expect(save).not.toHaveBeenCalled();
    expect(await lab.rows()).toEqual([]);
    expect(out.map((c) => [c.name, c.state]).sort()).toEqual([['Intelligenza artificiale', 'active'], ['Ristoranti', 'active'], [UNNAMED, 'watching'], ['Vino', 'active']]);
    expect(out.every((c) => c.id === null)).toBe(true);
    const wine = out.find((c) => c.name === 'Vino') as (typeof out)[number];
    expect(wine.size).toBe(wine.memberIds.length);
    expect(wine.memberIds).toEqual(expect.arrayContaining(wineIds(8)));
    expect(lab.calls).toHaveLength(3);
  });

  it('after a real pass the preview gives the ids of the collections that exist, and the same names, sizes and members', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const rows = await lab.rows();
    const asked = lab.calls.length;
    const out = await rebuildPreview(MIKE, deps);
    expect(lab.calls.length).toBe(asked);
    expect(out.map((c) => c.id).sort()).toEqual(rows.map((r) => r.id).sort());
    for (const c of out) {
      expect([...c.memberIds].sort()).toEqual(await lab.memberIds(c.id as string));
    }
  });

  it('shows a hidden collection as hidden and a merged one as merged (what the store will keep), not as what the group would be', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    await lab.store.hide(MIKE, wine.id);
    const out = await rebuildPreview(MIKE, deps);
    expect(out.find((c) => c.id === wine.id)?.state).toBe('hidden');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// assignOne
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe('assignOne: the fast lane puts a new entry in the collections it is close to, and takes nothing away', () => {
  async function started(): Promise<{ dirs: Float32Array[]; rand: () => number; wine: CollectionRow; food: CollectionRow }> {
    const { dirs, rand } = await threeTopics(lab);
    await consolidate(MIKE, lab.deps());
    return { dirs, rand, wine: (await lab.byName('Vino')) as CollectionRow, food: (await lab.byName('Ristoranti')) as CollectionRow };
  }

  it('joins the collection it is close to, as an automatic member, and says which', async () => {
    const { dirs, rand, wine } = await started();
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    const joined = await assignOne(MIKE, 'wine8', lab.assignDeps());
    expect(joined).toEqual([wine.id]);
    const member = (await lab.store.membersOf(wine.id)).find((m) => m.entryId === 'wine8');
    expect(member?.source).toBe('auto');
  });

  it('an entry between two collections joins both, never three', async () => {
    const { dirs } = await started();
    await lab.add('mid', unit(dirs[0].map((x, i) => x + dirs[1][i])), { key: 'wine' });
    const joined = await assignOne(MIKE, 'mid', lab.assignDeps());
    expect(joined).toHaveLength(2);
  });

  it('an entry that is far from every collection joins none, and one that is already a member does not join again', async () => {
    const { rand, wine } = await started();
    await lab.add('far', randomDir(rand), { key: 'noise' });
    expect(await assignOne(MIKE, 'far', lab.assignDeps())).toEqual([]);
    const before = await lab.memberIds(wine.id);
    expect(await assignOne(MIKE, 'wine0', lab.assignDeps())).not.toContain(wine.id);
    expect(await lab.memberIds(wine.id)).toEqual(before);
  });

  it('an entry taken out of a collection by hand does not join it, and a hidden, merged or watching collection takes nobody', async () => {
    const { dirs, rand, wine, food } = await started();
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    await lab.store.removeEntry(MIKE, wine.id, 'wine8');
    expect(await assignOne(MIKE, 'wine8', lab.assignDeps())).toEqual([]);
    await lab.store.hide(MIKE, food.id);
    await lab.add('food9', around(dirs[1], 0.3, rand), { key: 'food' });
    expect(await assignOne(MIKE, 'food9', lab.assignDeps())).toEqual([]);   // hidden: nobody joins it between two passes
    const small = (await lab.byName(UNNAMED)) as CollectionRow;
    await lab.add('home9', around(dirs[3], 0.3, rand), { key: 'home' });
    expect(await assignOne(MIKE, 'home9', lab.assignDeps())).not.toContain(small.id);
  });

  it('a CHILD collection takes nobody in the fast lane (the night puts the children in place)', async () => {
    const { dirs, rand, wine, food } = await started();
    await lab.store.saveCollections(MIKE, (await lab.rows()).map((r) => ({ id: r.id, name: r.name, groupLabel: r.groupLabel, parentId: r.id === wine.id ? food.id : null, state: r.state === 'watching' ? 'watching' : 'active', origin: r.origin, centroid: r.centroid, coherence: r.coherence, members: [] })));
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    expect(await assignOne(MIKE, 'wine8', lab.assignDeps())).not.toContain(wine.id);
  });

  it('an entry with no vector, or of another user, or unknown: nothing, no crash', async () => {
    await started();
    expect(await assignOne(MIKE, 'nobody', lab.assignDeps())).toEqual([]);
    await lab.add('sara0', randomDir(rng(77)), { owner: SARA, key: 'wine' });
    expect(await assignOne(MIKE, 'sara0', lab.assignDeps())).toEqual([]);
  });

  it('never creates, renames or deletes a collection', async () => {
    const { dirs, rand } = await started();
    const before = (await lab.rows()).map((r) => [r.id, r.name, r.state]);
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    await assignOne(MIKE, 'wine8', lab.assignDeps());
    expect((await lab.rows()).map((r) => [r.id, r.name, r.state])).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// what the pass reads, asks, names and keeps: the rules that a night depends on
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe('consolidate: what it reads', () => {
  it('a user with no vectors: the facts about the entries are not even asked for', async () => {
    const features = vi.fn(async () => new Map<string, EntryFeatures>());
    await consolidate(MIKE, lab.deps({ features }));
    expect(features).not.toHaveBeenCalled();
  });

  it('a fact that is missing for some entries is read as «says nothing», not a crash', async () => {
    await threeTopics(lab);
    const base = lab.deps();
    const features = async (user: string, ids: string[]): Promise<Map<string, EntryFeatures>> => {
      const all = await base.features(user, ids);
      for (const id of [...all.keys()].filter((k) => k.startsWith('noise'))) all.delete(id);
      return all;
    };
    const out = await consolidate(MIKE, { ...base, features });
    expect(out.published).toBe(3);
  });

  it('a group that is about films (most of its entries have films) is the type «Film e serie», not a theme, and is never named', async () => {
    const rand = rng(4);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('movies', dirs[1], 9, rand, { hasFilms: true });
    await lab.noise(25, rand);
    lab.names.movies = 'Anime';
    await consolidate(MIKE, lab.deps());
    expect((await lab.rows()).map((r) => r.name)).toEqual(['Vino']);
    expect(lab.calls).toHaveLength(1);
  });

  it('the vectors of the most common length are the ones used, whatever their length: the least common is left out', async () => {
    const rand = rng(6);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 6, rand);
    for (let i = 0; i < 2; i += 1) {
      lab.store.registerEntry({ id: `short${i}`, ownerUser: MIKE });
      await lab.store.saveVector(`short${i}`, 'old', [1, 0, i], `hs${i}`);
    }
    const out = await consolidate(MIKE, lab.deps());
    expect([out.entries, out.skippedDimensions]).toEqual([6, 2]);
  });

  it('the most common length wins even when the other one is the longer', async () => {
    const rand = rng(6);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 6, rand);
    for (let i = 0; i < 2; i += 1) {
      lab.store.registerEntry({ id: `long${i}`, ownerUser: MIKE });
      await lab.store.saveVector(`long${i}`, 'newer', Array.from({ length: 100 }, (_, k) => (k === i ? 1 : 0)), `hl${i}`);
    }
    const out = await consolidate(MIKE, lab.deps());
    expect([out.entries, out.skippedDimensions]).toEqual([6, 2]);
  });

  it('on a tie between two lengths the longer one is used', async () => {
    const rand = rng(6);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 6, rand);
    await lab.noise(25, rand);                                              // 31 vectors of 48 numbers
    for (let i = 0; i < 31; i += 1) {
      lab.store.registerEntry({ id: `short${i}`, ownerUser: MIKE });
      await lab.store.saveVector(`short${i}`, 'old', [1, 0, i], `hs${i}`);
    }                                                                       // and 31 of 3: a tie
    await consolidate(MIKE, lab.deps());
    expect(await lab.byName('Vino')).toBeDefined();                         // the group of the 48-long vectors is the one found
  });
});

describe('consolidate: a group that lost the identity of its old collection', () => {
  it('is asked again about its subject, and the model is not told the name the collection had; the collection goes on with the new name', async () => {
    const rand = rng(12);
    const [d] = farDirs(1, rand);
    const a = await lab.cluster('wine', d, 8, rand);
    await lab.noise(40, rand);
    // the old collection holds one entry of the group and eleven that are not: it is found again (the group HOLDS them with a lenient assignment) but it is another thing
    await lab.store.saveCollections(MIKE, [{ id: 'old', name: 'Vecchio nome', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: [a[0], ...Array.from({ length: 11 }, (_, i) => `noise${i}`)].map((entryId) => ({ entryId, score: 0.7 })) }]);
    await consolidate(MIKE, lab.deps({ params: { ...COLLECTION_PARAMS, assignTau: -1 } }));
    expect(lab.calls).toHaveLength(1);
    expect(lab.calls[0].existing ?? []).not.toContain('Vecchio nome');
    expect((await lab.rows()).find((r) => r.id === 'old')?.name).toBe('Vino');
  });
});

describe('consolidate: a group that is too small to be asked', () => {
  it('a group of 4 that finds an old collection (by what it holds) keeps its name and the collection stays active: nobody is asked about 4 entries', async () => {
    const rand = rng(8);
    const [d] = farDirs(1, rand);
    await lab.cluster('wine', d, 4, rand);
    await lab.noise(40, rand);
    await lab.store.saveCollections(MIKE, [{ id: 'old', name: 'Vecchio', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: ['noise0', 'noise1', 'noise2', 'noise3'].map((entryId) => ({ entryId, score: 0.7 })) }]);
    await consolidate(MIKE, lab.deps({ params: { ...COLLECTION_PARAMS, assignTau: -1 } }));
    expect(lab.calls).toHaveLength(0);
    expect(await lab.byName('Vecchio')).toMatchObject({ id: 'old', state: 'active' });
  });
});

describe('consolidate: finding the old collection again', () => {
  it('the entries a user put in by hand are not what an old collection is made of: a group still finds it when he put in a lot', async () => {
    const rand = rng(21);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.noise(60, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    for (let i = 0; i < 35; i += 1) await lab.store.addEntry(MIKE, wine.id, `noise${i}`);
    const second = await consolidate(MIKE, deps);
    expect(second.created).toBe(0);
    expect((await lab.byName('Vino'))?.id).toBe(wine.id);
  });

  it('with a strict assignment (nobody joins but its own group) a group still finds its collection the next night', async () => {
    await threeTopics(lab);
    const deps = lab.deps({ params: { ...COLLECTION_PARAMS, assignTau: 0.999 } });
    await consolidate(MIKE, deps);
    const second = await consolidate(MIKE, deps);
    expect(second.created).toBe(0);
    expect(second.dropped).toBe(0);
  });

  it('a collection that no group stands behind is dropped, and the pass says how many', async () => {
    await threeTopics(lab);
    await lab.store.saveCollections(MIKE, [{ id: 'ghost', name: 'Fantasma', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: ['noise0', 'noise1', 'noise2'].map((entryId) => ({ entryId, score: 0.7 })) }]);
    const out = await consolidate(MIKE, lab.deps());
    expect(out.dropped).toBe(1);
    expect(await lab.byName('Fantasma')).toBeUndefined();
  });

  it('two groups the user left as old collections, with the same name and close, are one: the larger group keeps ITS OWN old collection (the other one is dropped)', async () => {
    const rand = rng(16);
    const [c, d1, d2] = [randomDir(rand), randomDir(rand), randomDir(rand)];
    const a = await lab.cluster('wine', unit(c.map((x, i) => x + d1[i])), 12, rand, { noise: 1.3 });
    const b = await lab.cluster('wineb', unit(c.map((x, i) => x + d2[i])), 9, rand, { noise: 1.3 });
    await lab.noise(250, rand);
    await lab.store.saveCollections(MIKE, [
      { id: 'old1', name: 'Vino', groupLabel: 'Cibo e bevande', parentId: null, state: 'active', origin: 'seed', centroid: null, coherence: 0.7, members: a.map((entryId) => ({ entryId, score: 0.7 })) },
      { id: 'old2', name: 'Vino', groupLabel: 'Cibo e bevande', parentId: null, state: 'active', origin: 'seed', centroid: null, coherence: 0.7, members: b.map((entryId) => ({ entryId, score: 0.7 })) },
    ]);
    const { result } = await planConsolidation(MIKE, lab.deps());
    expect(result.collections.filter((c) => c.name === 'Vino').map((c) => c.id)).toEqual(['old1']);
    expect(result.dropped.map((r) => r.id)).toEqual(['old2']);
  });

  it('a group takes the old collection of the top level before any child can (a child of the group would take the id of the whole)', async () => {
    const rand = rng(31);
    const common = randomDir(rand);
    const d1 = randomDir(rand);
    const d2 = randomDir(rand);
    const sub = (d: Float32Array): Float32Array => unit(common.map((x, i) => 1.5 * x + 0.8 * d[i]));
    const anime = await lab.cluster('anime', sub(d1), 20, rand, { noise: 0.2 });
    await lab.cluster('games', sub(d2), 20, rand, { noise: 0.2 });
    const art = await lab.cluster('art', common, 30, rand, { noise: 0.8 });
    await lab.noise(250, rand);
    await lab.store.saveCollections(MIKE, [{ id: 'old', name: 'Vecchia', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: [...anime, ...art.slice(0, 8)].map((entryId) => ({ entryId, score: 0.7 })) }]);
    await consolidate(MIKE, lab.deps());
    const rows = await lab.rows();
    expect(rows.find((r) => r.id === 'old')).toMatchObject({ parentId: null, name: 'Vecchia' });
    const children = rows.filter((r) => r.parentId === 'old');
    expect(children.map((c) => c.name).sort()).toEqual(['Anime', 'Giochi']);
  });

  it('an old collection of the second level that was a union of children goes on in the largest of them, with its id', async () => {
    const rand = rng(31);
    const common = randomDir(rand);
    const d1 = randomDir(rand);
    const d2 = randomDir(rand);
    const sub = (d: Float32Array): Float32Array => unit(common.map((x, i) => 1.5 * x + 0.8 * d[i]));
    const anime = await lab.cluster('anime', sub(d1), 20, rand, { noise: 0.2 });
    const games = await lab.cluster('games', sub(d2), 20, rand, { noise: 0.2 });
    const art = await lab.cluster('art', common, 30, rand, { noise: 0.8 });
    await lab.noise(250, rand);
    await lab.store.saveCollections(MIKE, [
      { id: 'dad', name: 'Padre', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: art.slice(0, 5).map((entryId) => ({ entryId, score: 0.7 })) },
      { id: 'kid', name: 'Figlio', groupLabel: null, parentId: 'dad', state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: [...anime, ...games, ...art.slice(10, 30)].map((entryId) => ({ entryId, score: 0.7 })) },
    ]);
    await consolidate(MIKE, lab.deps());
    const rows = await lab.rows();
    expect(rows.find((r) => r.id === 'kid')).toMatchObject({ parentId: 'dad' });
  });

  it('a collection merged into one that was merged into another still feeds the LAST one, whatever order the groups are in', async () => {
    const rand = rng(3);
    const dirs = farDirs(4, rand);
    await lab.cluster('tech', dirs[2], 6, rand);                           // the groups come in the order of their first entry: tech, food, wine
    await lab.cluster('food', dirs[1], 7, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.noise(30, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    const tech = (await lab.byName('Intelligenza artificiale')) as CollectionRow;
    await lab.store.merge(MIKE, wine.id, food.id);
    await lab.store.merge(MIKE, food.id, tech.id);
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });   // new since the merges: the store did not copy it, only the engine can bring it
    await consolidate(MIKE, deps);
    expect(await lab.memberIds(tech.id)).toEqual(expect.arrayContaining([...wineIds(9), 'food0', 'tech0']));
  });
});

describe('consolidate: a collection merged into another', () => {
  it('is not merged with a new group that carries the same name and is close to it: the new group is shown as its own collection', async () => {
    const rand = rng(16);
    const [c, d1, d2] = [randomDir(rand), randomDir(rand), randomDir(rand)];
    await lab.cluster('wine', unit(c.map((x, i) => x + d1[i])), 12, rand, { noise: 1.3 });
    const laterVectors = Array.from({ length: 9 }, () => around(unit(c.map((x, i) => x + d2[i])), 1.3, rand));   // made now, saved later: the same numbers as a library that had them from the start
    await lab.noise(250, rand);
    const rand2 = rng(17);
    await lab.cluster('food', randomDir(rand2), 7, rand2);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    await lab.store.merge(MIKE, wine.id, food.id);
    const later: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      await lab.add(`wineb${i}`, laterVectors[i], { key: 'wineb', tags: [] });
      later.push(`wineb${i}`);
    }
    await consolidate(MIKE, deps);
    const shown = (await lab.rows()).filter((r) => r.state === 'active' && r.name === 'Vino');
    expect(shown).toHaveLength(1);
    expect(shown[0].id).not.toBe(wine.id);
    expect(await lab.memberIds(shown[0].id)).toEqual(expect.arrayContaining(later));
  });

  it('brings its members to its target with the better of the two scores (it does not make them worse)', async () => {
    await threeTopics(lab);
    const deps = lab.deps({ params: { ...COLLECTION_PARAMS, assignTau: -1 } });
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    await lab.store.merge(MIKE, wine.id, food.id);
    const { result } = await planConsolidation(MIKE, deps);
    const alias = result.collections.find((c) => c.id === wine.id);
    const target = new Map((result.collections.find((c) => c.id === food.id)?.members ?? []).map((m) => [m.entryId, m.score]));
    expect((alias?.members ?? []).length).toBeGreaterThan(5);
    for (const m of alias?.members ?? []) expect(target.get(m.entryId) as number).toBeGreaterThanOrEqual(m.score - 1e-9);
  });
});

describe('consolidate: a collection merged into another takes no place among the themes', () => {
  it('an entry has two places among the themes that are SHOWN: the merged collection only feeds its target, it does not use one up', async () => {
    const rand = rng(3);
    const dirs = farDirs(4, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('food', dirs[1], 7, rand);
    await lab.cluster('tech', dirs[2], 6, rand);
    await lab.cluster('art', dirs[3], 6, rand);
    await lab.noise(250, rand);
    const deps = lab.deps({ params: { ...COLLECTION_PARAMS, assignTau: -1 } });
    await consolidate(MIKE, deps);
    await lab.store.merge(MIKE, ((await lab.byName('Ristoranti')) as CollectionRow).id, ((await lab.byName('Vino')) as CollectionRow).id);
    const { result } = await planConsolidation(MIKE, deps);
    const shown = result.collections.filter((c) => c.effectiveState === 'active');
    expect(shown.map((c) => c.name).sort()).toEqual(['Arte e cultura', 'Intelligenza artificiale', 'Vino']);
    const { vectors: centred } = centerAndNormalize([...lab.vectors.values()]);
    const items = [...lab.vectors.keys()].map((id, i) => ({ id, vector: centred[i] }));
    const expected = assignToThemes(items, shown.map((c) => ({ id: c.id, centroid: c.centroid as Float32Array })), { assignTau: -1, maxThemesPerEntry: 2 });
    for (const [name, key] of [['Intelligenza artificiale', 'tech'], ['Arte e cultura', 'art']] as const) {
      const theme = shown.find((c) => c.name === name) as PlannedCollection;
      const own = [...lab.vectors.keys()].filter((id) => id.startsWith(key));
      expect(new Set(theme.members.map((m) => m.entryId))).toEqual(new Set([...own, ...(expected.get(theme.id) ?? []).map((m) => m.entryId)]));
    }
  });
});

describe('consolidate: the names a pass asks for and gives', () => {
  it('the groups are asked from the biggest to the smallest, and a new group is told the names the existing collections have', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const sizes = lab.calls.map((c) => c.members.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(sizes[0]).toBeGreaterThan(sizes[sizes.length - 1]);
    lab.calls.length = 0;
    const rand = rng(99);
    await lab.cluster('home', farDirs(1, rand)[0], 3, rand, { from: 10 });   // the small group of the start gets enough entries to be asked about
    await consolidate(MIKE, deps);
    const asked = lab.calls.find((c) => c.members[0].text.startsWith('home'));
    expect(asked).toBeUndefined();                                          // (a different direction: it is a new group of 3, not the old one: nobody is asked)
  });

  it('a new group is told the names that already exist, the ones of other collections', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.noise(25, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    lab.calls.length = 0;
    await lab.cluster('food', dirs[1], 7, rand);
    await consolidate(MIKE, deps);
    expect(lab.calls).toHaveLength(1);
    expect(lab.calls[0].existing).toEqual(['Vino']);
  });

  it('a collection the user hid does not keep a new group from taking its name: the new one is shown, the hidden one stays hidden', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.noise(25, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    await lab.store.hide(MIKE, wine.id);
    await lab.cluster('wineb', dirs[1], 7, rand, { tags: [] });             // another group, that the model also calls «Vino»
    await consolidate(MIKE, deps);
    const rows = await lab.rows();
    expect(rows.find((r) => r.id === wine.id)?.state).toBe('hidden');
    const shown = rows.filter((r) => r.state === 'active' && r.name === 'Vino');
    expect(shown).toHaveLength(1);
    expect(shown[0].id).not.toBe(wine.id);
  });

  it('a collection merged into another does not keep a new group from taking its name either', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('food', dirs[2], 7, rand);
    await lab.noise(25, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    await lab.store.merge(MIKE, wine.id, food.id);
    await lab.cluster('wineb', dirs[1], 7, rand, { tags: [] });
    await consolidate(MIKE, deps);
    const shown = (await lab.rows()).filter((r) => r.state === 'active' && r.name === 'Vino');
    expect(shown).toHaveLength(1);
    expect(shown[0].id).not.toBe(wine.id);
  });

  it('a name the user gave to a SMALLER collection wins over the engine\'s own group with that name; two the user named alike both keep it', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;               // 8 entries
    const food = (await lab.byName('Ristoranti')) as CollectionRow;         // 7 entries
    await lab.store.rename(MIKE, food.id, 'Vino');
    await consolidate(MIKE, deps);
    const rows = await lab.rows();
    expect(rows.filter((r) => r.name === 'Vino')).toHaveLength(1);
    expect(rows.find((r) => r.id === food.id)).toMatchObject({ name: 'Vino', nameBy: 'user' });
    expect(rows.find((r) => r.id === wine.id)?.name).not.toBe('Vino');
    await lab.store.rename(MIKE, wine.id, 'Vino');
    await consolidate(MIKE, deps);
    expect((await lab.rows()).filter((r) => r.name === 'Vino').map((r) => r.nameBy)).toEqual(['user', 'user']);
    expect((await rebuildPreview(MIKE, deps)).filter((p) => p.name === 'Vino')).toHaveLength(2);        // the decisions say it too, not only what the store kept
  });

  it('«Claude Code» and «ClaudeCode» are one name for the collisions too: two groups far apart that carry them share ONE name', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    lab.names.wine = 'Claude Code';
    lab.names.wineb = 'ClaudeCode';
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('wineb', dirs[1], 6, rand, { tags: [] });
    await lab.noise(25, rand);
    await consolidate(MIKE, lab.deps());
    const rows = await lab.rows();
    expect(rows.filter((r) => /claude/i.test(r.name) && r.state === 'active')).toHaveLength(1);
    expect(rows.some((r) => r.name === UNNAMED && r.size >= 6)).toBe(true);
  });

  it('the tag that names a loser is snapped to the list too («#umorismi» is «Umorismo»), and a name with letters missing or too many is not the name of the list', async () => {
    const rand = rng(14);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('wineb', dirs[1], 6, rand, { tags: ['#umorismi'] });
    await lab.noise(25, rand);
    await consolidate(MIKE, lab.deps());
    expect(await lab.byName('Umorismo')).toMatchObject({ origin: 'seed', groupLabel: 'Cultura e svago' });
    lab = new Lab();
    await threeTopics(lab);
    lab.names.tech = 'Intelligenza artifi';                                  // 5 letters short: an insertion is a letter that costs
    lab.names.wine = 'Intelligenza artificialeeee';                         // 4 too many
    await consolidate(MIKE, lab.deps());
    expect(await lab.byName('Intelligenza artifi')).toBeDefined();
    expect(await lab.byName('Intelligenza artificialeeee')).toBeDefined();
  });
});

describe('consolidate: states, members and the user\'s corrections', () => {
  it('a collection the user left with fewer than 3 entries is no longer a group: it loses its automatic members (the store keeps what he touched)', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    for (const id of wineIds(6)) await lab.store.removeEntry(MIKE, wine.id, id);
    await consolidate(MIKE, deps);
    expect(await lab.memberIds(wine.id)).toEqual([]);
  });

  it('the decisions of a pass never include an entry taken out of a collection (not even before the store would drop it), and a merged collection does not bring one back to its target', async () => {
    await threeTopics(lab);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const wine = (await lab.byName('Vino')) as CollectionRow;
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    await lab.store.removeEntry(MIKE, wine.id, 'wine0');
    expect((await rebuildPreview(MIKE, deps)).find((p) => p.id === wine.id)?.memberIds).not.toContain('wine0');
    await lab.store.merge(MIKE, wine.id, food.id);
    await lab.store.removeEntry(MIKE, food.id, 'wine1');
    const target = (await rebuildPreview(MIKE, deps)).find((p) => p.id === food.id);
    expect(target?.memberIds).not.toContain('wine1');
    expect(target?.memberIds).toEqual(expect.arrayContaining(['wine2', 'wine3', 'food0']));
  });

  it('the detailed decisions say what each collection was and is: the old name, who named it, the best score first (ties by id), and what no group stands behind', async () => {
    const rand = rng(3);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.add('twin1', dirs[0], { key: 'wine' });                       // two entries with the same vector: the same score
    await lab.add('twin0', dirs[0], { key: 'wine' });
    await lab.cluster('food', dirs[1], 7, rand);
    await lab.noise(30, rand);
    const deps = lab.deps();
    await consolidate(MIKE, deps);
    const food = (await lab.byName('Ristoranti')) as CollectionRow;
    await lab.store.rename(MIKE, food.id, 'Mangiare');
    const { result } = await planConsolidation(MIKE, deps);
    const planned = result.collections.find((c) => c.id === food.id);
    expect([planned?.name, planned?.nameBy, planned?.previousName, planned?.isNew]).toEqual(['Mangiare', 'user', 'Mangiare', false]);
    const wine = result.collections.find((c) => c.name === 'Vino');
    expect(wine?.previousName).toBe('Vino');
    const scores = (wine?.members ?? []).map((m) => m.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const twins = (wine?.members ?? []).filter((m) => m.entryId.startsWith('twin')).map((m) => m.entryId);
    expect(twins).toEqual(['twin0', 'twin1']);                              // the same score: the id decides
    for (const c of result.collections) expect(c.coherence).toBeGreaterThan(0);
  });

  it('an entry near three themes joins two; taken out of one it joins the third (a correction is not one of the two)', async () => {
    const rand = rng(23);
    const dirs = farDirs(3, rand);
    await lab.cluster('wine', dirs[0], 8, rand);
    await lab.cluster('food', dirs[1], 7, rand);
    await lab.cluster('tech', dirs[2], 6, rand);
    await lab.noise(25, rand);
    await lab.add('mix0', unit(dirs[0].map((x, i) => x + 0.95 * dirs[1][i] + 0.9 * dirs[2][i])), { key: 'wine' });
    const deps = lab.deps({ params: { ...COLLECTION_PARAMS, assignTau: 0.2 } });
    await consolidate(MIKE, deps);
    const themes = [(await lab.byName('Vino')) as CollectionRow, (await lab.byName('Ristoranti')) as CollectionRow, (await lab.byName('Intelligenza artificiale')) as CollectionRow];
    const holders = [];
    for (const t of themes) if ((await lab.memberIds(t.id)).includes('mix0')) holders.push(t);
    expect(holders).toHaveLength(2);                                        // never three
    const third = themes.find((t) => !holders.includes(t)) as CollectionRow;
    await lab.store.removeEntry(MIKE, holders[0].id, 'mix0');
    await consolidate(MIKE, deps);
    expect(await lab.memberIds(holders[0].id)).not.toContain('mix0');
    expect(await lab.memberIds(third.id)).toContain('mix0');
  });
});

describe('assignOne: what the fast lane reads and writes', () => {
  async function started(): Promise<{ dirs: Float32Array[]; rand: () => number; wine: CollectionRow }> {
    const { dirs, rand } = await threeTopics(lab);
    await consolidate(MIKE, lab.deps());
    return { dirs, rand, wine: (await lab.byName('Vino')) as CollectionRow };
  }

  it('what another entry was taken out of does not stop this one from joining', async () => {
    const { dirs, rand, wine } = await started();
    await lab.store.removeEntry(MIKE, wine.id, 'wine1');
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    expect(await assignOne(MIKE, 'wine8', lab.assignDeps())).toContain(wine.id);
  });

  it('joins two collections at most, however many it is close to', async () => {
    const { dirs } = await started();
    await lab.add('mix', unit(dirs[0].map((x, i) => x + 0.95 * dirs[1][i] + 0.9 * dirs[2][i])), { key: 'wine' });
    const joined = await assignOne(MIKE, 'mix', { ...lab.assignDeps(), params: { ...COLLECTION_PARAMS, assignTau: 0.1 } });
    expect(joined).toHaveLength(2);
  });

  it('joins with the score it has there (its cosine to the centre), a number under 1', async () => {
    const { dirs, rand, wine } = await started();
    await lab.add('wine8', around(dirs[0], 0.3, rand), { key: 'wine' });
    await assignOne(MIKE, 'wine8', lab.assignDeps());
    const score = (await lab.store.membersOf(wine.id)).find((m) => m.entryId === 'wine8')?.score as number;
    expect(score).toBeGreaterThan(COLLECTION_PARAMS.assignTau);
    expect(score).toBeLessThan(0.999);
  });

  it('an entry of another vector length (an older model) is nobody\'s: nothing, no crash', async () => {
    await started();
    lab.store.registerEntry({ id: 'odd', ownerUser: MIKE });
    await lab.store.saveVector('odd', 'old-model', [1, 0, 0], 'h-odd');
    const asked = vi.spyOn(lab.store, 'listCollections');
    expect(await assignOne(MIKE, 'odd', lab.assignDeps())).toEqual([]);
    expect(asked).not.toHaveBeenCalled();                         // nobody is even asked about the collections: there is nothing to compare it with
  });

  it('a vector is centred on the mean of the library before it is compared (the centres of the collections are centred): a library whose entries all share a big part', async () => {
    const rand = rng(8);
    const common = randomDir(rand);
    const offset = (v: Float32Array): Float32Array => unit(common.map((x, i) => 3 * x + v[i]));
    const dirs = farDirs(3, rand);
    for (const [key, k, n] of [['wine', 0, 8], ['food', 1, 7], ['tech', 2, 6]] as const) {
      for (let i = 0; i < n; i += 1) await lab.add(`${key}${i}`, offset(around(dirs[k], 0.3, rand)), { key });
    }
    for (let i = 0; i < 60; i += 1) await lab.add(`noise${i}`, offset(randomDir(rand)), { key: 'noise' });
    await consolidate(MIKE, lab.deps());
    const wine = (await lab.byName('Vino')) as CollectionRow;
    await lab.add('wine8', offset(dirs[0]), { key: 'wine' });
    expect(await assignOne(MIKE, 'wine8', lab.assignDeps())).toContain(wine.id);
  });
});
