import { describe, expect, it } from 'vitest';
import { MemoryCollectionsStore, type EntryPlaceRow } from '../services/collectionsStore';
import { seedGroupOf } from '../services/collectionsNaming';
import { COLLECTION_PARAMS } from '../services/collectionsParams';
import { UNNAMED, type EngineDeps, type EntryFeatures } from '../services/collectionsEngine';
import { evaluateGolden, exitCodeOf, parseArgs, rebuildCollectionsScript, type GoldenInput, type ScriptDeps } from './rebuildCollections';

// Raccolte, task 7: the script that rebuilds the collections by hand (spec §5.10 and §9). ANTEPRIMA per default (nothing written; `--apply` only with Michele's OK),
// and the golden set of the spec read on what the pass would make. The engine runs on the in-memory store with synthetic vectors, like its own tests.

const feats = (over: Partial<EntryFeatures> = {}): EntryFeatures => ({ text: 'un post', tags: [], hasContentSongs: false, hasFilms: false, ...over });
const place = (entryId: string, name: string): EntryPlaceRow => ({ entryId, name, kind: 'city' });
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function input(over: Partial<GoldenInput> = {}): GoldenInput {
  return { collections: [], features: new Map(), places: [], texts: new Map(), ...over };
}

describe('parseArgs', () => {
  it('is a preview of every owner by default', () => {
    expect(parseArgs([])).toEqual({ apply: false, owner: null, all: false });
  });

  it('--apply writes, --owner picks one user, --all lists the groups that are only watching too', () => {
    expect(parseArgs(['--apply', '--owner', 'mike', '--all'])).toEqual({ apply: true, owner: 'mike', all: true });
  });

  it('--dry-run is what it already is', () => {
    expect(parseArgs(['--dry-run']).apply).toBe(false);
  });

  it('--owner without a name is an error (not «every owner»)', () => {
    expect(() => parseArgs(['--owner'])).toThrow(/--owner/);
    expect(() => parseArgs(['--owner', '--apply'])).toThrow(/--owner/);
  });
});

