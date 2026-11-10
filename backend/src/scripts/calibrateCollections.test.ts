import { describe, expect, it, vi } from 'vitest';
import { GOLDEN_SET, bestCollectionFor, bestGroupFor, foldText, parseExport, previewCollections, retryingPost, shareOf, type ExportRow } from './calibrateCollections';
import { COLLECTION_PARAMS } from '../services/collectionsParams';
import { cosine } from '../services/collectionsCluster';

// Raccolte, task 1, phase 0 (spec 2026-11-09-library-collections-auto-topics-design.md §3.1, §9): the pieces of the read-only calibration that can be
// tested without the library or the router: reading the export, the golden set, the retries for a router that is waking up.

const row = (over: Partial<ExportRow>): ExportRow => ({
  id: 'e', createdAt: '2026-11-01T00:00:00Z', status: 'completed', caption: null, tags: [], summary: null, hasSongs: false, hasContentSongs: false, hasFilms: false, ...over,
});

describe('parseExport', () => {
  it('reads one JSON per line, skips the empty ones, and gives a row that is not complete the values it lacks', () => {
    const rows = parseExport(`${JSON.stringify({ id: 'a', createdAt: '2026-01-01T00:00:00Z', caption: 'x', tags: ['#vino'], summary: 's' })}\n\n${JSON.stringify({ id: 'b', createdAt: '2026-01-02T00:00:00Z' })}\n`);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[1]).toMatchObject({ caption: null, tags: [], summary: null, hasSongs: false, hasContentSongs: false, hasFilms: false });
  });
});

describe('foldText', () => {
  it('is lower case, without accents and without the # of the tags, the summary the caption and the tags in one text', () => {
    expect(foldText(row({ summary: 'Città di Milano', caption: 'Perché', tags: ['#Vino', '@x'] }))).toBe('citta di milano perche vino @x');
  });
});

describe('the golden set (spec §9)', () => {
  const find = (name: string) => GOLDEN_SET.find((g) => g.name === name)!;

  it('wine is found by its words, and not inside other words', () => {
    const wine = find('Vino').test;
    expect(wine(foldText(row({ summary: 'I migliori vini italiani e i vitigni' })))).toBe(true);
    expect(wine(foldText(row({ summary: 'Una cantina in Toscana' })))).toBe(true);
    expect(wine(foldText(row({ summary: 'Il destino e un divino talento' })))).toBe(false);
  });

  it('a restaurant that names Milano needs both', () => {
    const rest = find('Ristoranti a Milano').test;
    expect(rest(foldText(row({ summary: 'Ecco i ristoranti nuovi da provare su Milano' })))).toBe(true);
    expect(rest(foldText(row({ summary: 'Ecco i ristoranti nuovi da provare a Roma' })))).toBe(false);
    expect(rest(foldText(row({ summary: 'Una gita a Milano' })))).toBe(false);
  });

  it('a house and its design need both: a house alone, or a design alone (an app), is not the topic', () => {
    const casa = find('Casa e design').test;
    expect(casa(foldText(row({ summary: 'Come progettare casa con la bioedilizia' })))).toBe(true);
    expect(casa(foldText(row({ summary: 'Interior design per un piccolo appartamento' })))).toBe(true);
    expect(casa(foldText(row({ summary: 'Ristrutturare una villa: arredamento e interni' })))).toBe(true);
    expect(casa(foldText(row({ summary: 'Torno a casa dopo il lavoro' })))).toBe(false);
    expect(casa(foldText(row({ summary: 'Il design di una nuova app per telefono' })))).toBe(false);
  });

  it('the thresholds are the ones of the spec: 12, 5 and 8', () => {
    expect(GOLDEN_SET.map((g) => [g.name, g.minHits])).toEqual([['Vino', 12], ['Ristoranti a Milano', 5], ['Casa e design', 8]]);
  });
});