describe('the golden set of the spec (§9), read on what the pass makes', () => {
  const col = (name: string, members: string[], state = 'active') => ({ name, state, memberIds: members });
  const status = (checks: ReturnType<typeof evaluateGolden>, name: RegExp) => checks.find((c) => name.test(c.name))?.status;

  it('«Vino» needs 12 entries in one collection; fewer is a failure, and no such collection is a failure', () => {
    expect(status(evaluateGolden(input({ collections: [col('Vino', ids('w', 12))] })), /^Vino/)).toBe('PASS');
    expect(status(evaluateGolden(input({ collections: [col('Vino', ids('w', 11))] })), /^Vino/)).toBe('FAIL');
    expect(status(evaluateGolden(input({ collections: [col('Ricette', ids('w', 30))] })), /^Vino/)).toBe('FAIL');
  });

  it('a collection that is only «watching» is not published: it does not count', () => {
    expect(status(evaluateGolden(input({ collections: [col('Vino', ids('w', 20), 'watching')] })), /^Vino/)).toBe('FAIL');
  });

  it('«Casa e design» needs 8', () => {
    expect(status(evaluateGolden(input({ collections: [col('Casa e design', ids('h', 8))] })), /^Casa e design/)).toBe('PASS');
    expect(status(evaluateGolden(input({ collections: [col('Casa e design', ids('h', 7))] })), /^Casa e design/)).toBe('FAIL');
  });

  it.each(['Design', 'Casa', 'Arredamento', 'Interior design'])('the home topic may come out of the model as «%s», not only as «Casa e design»: the check is about the topic, not the exact word', (alias) => {
    expect(status(evaluateGolden(input({ collections: [col(alias, ids('h', 13))] })), /^Casa e design/)).toBe('PASS');
    expect(status(evaluateGolden(input({ collections: [col(alias, ids('h', 7))] })), /^Casa e design/)).toBe('FAIL');
  });

  it('a collection with another subject does not stand for the home topic (and the largest of the names that do is the one that counts)', () => {
    expect(status(evaluateGolden(input({ collections: [col('Graphic design agency', ids('h', 13))] })), /^Casa e design/)).toBe('FAIL');
    expect(status(evaluateGolden(input({ collections: [col('Design', ids('h', 5)), col('Casa e design', ids('i', 9))] })), /^Casa e design/)).toBe('PASS');
  });

  it('«Ristoranti a Milano»: a collection named Ristoranti with 5 entries whose place is Milano; no places read yet is a skip, not a failure', () => {
    const members = ids('r', 9);
    const places = ids('r', 5).map((id) => place(id, 'Milano'));
    expect(status(evaluateGolden(input({ collections: [col('Ristoranti', members)], places })), /Milano/)).toBe('PASS');
    expect(status(evaluateGolden(input({ collections: [col('Ristoranti', members)], places: places.slice(0, 4) })), /Milano/)).toBe('FAIL');
    expect(status(evaluateGolden(input({ collections: [col('Ristoranti', members)], places: [] })), /Milano/)).toBe('SKIP');
    expect(status(evaluateGolden(input({ collections: [col('Cucina', members)], places })), /Milano/)).toBe('FAIL');
    // the places of OTHER cities do not count, and neither do those of entries that are not in the collection
    const elsewhere = ids('r', 9).map((id) => place(id, 'Roma'));
    expect(status(evaluateGolden(input({ collections: [col('Ristoranti', members)], places: elsewhere })), /Milano/)).toBe('FAIL');
    expect(status(evaluateGolden(input({ collections: [col('Ristoranti', members)], places: ids('x', 6).map((id) => place(id, 'Milano')) })), /Milano/)).toBe('FAIL');
  });

  it('no published theme is mostly music or films: at the bar the engine absorbs with (70 % of its entries have songs from the content, or films)', () => {
    const features = new Map<string, EntryFeatures>([
      ...ids('m', 7).map((id) => [id, feats({ hasContentSongs: true })] as const),
      ...ids('n', 5).map((id) => [id, feats()] as const),
    ]);
    const mostlyMusic = col('Anime', [...ids('m', 7), ...ids('n', 2)]);          // 7 of 9: 78 %
    const fine = col('Vino', [...ids('m', 2), ...ids('n', 5)]);                  // 2 of 7
    expect(status(evaluateGolden(input({ collections: [fine], features })), /musica o film/i)).toBe('PASS');
    expect(status(evaluateGolden(input({ collections: [fine, mostlyMusic], features })), /musica o film/i)).toBe('FAIL');
    const films = new Map<string, EntryFeatures>(ids('f', 4).map((id) => [id, feats({ hasFilms: true })] as const));
    expect(status(evaluateGolden(input({ collections: [col('Cinema', ids('f', 4))], features: films })), /musica o film/i)).toBe('FAIL');
    // a collection that is only «watching» is not published: it cannot fail the check
    expect(status(evaluateGolden(input({ collections: [{ ...mostlyMusic, state: 'watching' }], features })), /musica o film/i)).toBe('PASS');
  });

  it('a theme between half and the bar of the engine (the «Anime» of the real library, 63 % films) passes and is only shown; at the bar it fails', () => {
    const features = new Map<string, EntryFeatures>([
      ...ids('f', 5).map((id) => [id, feats({ hasFilms: true })] as const),
      ...ids('n', 3).map((id) => [id, feats()] as const),
    ]);
    const anime = col('Anime', [...ids('f', 5), ...ids('n', 3)]);                // 5 of 8: 62.5 %
    const checks = evaluateGolden(input({ collections: [anime], features }));
    const check = checks.find((c) => /musica o film/i.test(c.name));
    expect(check?.status).toBe('PASS');
    expect(check?.detail).toMatch(/vicine alla soglia: «Anime» 63%/);
    const seven = new Map<string, EntryFeatures>([...ids('f', 7).map((id) => [id, feats({ hasFilms: true })] as const), ...ids('n', 3).map((id) => [id, feats()] as const)]);
    expect(status(evaluateGolden(input({ collections: [col('Anime', [...ids('f', 7), ...ids('n', 3)])], features: seven })), /musica o film/i)).toBe('FAIL');   // exactly 70 %
    expect(status(evaluateGolden(input({ collections: [col('Anime', [...ids('f', 6), ...ids('n', 4)])], features: new Map([...ids('f', 6).map((id) => [id, feats({ hasFilms: true })] as const), ...ids('n', 4).map((id) => [id, feats()] as const)]) })), /musica o film/i)).toBe('PASS');   // 60 %
  });

  it('no name has a symbol of the trial: # @ " *', () => {
    expect(status(evaluateGolden(input({ collections: [col('Vino', []), col('Arte e cultura', [])] })), /simboli/)).toBe('PASS');
    for (const bad of ['#Vini', '@Tecnologia', 'Il "vino"', 'Vino*']) {
      expect(status(evaluateGolden(input({ collections: [col(bad, [])] })), /simboli/)).toBe('FAIL');
    }
  });

  it('every place the pass reports for an entry is in the text it was read from; one that is not is a failure naming the entry', () => {
    const places = [place('e1', 'Milano'), place('e2', 'Reims')];
    const texts = new Map([['e1', 'Ristoranti a Milano da provare'], ['e2', 'Un post sul vino francese']]);
    const checks = evaluateGolden(input({ collections: [col('Ristoranti', ['e1', 'e2'])], places, texts }));
    const grounded = checks.find((c) => /testo/.test(c.name));
    expect(grounded?.status).toBe('FAIL');
    expect(grounded?.detail).toMatch(/e2/);
    expect(grounded?.detail).not.toMatch(/e1/);
    expect(status(evaluateGolden(input({ collections: [col('Ristoranti', ['e1'])], places: [places[0]], texts })), /testo/)).toBe('PASS');
  });

  it('a place is checked the way the pass finds it: any written form the list knows grounds it (the English name, a possessive, a hyphen compound, a hashtag), not only the name the list stores', () => {
    const places = [place('e1', 'Messico'), place('e2', 'Cina'), place('e3', 'Germania'), place('e4', 'Messico')];
    const texts = new Map([
      ['e1', "It also mentions Mexico's biodiversity and its history"],
      ['e2', 'China’s DeepSeek just took a serious shot at Claude Code'],
      ['e3', 'A GERMANY-BASED AI STARTUP JUST RELEASED a new generator'],
      ['e4', 'ricette di cucina #mexico'],
    ]);
    expect(status(evaluateGolden(input({ collections: [col('Viaggi', ['e1', 'e2', 'e3', 'e4'])], places, texts })), /testo/)).toBe('PASS');
    // and a place the text does not name in any form is still a failure
    const wrong = new Map([['e1', 'Un post sul vino francese'], ['e2', 'China’s DeepSeek'], ['e3', 'Germany'], ['e4', '#mexico']]);
    const checks = evaluateGolden(input({ collections: [col('Viaggi', ['e1', 'e2', 'e3', 'e4'])], places, texts: wrong }));
    const grounded = checks.find((c) => /testo/.test(c.name));
    expect(grounded?.status).toBe('FAIL');
    expect(grounded?.detail).toMatch(/e1/);
    expect(grounded?.detail).not.toMatch(/e2|e3|e4/);
  });

  it('an unnamed collection never counts as published, even if it were active; the biggest of two with one name is the one that counts; the case of a name does not matter', () => {
    const features = new Map<string, EntryFeatures>(ids('m', 8).map((id) => [id, feats({ hasContentSongs: true })] as const));
    expect(status(evaluateGolden(input({ collections: [col(UNNAMED, ids('m', 8))], features })), /musica o film/i)).toBe('PASS');
    expect(status(evaluateGolden(input({ collections: [col('Vino', ids('a', 5)), col('Vino', ids('b', 20))] })), /^Vino/)).toBe('PASS');
    expect(status(evaluateGolden(input({ collections: [col('vino', ids('b', 12))] })), /^Vino/)).toBe('PASS');
    expect(status(evaluateGolden(input({ collections: [col('CASA E DESIGN', ids('h', 8))] })), /^Casa e design/)).toBe('PASS');
  });

  it('a theme under half is not even mentioned; a collection with no entries is never mostly anything', () => {
    const features = new Map<string, EntryFeatures>([...ids('f', 4).map((id) => [id, feats({ hasFilms: true })] as const), ...ids('n', 5).map((id) => [id, feats()] as const)]);
    const check = evaluateGolden(input({ collections: [col('Cinema', [...ids('f', 4), ...ids('n', 5)]), col('Vuota', [])], features })).find((c) => /musica o film/i.test(c.name));
    expect(check?.status).toBe('PASS');                                      // 4 of 9 is 44 %
    expect(check?.detail).not.toMatch(/vicine/);
  });

  it('a name with a symbol fails even when the collection is only «watching» (it is saved all the same)', () => {
    expect(status(evaluateGolden(input({ collections: [col('#Vini', [], 'watching')] })), /simboli/)).toBe('FAIL');
  });

  it('a place whose text could not be read is not a failure (nothing is known against it)', () => {
    const checks = evaluateGolden(input({ collections: [col('Ristoranti', ['e1'])], places: [place('e1', 'Reims')], texts: new Map() }));
    expect(status(checks, /testo/)).toBe('PASS');
  });

  it('no places in the database at all: the checks that need places are skipped', () => {
    const checks = evaluateGolden(input({ collections: [col('Vino', ids('w', 12))] }));
    expect(status(checks, /testo/)).toBe('SKIP');
    expect(status(checks, /Milano/)).toBe('SKIP');
  });
});