describe('bestGroupFor', () => {
  const groups = [
    { members: ['a', 'b', 'c', 'd'] },
    { members: ['e', 'f', 'g'] },
    { members: ['h'] },
  ] as Array<{ members: string[] }>;

  it('is the group that holds most of the hits, with its size, hits and precision', () => {
    expect(bestGroupFor(groups, new Set(['a', 'b', 'e', 'x']))).toEqual({ groupIndex: 0, size: 4, hits: 2, precision: 0.5, totalHits: 4 });
  });

  it('on a tie the smaller (more precise) group wins; no hits at all is null', () => {
    expect(bestGroupFor(groups, new Set(['a', 'e']))?.groupIndex).toBe(1);
    expect(bestGroupFor(groups, new Set(['zz']))).toBeNull();
  });
});

describe('shareOf', () => {
  it('is the part of the members that have a property', () => {
    const by = new Map<string, ExportRow>([['a', row({ hasFilms: true })], ['b', row({})], ['c', row({ hasFilms: true })], ['d', row({})]]);
    expect(shareOf(['a', 'b', 'c', 'd'], by, (r) => r.hasFilms)).toBe(0.5);
    expect(shareOf([], by, (r) => r.hasFilms)).toBe(0);
  });
});

describe('retryingPost: the router may be asleep', () => {
  it('tries again after a failure, waiting longer each time, and returns the first good answer', async () => {
    const waits: number[] = [];
    const post = vi.fn()
      .mockRejectedValueOnce(new Error('router asleep'))
      .mockRejectedValueOnce(new Error('router asleep'))
      .mockResolvedValueOnce({ embeddings: [[1]] });
    const wrapped = retryingPost(post, { attempts: 5, waitMs: 100, sleep: async (ms) => { waits.push(ms); } });
    await expect(wrapped('u', {})).resolves.toEqual({ embeddings: [[1]] });
    expect(post).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([100, 200]);
  });

  it('gives up after the attempts, with the last error', async () => {
    const post = vi.fn().mockRejectedValue(new Error('still asleep'));
    const wrapped = retryingPost(post, { attempts: 3, waitMs: 1, sleep: async () => undefined });
    await expect(wrapped('u', {})).rejects.toThrow('still asleep');
    expect(post).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// previewCollections: what the engine will publish, in miniature (groups → type and coherence gates → children → assignment), with synthetic vectors
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
const unitOf = (v: Float32Array): Float32Array => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n === 0 ? v : v.map((x) => x / n);
};
const randomDir = (rand: () => number): Float32Array => unitOf(Float32Array.from({ length: DIM }, () => gauss(rand)));
const near = (dir: Float32Array, noise: number, rand: () => number): Float32Array => unitOf(dir.map((x) => x + (noise * gauss(rand)) / Math.sqrt(DIM)));
/** `count` directions that are far from each other, drawn again until they are. */
function farDirs(count: number, rand: () => number): Float32Array[] {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const dirs = Array.from({ length: count }, () => randomDir(rand));
    let far = true;
    for (let i = 0; i < dirs.length; i += 1) for (let j = i + 1; j < dirs.length; j += 1) if (Math.abs(cosine(dirs[i], dirs[j])) >= 0.2) far = false;
    if (far) return dirs;
  }
  throw new Error('no directions far enough');
}
const cluster = (prefix: string, dir: Float32Array, n: number, noise: number, rand: () => number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, vector: near(dir, noise, rand) }));
const idsOf = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const NO_TYPES = { typeCentres: { music: null, films: null }, flagged: { music: new Set<string>(), films: new Set<string>() } };

describe('previewCollections: the groups the engine would publish', () => {
  it('publishes the topics, absorbs the group that is music by its centre, and drops the ones that are too small', () => {
    const rand = rng(11);
    const [a, b, m, tiny] = farDirs(4, rand);
    const items = [...cluster('a', a, 8, 0.3, rand), ...cluster('b', b, 6, 0.3, rand), ...cluster('m', m, 9, 0.3, rand), ...cluster('t', tiny, 3, 0.3, rand)];
    const out = previewCollections(items, { typeCentres: { music: m, films: null }, flagged: { music: new Set(), films: new Set() } });
    expect(out.collections.map((c) => c.size).sort()).toEqual([6, 8]);
    expect(out.absorbed.map((x) => [x.group.members.length, x.type, x.by])).toEqual([[9, 'music', 'centre']]);
    expect(out.groups.map((g) => g.members.length).sort((x, y) => x - y)).toEqual([6, 8, 9]);          // the group of 3 is not even a candidate (birthSize)
  });

  it('a group is born at exactly the birth size (5), and not under it', () => {
    const rand = rng(16);
    const [a, b] = farDirs(2, rand);
    const out = previewCollections([...cluster('a', a, 5, 0.3, rand), ...cluster('b', b, 4, 0.3, rand)], NO_TYPES);
    expect(out.collections.map((c) => c.size)).toEqual([5]);
    expect(out.groups.map((g) => g.members.length)).toEqual([5]);
  });

  it('the passes of the parameters are used: an early entry that joined the wrong group is put back (0°, 30°, 47° then 65° and its neighbours)', () => {
    const items = [0, 30, 47, 65, 67, 63, 66].map((d) => ({ id: `v${d}`, vector: Float32Array.from([Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)]) }));
    const params = { ...COLLECTION_PARAMS, groupTau: Math.cos((35 * Math.PI) / 180), mergeTau: 0.9999, birthSize: 3, minCoherence: 0, assignTau: 2 };
    const out = previewCollections(items, NO_TYPES, params);
    expect(out.groups.find((g) => g.members.includes('v47'))?.members).toContain('v65');
  });

  it('a group that is mostly music by its MEMBERS is absorbed even when its centre is far from the music centre', () => {
    const rand = rng(12);
    const [a, m, far] = farDirs(3, rand);
    const items = [...cluster('a', a, 8, 0.3, rand), ...cluster('m', m, 10, 0.3, rand)];
    const out = previewCollections(items, { typeCentres: { music: far, films: null }, flagged: { music: new Set(idsOf('m', 8)), films: new Set() } });
    expect(out.absorbed.map((x) => [x.group.members.length, x.type, x.by])).toEqual([[10, 'music', 'members']]);
    expect(out.collections).toHaveLength(1);
  });

  it('a group that is a loose blob is not published (and is said to be loose), a tight one is', () => {
    const rand = rng(13);
    const [a] = farDirs(1, rand);
    const items = [...cluster('a', a, 8, 0.3, rand), ...Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, vector: randomDir(rand) }))];
    const out = previewCollections(items, NO_TYPES, { ...COLLECTION_PARAMS, groupTau: 0.9, mergeTau: 2, assignTau: 0.9 });
    expect(out.collections.map((c) => c.size)).toEqual([8]);
    const loose = previewCollections(items, NO_TYPES, { ...COLLECTION_PARAMS, groupTau: -1, mergeTau: 2, minCoherence: 0.5 });
    expect(loose.loose.map((g) => g.members.length)).toEqual([38]);
    expect(loose.collections).toEqual([]);
  });

  it('a big group with two sub-topics gives its parent and two children; the children are absorbed by their members too', () => {
    const rand = rng(14);
    const [common, s1, s2] = farDirs(3, rand);
    const mix = (sub: Float32Array): Float32Array => unitOf(common.map((x, i) => 0.8 * x + 0.6 * sub[i]));
    const items = [...cluster('p', mix(s1), 35, 0.2, rand), ...cluster('q', mix(s2), 35, 0.2, rand)];
    const out = previewCollections(items, NO_TYPES);
    const kinds = out.collections.map((c) => c.kind);
    expect(kinds.filter((k) => k === 'group')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'child')).toHaveLength(2);
    const parent = out.collections.findIndex((c) => c.kind === 'group');
    for (const c of out.collections.filter((x) => x.kind === 'child')) {
      expect(c.parent).toBe(parent);
      expect(c.assigned.sort()).toEqual([...c.members].sort());               // a child holds its own members
    }
    // the same, with one child made of entries that are about films: that child is a type and not a theme
    const films = previewCollections(items, { typeCentres: { music: null, films: null }, flagged: { music: new Set(), films: new Set(idsOf('p', 35)) } });
    expect(films.absorbed.filter((x) => x.group.members.every((m) => m.startsWith('p'))).map((x) => [x.type, x.by])).toContainEqual(['films', 'members']);
    expect(films.collections.filter((c) => c.kind === 'child')).toHaveLength(1);
  });

  it('the assignment: an entry joins the theme it is close enough to, even if it was not in the group; at most two themes; the far ones join none', () => {
    const rand = rng(15);
    const [a, b, lone] = farDirs(3, rand);
    const items = [...cluster('a', a, 8, 0.3, rand), ...cluster('b', b, 8, 0.3, rand)];
    const between = { id: 'between', vector: unitOf(a.map((x, i) => x + b[i])) };
    const nearA = { id: 'nearA', vector: near(a, 0.5, rand) };
    const nowhere = { id: 'nowhere', vector: lone };
    const out = previewCollections([...items, between, nearA, nowhere], NO_TYPES, { ...COLLECTION_PARAMS, groupTau: 0.6, mergeTau: 0.9, assignTau: 0.6 });
    expect(out.collections).toHaveLength(2);
    const holding = (id: string): number => out.collections.filter((c) => c.assigned.includes(id)).length;
    expect(holding('between')).toBe(2);
    expect(holding('nearA')).toBe(1);
    expect(holding('nowhere')).toBe(0);
    expect(out.collections.every((c) => c.assigned.length >= c.size - 1)).toBe(true);
  });

  it('an entry that is close to three themes joins two of them, never three', () => {
    const rand = rng(17);
    const [a, b, c] = farDirs(3, rand);
    const items = [...cluster('a', a, 6, 0.3, rand), ...cluster('b', b, 6, 0.3, rand), ...cluster('c', c, 6, 0.3, rand)];
    const tri = { id: 'tri', vector: unitOf(Float32Array.from(a, (x, i) => x + b[i] + c[i])) };
    const out = previewCollections([...items, tri], NO_TYPES, { ...COLLECTION_PARAMS, groupTau: 0.8, mergeTau: 0.95, assignTau: 0.4 });
    expect(out.collections).toHaveLength(3);
    expect(out.collections.filter((x) => x.assigned.includes('tri'))).toHaveLength(COLLECTION_PARAMS.maxThemesPerEntry);
  });
});

describe('bestCollectionFor: the collection that holds most of a topic', () => {
  const col = (assigned: string[]) => ({ kind: 'group' as const, parent: null, size: assigned.length, coherence: 0.6, centroid: new Float32Array(2), members: assigned, assigned });
  it('counts what the collection holds AFTER the assignment, not only its own members', () => {
    const grown = { kind: 'group' as const, parent: null, size: 1, coherence: 0.6, centroid: new Float32Array(2), members: ['a'], assigned: ['a', 'b', 'c'] };
    expect(bestCollectionFor([grown], new Set(['b', 'c']))).toEqual({ index: 0, kind: 'group', size: 3, hits: 2, precision: 2 / 3, totalHits: 2 });
  });

  it('counts what the collection holds after the assignment, with its size and precision; the smaller one wins a tie; no hit is null', () => {
    const cols = [col(['a', 'b', 'c', 'd']), col(['a', 'b']), col(['z'])];
    expect(bestCollectionFor(cols, new Set(['a', 'b', 'x']))).toEqual({ index: 1, kind: 'group', size: 2, hits: 2, precision: 1, totalHits: 3 });
    expect(bestCollectionFor(cols, new Set(['q']))).toBeNull();
  });
});