describe('exitCodeOf: a preview that fails the golden set is a failure; a run that writes is judged by whether it ran', () => {
  const base = { owners: 1, created: 0, named: 0, renamed: 0, unchanged: 0, dropped: 0, published: 0, watching: 0, goldenFailed: 0, failed: 0 };
  it('preview: 1 when a golden check failed or an owner failed', () => {
    expect(exitCodeOf({ ...base }, { apply: false, owner: null, all: false })).toBe(0);
    expect(exitCodeOf({ ...base, goldenFailed: 1 }, { apply: false, owner: null, all: false })).toBe(1);
    expect(exitCodeOf({ ...base, failed: 1 }, { apply: false, owner: null, all: false })).toBe(1);
  });

  it('--apply: the golden set is shown but does not turn a pass that wrote into a failure; an owner that failed does', () => {
    expect(exitCodeOf({ ...base, goldenFailed: 2 }, { apply: true, owner: null, all: false })).toBe(0);
    expect(exitCodeOf({ ...base, failed: 1 }, { apply: true, owner: null, all: false })).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the script, on the in-memory store
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

const NAMES: Record<string, string> = { wine: 'Vino', food: 'Ristoranti', home: 'Casa e design' };   // a test may add a name and takes it away

async function world(opts: { tiny?: boolean; late?: boolean; noHome?: boolean } = {}): Promise<{ store: MemoryCollectionsStore; deps: ScriptDeps; lines: string[]; engine: EngineDeps }> {
  const store = new MemoryCollectionsStore();
  const features = new Map<string, EntryFeatures>();
  const rand = rng(3);
  let clock = Date.UTC(2026, 0, 1);
  const add = async (id: string, vector: Float32Array, key: string): Promise<void> => {
    clock += 60_000;
    store.registerEntry({ id, ownerUser: 'mike', createdAt: new Date(clock).toISOString() });
    await store.saveVector(id, 'm', Array.from(vector), `h${id}`);
    features.set(id, feats({ text: `${key} post ${id}` }));
  };
  const dirs = [randomDir(rand), randomDir(rand), randomDir(rand), randomDir(rand), randomDir(rand)];
  for (const [k, [key, n]] of [['wine', 13], ['food', 7], ['home', opts.noHome ? 0 : 8], ['tiny', opts.tiny ? 3 : 0], ['late', opts.late ? 6 : 0]].entries()) {
    for (let i = 0; i < (n as number); i += 1) await add(`${key}${i}`, around(dirs[k], 0.3, rand), key as string);
  }
  for (let i = 0; i < 40; i += 1) await add(`noise${i}`, randomDir(rand), 'noise');
  for (let i = 0; i < 5; i += 1) await store.savePlacesAndVenues(`food${i}`, [{ name: 'Milano', kind: 'city' }], []);
  const engine: EngineDeps = {
    store,
    features: async (_u, wanted) => new Map(wanted.flatMap((id) => (features.has(id) ? [[id, features.get(id) as EntryFeatures] as const] : []))),
    nameGroup: async (g) => {
      const name = NAMES[g.members[0].text.split(' ')[0]];
      return name ? { name, group: seedGroupOf(name) } : null;
    },
    newId: (() => { let n = 0; return () => `c${++n}`; })(),
  };
  const lines: string[] = [];
  const deps: ScriptDeps = {
    engine,
    listOwners: async () => ['mike'],
    groundingText: async (id) => (features.get(id)?.text ?? 'Milano') + ' Milano',
    say: (line) => { lines.push(line); },
  };
  return { store, deps, lines, engine };
}

describe('rebuildCollectionsScript', () => {
  it('a preview writes NOTHING, lists what the pass would make and says it is a preview', async () => {
    const { store, deps, lines } = await world();
    const out = await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    expect(await store.listCollections('mike')).toEqual([]);
    const text = lines.join('\n');
    expect(text).toMatch(/ANTEPRIMA/);
    expect(text).not.toMatch(/SCRIVE/);
    expect(text).toMatch(/Vino/);
    expect(text).toMatch(/Ristoranti/);
    expect(text).toMatch(/Casa e design/);
    expect(out.owners).toBe(1);
    expect(out.created).toBeGreaterThanOrEqual(3);
    expect(out.published).toBe(3);
  });

  it('prints the golden set as PASS / FAIL / SKIP lines (the thresholds of the spec hold on this world)', async () => {
    const { deps, lines } = await world();
    const out = await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    const text = lines.join('\n');
    expect(text).toMatch(/PASS\s+Vino/);
    expect(text).toMatch(/PASS\s+Ristoranti a Milano/);
    expect(text).toMatch(/PASS\s+Casa e design/);
    expect(out.goldenFailed).toBe(0);
  });

  it('says what each collection is: new now, unchanged after a real pass', async () => {
    const { deps, lines } = await world();
    await rebuildCollectionsScript(deps, { apply: true, owner: null, all: false });
    lines.length = 0;
    const out = await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    expect(out.created).toBe(0);
    expect(out.unchanged).toBe(3);
    expect(lines.join('\n')).toMatch(/invariata/);
  });

  it('--apply writes the collections and says so; a second preview then agrees', async () => {
    const { store, deps, lines } = await world();
    const out = await rebuildCollectionsScript(deps, { apply: true, owner: null, all: false });
    expect((await store.listCollections('mike')).filter((c) => c.state === 'active').map((c) => c.name).sort()).toEqual(['Casa e design', 'Ristoranti', 'Vino']);
    expect(lines.join('\n')).toMatch(/SCRIVE/);
    expect(lines.join('\n')).not.toMatch(/ANTEPRIMA/);
    expect(out.published).toBe(3);
  });

  it('a group that is only «watching» is counted, and listed only with --all', async () => {
    const { deps, lines } = await world({ tiny: true });
    const quiet = await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    const quietText = lines.join('\n');
    lines.length = 0;
    await rebuildCollectionsScript(deps, { apply: false, owner: null, all: true });
    expect(quiet.watching).toBe(1);
    expect(quietText).not.toContain(UNNAMED);
    expect(quietText).toMatch(/1 in osservazione \(non elencate: --all\)/);
    expect(lines.join('\n')).toContain(UNNAMED);
  });

  it('a collection the user hid is listed as hidden (it is still there)', async () => {
    const { store, deps, lines } = await world();
    await rebuildCollectionsScript(deps, { apply: true, owner: null, all: false });
    const wine = (await store.listCollections('mike')).find((c) => c.name === 'Vino');
    await store.hide('mike', wine?.id as string);
    lines.length = 0;
    await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    expect(lines.join('\n')).toMatch(/nascosta\s+Vino/);
  });

  it('a collection the user hid is listed as hidden even when it is only «watching» (it is still there)', async () => {
    const { store, deps, lines } = await world({ tiny: true });
    await rebuildCollectionsScript(deps, { apply: true, owner: null, all: true });
    const small = (await store.listCollections('mike')).find((c) => c.state === 'watching');
    await store.hide('mike', small?.id as string);
    lines.length = 0;
    await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    expect(lines.join('\n')).toMatch(/nascosta\s+Senza nome/);
  });

  it('a collection that had no name and now has one is «nominata», not «rinominata» and not «invariata»; the summary counts it apart', async () => {
    const { deps, lines } = await world({ late: true });
    await rebuildCollectionsScript(deps, { apply: true, owner: null, all: true });
    NAMES.late = 'Giochi';
    try {
      lines.length = 0;
      const out = await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
      expect(lines.join('\n')).toMatch(/Giochi\s+\d+ voci\s+nominata/);
      expect(out).toMatchObject({ named: 1, renamed: 0, created: 0 });
      expect(lines.join('\n')).toMatch(/1 nominate, 0 rinominate/);
    } finally {
      delete NAMES.late;
    }
  });

  it('a collection whose subject changed has a new name: «rinominata (era …)», counted as renamed', async () => {
    const { store, deps, lines } = await world();
    const entries = (await store.vectorsOf('mike')).map((v) => v.entryId);
    const wine = entries.filter((id) => id.startsWith('wine'));
    const noise = entries.filter((id) => id.startsWith('noise'));
    await store.saveCollections('mike', [{ id: 'old', name: 'Vecchio nome', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: [wine[0], ...noise.slice(0, 11)].map((entryId) => ({ entryId, score: 0.7 })) }]);
    deps.engine.params = { ...COLLECTION_PARAMS, assignTau: -1 };           // the group HOLDS everybody, so it finds the old collection although it is another thing
    const out = await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    expect(lines.join('\n')).toMatch(/\d+ voci\s+rinominata \(era «Vecchio nome»\)/);
    expect(out.renamed).toBe(1);
  });

  it('what no group stands behind is counted as «da togliere»', async () => {
    const { store, deps, lines } = await world();
    await store.saveCollections('mike', [{ id: 'ghost', name: 'Fantasma', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: null, coherence: 0.7, members: ['noise0', 'noise1', 'noise2'].map((entryId) => ({ entryId, score: 0.7 })) }]);
    const out = await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    expect(out.dropped).toBe(1);
    expect(lines.join('\n')).toMatch(/1 da togliere/);
  });

  it('a golden check that fails is counted (a world with no «Casa e design» fails one)', async () => {
    const { deps, lines } = await world({ noHome: true });
    const out = await rebuildCollectionsScript(deps, { apply: false, owner: null, all: false });
    expect(out.goldenFailed).toBe(1);
    expect(lines.join('\n')).toMatch(/FAIL\s+Casa e design/);
  });

  it('one owner that fails is an ERRORE line and the others go on; the summary says how many failed', async () => {
    const { deps, lines } = await world();
    const failing: ScriptDeps = {
      ...deps,
      listOwners: async () => ['broken', 'mike'],
      engine: { ...deps.engine, features: async (user, wanted) => { if (user === 'broken') throw new Error('db down'); return deps.engine.features(user, wanted); } },
    };
    const out = await rebuildCollectionsScript(failing, { apply: false, owner: null, all: false });
    expect(lines.join('\n')).toMatch(/ERRORE.*db down/);
    expect(out.failed).toBe(1);
    expect(out.owners).toBe(2);
    expect(out.published).toBe(3);
  });

  it('--owner picks one user and does not read the list of owners', async () => {
    const { deps, lines } = await world();
    let listed = false;
    const out = await rebuildCollectionsScript({ ...deps, listOwners: async () => { listed = true; return ['mike', 'sara']; } }, { apply: false, owner: 'mike', all: false });
    expect(listed).toBe(false);
    expect(out.owners).toBe(1);
    expect(lines.join('\n')).toMatch(/mike/);
  });

  it('nobody with vectors: a line that says so, no crash', async () => {
    const { deps, lines } = await world();
    const out = await rebuildCollectionsScript({ ...deps, listOwners: async () => [] }, { apply: false, owner: null, all: false });
    expect(out.owners).toBe(0);
    expect(lines.join('\n')).toMatch(/nessun utente/);
  });
});
