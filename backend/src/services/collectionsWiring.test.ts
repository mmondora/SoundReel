import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbFlags = vi.hoisted(() => ({ broken: false }));
vi.mock('../utils/db', () => {
  const getEntryMock = vi.fn();
  return {
    // a test can make the real dependencies fail to build: the pipeline must still never reject
    get getEntry() {
      if (dbFlags.broken) throw new Error('the pool is gone');
      return getEntryMock;
    },
    pool: {},
    query: vi.fn(),
    withClient: vi.fn(),
  };
});
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));
vi.mock('./collectionsEngine', () => ({ assignOne: vi.fn(async () => ['c1']) }));
vi.mock('./collectionsEngineData', () => ({ realAssignOneDeps: vi.fn(() => ({ marker: 'the fast lane of the engine, with the database' })) }));

import { query } from '../utils/db';
import { logWarning } from '../utils/logger';
import { assignOne } from './collectionsEngine';
import {
  assignInRealCollections,
  catchUpInputs,
  collectionsAutoEnabled,
  onEntryAnalyzedForCollections,
  placesHashOf,
  placesSourceOf,
  planInputs,
  processEntryInputs,
  realCatchUpDeps,
  realInputsDeps,
  type CatchUpDeps,
  type InputsDeps,
} from './collectionsWiring';
import { MemoryCollectionsStore } from './collectionsStore';
import { EMBED_MODEL, embeddingTextHash, entryEmbeddingText } from './embeddings';
import { PLACES_RULES_VERSION, placesSourceText, venueKey, type ParsedPlacesAndVenues, type PlacesSource } from './entryPlaces';
import type { Entry } from '../types';

// What happens to an entry once its analysis is done (Raccolte, task 4; spec 2026-11-09-library-collections-auto-topics-design.md §5, ADR-0022): a
// vector (`nomic-embed-text` on the local router) and the places and venues its text names (one call to the local model). Nothing here touches a
// database or a model: the store is the in-memory one and the two calls are spies.

interface EntryParts {
  id?: string;
  caption?: string | null;
  summary?: string | null;
  tags?: string[];
  notes?: string[];
  transcript?: string | null;
  transcription?: string | null;
  overlayText?: string | null;
  slideOcr?: string[];
}

const SUMMARY = 'Tre trattorie a Milano che non conosci: Trattoria Da Gigi, Bar Luce e Osteria del Borgo.';

function entry(parts: EntryParts = {}): Entry {
  return {
    id: parts.id ?? 'e1',
    sourceUrl: 'https://www.instagram.com/reel/x',
    sourcePlatform: 'instagram',
    inputChannel: 'telegram',
    inputUser: null,
    ownerUser: 'mike',
    caption: parts.caption ?? null,
    thumbnailUrl: null,
    mediaUrl: null,
    status: 'completed',
    results: {
      songs: [],
      films: [],
      notes: (parts.notes ?? []).map((text) => ({ text, category: 'other' })),
      links: [],
      tags: parts.tags ?? [],
      summary: parts.summary === undefined ? SUMMARY : parts.summary,
      transcript: parts.transcript ?? null,
      transcription: parts.transcription ?? null,
      overlayText: parts.overlayText ?? null,
      slides: parts.slideOcr?.map((ocrText, index) => ({ index, imageUrl: null, ocrText, visualDescription: null, summary: null, links: [] })),
    },
    actionLog: [],
    createdAt: '2026-11-05T10:00:00.000Z',
  } as unknown as Entry;
}

const MILAN: ParsedPlacesAndVenues = {
  place: { name: 'Milano', kind: 'city' },
  venues: [{ name: 'Bar Luce', kind: 'bar', place: 'Milano', key: venueKey('Bar Luce', 'Milano') }],
};
const NOTHING: ParsedPlacesAndVenues = { place: null, venues: [] };

/** A world with these entries, an in-memory store, and spies for the two calls to the local models. */
function world(entries: Entry[], over: Partial<InputsDeps> = {}) {
  const store = new MemoryCollectionsStore();
  const embed = vi.fn(async (texts: string[]) => texts.map((_, i) => [i + 1, 0.5]));
  const places = vi.fn<(source: PlacesSource) => Promise<ParsedPlacesAndVenues | null>>(async () => MILAN);
  const deps: InputsDeps = {
    store,
    getEntry: async (id) => entries.find((e) => e.id === id) ?? null,
    embed,
    places,
    ...over,
  };
  return { store, embed, places, deps };
}

const recorded = async (store: MemoryCollectionsStore, id = 'e1') => (await store.inputHashes([id])).get(id);

beforeEach(() => {
  vi.clearAllMocks();
  dbFlags.broken = false;
  delete process.env.COLLECTIONS_AUTO;
});
afterEach(() => {
  delete process.env.COLLECTIONS_AUTO;
  vi.useRealTimers();
});

describe('the text of an entry as the two steps read it', () => {
  it('maps the entry to what the places call reads: caption, summary, tags, notes, the words of the video and the text on the screen', () => {
    const source = placesSourceOf(entry({ caption: 'cap', summary: 'sum', tags: ['#milano'], notes: ['una nota', 'due note'], transcript: 'parlato', overlayText: 'a schermo' }));
    expect(source).toEqual({ caption: 'cap', summary: 'sum', tags: ['#milano'], notes: ['una nota', 'due note'], transcript: 'parlato', ocr: 'a schermo' });
  });

  it('takes the transcription when there is no transcript, and adds the text of the slides of a carousel to the text on the screen', () => {
    const source = placesSourceOf(entry({ transcript: null, transcription: 'dalla trascrizione', overlayText: 'titolo', slideOcr: ['slide uno', 'slide due'] }));
    expect(source.transcript).toBe('dalla trascrizione');
    expect(source.ocr).toBe('titolo\nslide uno\nslide due');
    expect(placesSourceOf(entry({ transcript: 'primo', transcription: 'secondo' })).transcript).toBe('primo');
  });

  it('keeps only the notes that say something: an empty one, a blank one and a note with no text are left out', () => {
    const e = entry({ notes: ['', 'una nota', '   '] });
    (e.results.notes as unknown as Array<{ text?: string }>).push({}, { text: 'e un\'altra' });
    expect(placesSourceOf(e).notes).toEqual(['una nota', 'e un\'altra']);
  });

  it('has no text on the screen when there is none (not an empty line)', () => {
    expect(placesSourceOf(entry({ overlayText: null })).ocr).toBeNull();
    expect(placesSourceOf(entry({ overlayText: '  ', slideOcr: ['', '  '] })).ocr).toBeNull();
  });

  it('copes with an entry that has no notes, tags or slides at all', () => {
    const bare = { id: 'x', caption: null, results: { summary: 'una frase abbastanza lunga da contare' } } as unknown as Entry;
    expect(placesSourceOf(bare)).toEqual({ caption: null, summary: 'una frase abbastanza lunga da contare', tags: [], notes: [], transcript: null, ocr: null });
  });
});

describe('planInputs: what an entry still needs (one rule, for the pipeline and for the backfill)', () => {
  const e1 = entry();
  const text = entryEmbeddingText({ caption: null, results: { summary: SUMMARY, tags: [] } }) as string;
  const placesText = placesSourceText(placesSourceOf(e1));
  /** The hash a reading of these places is recorded with: the text AND the version of the rules (`PLACES_RULES_VERSION`). */
  const placesHash = embeddingTextHash(`${placesText}|v${PLACES_RULES_VERSION}`);

  it('needs both when nothing was ever read', () => {
    const plan = planInputs(e1, undefined);
    expect(plan.vector).toEqual({ text, hash: embeddingTextHash(text) });
    expect(plan.places?.hash).toBe(placesHash);
    expect(plan.needsVector).toBe(true);
    expect(plan.needsPlaces).toBe(true);
  });

  it('needs nothing when both were read from this very text with this very model', () => {
    const plan = planInputs(e1, { vectorHash: embeddingTextHash(text), model: EMBED_MODEL, placesHash });
    expect(plan.needsVector).toBe(false);
    expect(plan.needsPlaces).toBe(false);
  });

  it('needs a new vector when the text changed or when the model did, and new places when their text changed', () => {
    const base = { vectorHash: embeddingTextHash(text), model: EMBED_MODEL, placesHash };
    expect(planInputs(e1, { ...base, vectorHash: 'old' })).toMatchObject({ needsVector: true, needsPlaces: false });
    expect(planInputs(e1, { ...base, model: 'another-model' })).toMatchObject({ needsVector: true, needsPlaces: false });
    expect(planInputs(e1, { ...base, placesHash: 'old' })).toMatchObject({ needsVector: false, needsPlaces: true });
    expect(planInputs(e1, { ...base, model: null })).toMatchObject({ needsVector: true });
  });

  it('the hash of the places is the text AND the version of the rules: a reading made by the rules of before (the plain hash of the text) is read again, the vector is not', () => {
    const base = { vectorHash: embeddingTextHash(text), model: EMBED_MODEL, placesHash };
    expect(placesHashOf(placesText)).toBe(placesHash);
    expect(placesHash).not.toBe(embeddingTextHash(placesText));
    expect(planInputs(e1, { ...base, placesHash: embeddingTextHash(placesText) })).toMatchObject({ needsVector: false, needsPlaces: true });
    expect(planInputs(e1, { ...base, placesHash: embeddingTextHash(`${placesText}|v${PLACES_RULES_VERSION - 1}`) })).toMatchObject({ needsPlaces: true });
    expect(planInputs(e1, { ...base, placesHash: embeddingTextHash(`${placesText}|v${PLACES_RULES_VERSION + 1}`) })).toMatchObject({ needsPlaces: true });
    expect(planInputs(e1, base)).toMatchObject({ needsPlaces: false });
  });

  it('the hash still follows the text: another text, another hash, the same version', () => {
    expect(placesHashOf('una frase abbastanza lunga da contare')).not.toBe(placesHashOf('un\'altra frase abbastanza lunga da contare'));
    expect(placesHashOf('una frase abbastanza lunga da contare')).toBe(placesHashOf('una frase abbastanza lunga da contare'));
  });

  it('has no vector to make and no places to read when the entry says too little (under 25 characters): neither step is worth a model', () => {
    const little = planInputs(entry({ summary: 'poco', caption: null }), undefined);
    expect(little.vector).toBeNull();
    expect(little.places).toBeNull();
    expect(little.needsVector).toBe(false);
    expect(little.needsPlaces).toBe(false);
    const nothing = planInputs(entry({ summary: null, caption: null }), undefined);
    expect(nothing.vector).toBeNull();
    expect(nothing.places).toBeNull();
  });

  it('reads the places from a text of 25 characters and not from one of 24 (the same floor as the vector)', () => {
    const at = (n: number) => planInputs(entry({ summary: null, caption: null, transcript: 'x'.repeat(n) }), undefined);
    expect(at(24).places).toBeNull();
    expect(at(25).places).not.toBeNull();
  });
});

describe('processEntryInputs: the vector, and the places and venues, of one entry', () => {
  it('an entry that says too little (nothing at all to read) is «no_text»: nothing stored, no model asked', async () => {
    const { deps, store, embed, places } = world([entry({ summary: 'ciao', caption: null })]);
    expect(await processEntryInputs('e1', deps)).toBe('no_text');
    expect(embed).not.toHaveBeenCalled();
    expect(places).not.toHaveBeenCalled();
    expect((await store.inputHashes(['e1'])).size).toBe(0);
  });

  it('an entry that is no longer there is «no_text» too (there is nothing to read)', async () => {
    const { deps, embed, places } = world([]);
    expect(await processEntryInputs('gone', deps)).toBe('no_text');
    expect(embed).not.toHaveBeenCalled();
    expect(places).not.toHaveBeenCalled();
  });

  it('makes the vector with the model and the hash of the text, and reads the places once: «done»', async () => {
    const e = entry({ tags: ['#milano', '#tag'] });
    const { deps, store, embed, places } = world([e]);
    expect(await processEntryInputs('e1', deps)).toBe('done');
    const text = entryEmbeddingText({ caption: e.caption, results: { summary: e.results.summary, tags: e.results.tags } }) as string;
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith([text]);
    expect(places).toHaveBeenCalledTimes(1);
    expect(places.mock.calls[0][0]).toEqual(placesSourceOf(e));
    const [vector] = await store.vectorsOf('mike');
    expect(vector).toMatchObject({ entryId: 'e1', textHash: embeddingTextHash(text) });
    expect(Array.from(vector.vector)).toEqual([1, 0.5]);
    expect(await store.placesOf(['e1'])).toEqual([{ entryId: 'e1', name: 'Milano', kind: 'city' }]);
    expect((await store.venuesOf(['e1'])).map((v) => v.name)).toEqual(['Bar Luce']);
    expect(await recorded(store)).toEqual({ vectorHash: embeddingTextHash(text), model: EMBED_MODEL, placesHash: placesHashOf(placesSourceText(placesSourceOf(e))) });
  });

  it('asks for the vector with the model of the embeddings (the prefix and the batch are the embedding module\'s own business)', async () => {
    const { deps, store } = world([entry()]);
    await processEntryInputs('e1', deps);
    expect((await recorded(store))?.model).toBe('nomic-embed-text');
  });

  it('the same entry again asks nobody: the vector and the places are already there', async () => {
    const { deps, embed, places } = world([entry()]);
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(embed).toHaveBeenCalledTimes(1);
    expect(places).toHaveBeenCalledTimes(1);
  });

  it('a text that changed is read again: the vector is made again and what the text no longer says goes away', async () => {
    const first = entry();
    let current = first;
    const { deps, store, embed, places } = world([], { getEntry: async () => current });
    places.mockResolvedValueOnce(MILAN).mockResolvedValueOnce({ place: { name: 'Roma', kind: 'city' }, venues: [] });
    await processEntryInputs('e1', deps);
    current = entry({ summary: 'Ora il post parla di tutt\'altro: due trattorie a Roma, vicino al Colosseo.' });
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(embed).toHaveBeenCalledTimes(2);
    expect(places).toHaveBeenCalledTimes(2);
    expect(await store.placesOf(['e1'])).toEqual([{ entryId: 'e1', name: 'Roma', kind: 'city' }]);
    expect(await store.venuesOf(['e1'])).toEqual([]);
  });

  it('only the places are read again when only the text they read changed (a transcript arrived): the vector is not made again', async () => {
    let current = entry();
    const { deps, embed, places } = world([], { getEntry: async () => current });
    await processEntryInputs('e1', deps);
    current = entry({ transcript: 'ecco i ristoranti di Milano che consiglio, in ordine' });
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(embed).toHaveBeenCalledTimes(1);
    expect(places).toHaveBeenCalledTimes(2);
  });

  it('a vector of another model is made again, even for the same text (two models cannot be compared)', async () => {
    const { deps, store, embed } = world([entry()]);
    const text = entryEmbeddingText({ caption: null, results: { summary: SUMMARY, tags: [] } }) as string;
    await store.saveVector('e1', 'an-older-model', [9, 9], embeddingTextHash(text));
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(embed).toHaveBeenCalledTimes(1);
    expect((await recorded(store))?.model).toBe(EMBED_MODEL);
  });

  it('an entry with no place and no venue is remembered: a reading that found nothing is a reading, nobody asks again', async () => {
    const { deps, store, places } = world([entry()]);
    places.mockResolvedValue(NOTHING);
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(places).toHaveBeenCalledTimes(1);
    expect(await store.placesOf(['e1'])).toEqual([]);
    expect((await recorded(store))?.placesHash).not.toBeNull();
  });

  it('a places call that gave nothing back (the model is down, the answer was cut) leaves no record: «pending», and only the places are asked again', async () => {
    const { deps, store, embed, places } = world([entry()]);
    places.mockResolvedValueOnce(null);
    expect(await processEntryInputs('e1', deps)).toBe('pending');
    expect((await recorded(store))?.vectorHash).not.toBeNull();
    expect((await recorded(store))?.placesHash).toBeNull();
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('places of an entry were not read'), expect.objectContaining({ entryId: 'e1' }));
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(embed).toHaveBeenCalledTimes(1);
    expect(places).toHaveBeenCalledTimes(2);
    expect(await store.placesOf(['e1'])).toHaveLength(1);
  });

  it('the embedding service being down is «pending», it throws nothing, and the places are still read', async () => {
    const { deps, store, places } = world([entry()], { embed: async () => { throw new Error('router asleep'); } });
    expect(await processEntryInputs('e1', deps)).toBe('pending');
    expect(places).toHaveBeenCalledTimes(1);
    expect((await recorded(store))?.vectorHash).toBeNull();
    expect((await recorded(store))?.placesHash).not.toBeNull();
    expect(logWarning).toHaveBeenCalled();
  });

  it('a bad answer of the embedding service (no vector, a vector that is not numbers) is «pending» too, and nothing is stored for it', async () => {
    const empty = world([entry()], { embed: async () => [] });
    expect(await processEntryInputs('e1', empty.deps)).toBe('pending');
    expect((await recorded(empty.store))?.vectorHash).toBeNull();
    const nan = world([entry()], { embed: async () => [[Number.NaN, 1]] });
    expect(await processEntryInputs('e1', nan.deps)).toBe('pending');
    expect(await nan.store.vectorsOf('mike')).toEqual([]);
  });

  it('an answer with more vectors than texts is not a vector for this entry: «pending», nothing stored (never a shifted result)', async () => {
    const { deps, store } = world([entry()], { embed: async () => [[1, 1], [2, 2]] });
    expect(await processEntryInputs('e1', deps)).toBe('pending');
    expect(await store.vectorsOf('mike')).toEqual([]);
  });

  it('says what was wrong with an answer that has no vector (not only that the store refused something)', async () => {
    const { deps } = world([entry()], { embed: async () => [] });
    await processEntryInputs('e1', deps);
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('vector of an entry was not made'), expect.objectContaining({ error: 'the embedding service gave no vector' }));
  });

  it('the places call throwing is «pending», and the vector is kept', async () => {
    const { deps, store } = world([entry()]);
    deps.places = async () => { throw new Error('boom'); };
    expect(await processEntryInputs('e1', deps)).toBe('pending');
    expect((await recorded(store))?.vectorHash).not.toBeNull();
    expect((await recorded(store))?.placesHash).toBeNull();
  });

  it('a store that fails on the vector does not keep the places from being saved, and the other way round', async () => {
    const a = world([entry()]);
    a.deps.store = { saveVector: async () => { throw new Error('db down'); }, savePlacesAndVenues: a.store.savePlacesAndVenues.bind(a.store), inputHashes: a.store.inputHashes.bind(a.store) };
    expect(await processEntryInputs('e1', a.deps)).toBe('pending');
    expect((await recorded(a.store))?.placesHash).not.toBeNull();
    const b = world([entry()]);
    b.deps.store = { saveVector: b.store.saveVector.bind(b.store), savePlacesAndVenues: async () => { throw new Error('db down'); }, inputHashes: b.store.inputHashes.bind(b.store) };
    expect(await processEntryInputs('e1', b.deps)).toBe('pending');
    expect((await recorded(b.store))?.vectorHash).not.toBeNull();
  });

  it('never throws, whatever fails: the database that cannot read the entry or what was read before is «pending»', async () => {
    const noEntry = world([], { getEntry: async () => { throw new Error('db down'); } });
    await expect(processEntryInputs('e1', noEntry.deps)).resolves.toBe('pending');
    const noHashes = world([entry()]);
    noHashes.deps.store = { saveVector: noHashes.store.saveVector.bind(noHashes.store), savePlacesAndVenues: noHashes.store.savePlacesAndVenues.bind(noHashes.store), inputHashes: async () => { throw new Error('db down'); } };
    await expect(processEntryInputs('e1', noHashes.deps)).resolves.toBe('pending');
    expect(noHashes.embed).not.toHaveBeenCalled();
  });

  it('the two steps do not wait for each other: an entry with too little for a vector but a long transcript still has its places read («done», no vector)', async () => {
    const e = entry({ summary: 'poco', caption: null, transcript: 'consiglio la trattoria Da Gigi di Milano, in zona Navigli, per una cena' });
    const { deps, store, embed, places } = world([e]);
    expect(await processEntryInputs('e1', deps)).toBe('done');
    expect(embed).not.toHaveBeenCalled();
    expect(places).toHaveBeenCalledTimes(1);
    expect(await store.vectorsOf('mike')).toEqual([]);
    expect((await recorded(store))?.placesHash).not.toBeNull();
  });
});

describe('the kill switch', () => {
  it('COLLECTIONS_AUTO=0 stops everything, and anything else leaves it on', () => {
    expect(collectionsAutoEnabled()).toBe(true);
    process.env.COLLECTIONS_AUTO = '1';
    expect(collectionsAutoEnabled()).toBe(true);
    process.env.COLLECTIONS_AUTO = '0';
    expect(collectionsAutoEnabled()).toBe(false);
  });

  it('with the switch «off» nothing is even read', async () => {
    process.env.COLLECTIONS_AUTO = '0';
    const getEntry = vi.fn();
    const { deps } = world([], { getEntry });
    await expect(onEntryAnalyzedForCollections('e1', deps)).resolves.toBeUndefined();
    expect(getEntry).not.toHaveBeenCalled();
  });
});

describe('onEntryAnalyzedForCollections: when an analysis ends well', () => {
  it('reads the entry and stores what it finds', async () => {
    const { deps, store } = world([entry()]);
    await onEntryAnalyzedForCollections('e1', deps);
    expect((await recorded(store))?.vectorHash).not.toBeNull();
    expect(await store.placesOf(['e1'])).toHaveLength(1);
  });

  it('never rejects, even when everything fails (the analysis is done anyway) and says so in the log', async () => {
    const { deps } = world([], { getEntry: () => { throw new Error('sync boom'); } });
    await expect(onEntryAnalyzedForCollections('e1', deps)).resolves.toBeUndefined();
    const second = world([], { getEntry: async () => { throw new Error('async boom'); } });
    await expect(onEntryAnalyzedForCollections('e1', second.deps)).resolves.toBeUndefined();
    expect(logWarning).toHaveBeenCalled();
  });

  it('never rejects even when the real dependencies cannot be built (the pool is gone): the analysis is done anyway, and the log says so', async () => {
    dbFlags.broken = true;
    await expect(onEntryAnalyzedForCollections('e1')).resolves.toBeUndefined();
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('inputs of an entry failed'), expect.objectContaining({ entryId: 'e1', error: 'the pool is gone' }));
    dbFlags.broken = false;
    const fine = world([entry({ id: 'e2' })]);
    await onEntryAnalyzedForCollections('e2', fine.deps);          // and the chain is not broken for the next one
    expect((await recorded(fine.store, 'e2'))?.vectorHash).not.toBeNull();
  });

  it('a failure does not stop the next entry: the chain goes on', async () => {
    const broken = world([], { getEntry: async () => { throw new Error('boom'); } });
    const fine = world([entry({ id: 'e2' })]);
    await onEntryAnalyzedForCollections('e1', broken.deps);
    await onEntryAnalyzedForCollections('e2', fine.deps);
    expect((await recorded(fine.store, 'e2'))?.vectorHash).not.toBeNull();
  });

  it('two entries that end together never overlap: the second waits for the first to be finished', async () => {
    let running = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const slow = async (texts: string[]): Promise<number[][]> => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return texts.map(() => [1, 1]);
    };
    const { deps } = world([entry({ id: 'e1' }), entry({ id: 'e2' })], { embed: slow });
    const first = onEntryAnalyzedForCollections('e1', deps);
    const second = onEntryAnalyzedForCollections('e2', deps);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(running).toBe(1);
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(most).toBe(1);
    releases[1]();
    await Promise.all([first, second]);
    expect(most).toBe(1);
  });
});

describe('onEntryAnalyzedForCollections: the new entry joins the collections it is close to (the fast lane of the engine, spec §5.2)', () => {
  const owned = (id: string, ownerUser: string): Entry => ({ ...entry({ id }), ownerUser }) as Entry;
  const placer = () => vi.fn<(userId: string, entryId: string) => Promise<string[]>>(async () => ['c1']);

  it('once the vector is stored it is placed, for the owner of the entry (the vector was there before the fast lane was asked)', async () => {
    const { deps, store } = world([owned('e1', 'sara')]);
    const stored: boolean[] = [];
    const assign = vi.fn(async (userId: string, entryId: string) => {
      stored.push((await store.vectorsOf(userId)).some((v) => v.entryId === entryId));
      return [];
    });
    await onEntryAnalyzedForCollections('e1', deps, assign);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('sara', 'e1');
    expect(stored).toEqual([true]);
  });

  it('an entry that was already read is placed all the same (a new analysis of it leaves nothing to read: «done»)', async () => {
    const { deps } = world([entry()]);
    const assign = placer();
    await onEntryAnalyzedForCollections('e1', deps, assign);
    await onEntryAnalyzedForCollections('e1', deps, assign);
    expect(assign).toHaveBeenCalledTimes(2);
  });

  it('it is not placed while its inputs are not all there: the router is down («pending»), or the entry says too little («no_text»)', async () => {
    const assign = placer();
    const down = world([entry()], { embed: async () => { throw new Error('router down'); } });
    await onEntryAnalyzedForCollections('e1', down.deps, assign);
    const little = world([entry({ id: 'e2', summary: 'Poco', caption: null, tags: [] })]);
    await onEntryAnalyzedForCollections('e2', little.deps, assign);
    const gone = world([]);
    await onEntryAnalyzedForCollections('e3', gone.deps, assign);
    expect(assign).not.toHaveBeenCalled();
  });

  it('an entry of nobody («anonymous», or no owner at all) or one that is no longer there is not placed, and nothing is logged for it', async () => {
    const assign = placer();
    for (const ownerUser of ['anonymous', '']) {
      const { deps } = world([owned('e1', ownerUser)]);
      await onEntryAnalyzedForCollections('e1', deps, assign);
    }
    const base = world([entry()]);
    let reads = 0;
    const vanishing: InputsDeps = { ...base.deps, getEntry: async (id) => (reads++ === 0 ? entry({ id }) : null) };   // there for the inputs, gone for the owner
    await onEntryAnalyzedForCollections('e1', vanishing, assign);
    expect(assign).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('a fast lane that fails is a warning and nothing more: the entry stays read, the promise does not reject and the next entry goes on', async () => {
    const { deps, store } = world([entry()]);
    const assign = vi.fn(async () => { throw new Error('store down'); });
    await expect(onEntryAnalyzedForCollections('e1', deps, assign)).resolves.toBeUndefined();
    expect(logWarning).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('could not join the collections'), expect.objectContaining({ entryId: 'e1', error: 'store down' }));
    expect((await recorded(store))?.vectorHash).not.toBeNull();
    const next = world([entry({ id: 'e2' })]);
    const fine = placer();
    await onEntryAnalyzedForCollections('e2', next.deps, fine);
    expect(fine).toHaveBeenCalledWith('mike', 'e2');
  });

  it('the next entry waits for it: the fast lane is part of the turn of the entry (one at a time), not something left running', async () => {
    const { deps } = world([entry({ id: 'e1' }), entry({ id: 'e2' })]);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const slow = vi.fn(async (_user: string, id: string) => {
      order.push(`start ${id}`);
      if (id === 'e1') await new Promise<void>((resolve) => { release = resolve; });
      order.push(`end ${id}`);
      return [];
    });
    const first = onEntryAnalyzedForCollections('e1', deps, slow);
    const second = onEntryAnalyzedForCollections('e2', deps, slow);
    await vi.waitFor(() => expect(order).toEqual(['start e1']));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start e1', 'end e1', 'start e2', 'end e2']);
  });

  it('the switch «off» places nothing', async () => {
    process.env.COLLECTIONS_AUTO = '0';
    const { deps } = world([entry()]);
    const assign = placer();
    await onEntryAnalyzedForCollections('e1', deps, assign);
    expect(assign).not.toHaveBeenCalled();
  });

  it('by default the fast lane is the real one of the engine, with its own database dependencies (the engine is only loaded when an entry has been read)', async () => {
    vi.mocked(assignOne).mockClear();
    const { deps } = world([entry()]);
    await onEntryAnalyzedForCollections('e1', deps);
    expect(assignOne).toHaveBeenCalledTimes(1);
    expect(assignOne).toHaveBeenCalledWith('mike', 'e1', { marker: 'the fast lane of the engine, with the database' });
    expect(await assignInRealCollections('sara', 'e9')).toEqual(['c1']);
    expect(assignOne).toHaveBeenLastCalledWith('sara', 'e9', { marker: 'the fast lane of the engine, with the database' });
  });
});

describe('the real dependencies of the whole-library run', () => {
  it('list the entries newest first, of one owner or of all (the owner is a parameter of the query, never part of its text)', async () => {
    vi.mocked(query).mockResolvedValue([{ id: 'b' }, { id: 'a' }] as never);
    const real = realCatchUpDeps();
    expect(await real.listEntryIds('mike')).toEqual(['b', 'a']);
    expect(await real.listEntryIds(null)).toEqual(['b', 'a']);
    const [text, params] = vi.mocked(query).mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toMatch(/FROM entries/);
    expect(text).toMatch(/owner_user = \$1/);
    expect(text).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual(['mike']);
    expect((vi.mocked(query).mock.calls[1] as unknown as [string, unknown[]])[1]).toEqual([null]);
  });

  it('wait for the time asked, and tell what they are told to', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    const real = realCatchUpDeps((line) => said.push(line));
    let done = false;
    const waiting = real.sleep(100).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
    real.say?.('hello');
    expect(said).toEqual(['hello']);
  });
});

describe('the real dependencies', () => {
  it('importing the module and building the dependencies touches no database and no model (they are made when they are needed)', () => {
    const real = realInputsDeps();
    expect(typeof real.getEntry).toBe('function');
    expect(typeof real.embed).toBe('function');
    expect(typeof real.places).toBe('function');
    expect(typeof real.store.saveVector).toBe('function');
    expect(query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------- catch up: the backfill and the nightly pass

describe('catchUpInputs: every entry that still needs a vector or its places', () => {
  const sleeps: number[] = [];
  function catchUp(entries: Entry[], over: Partial<CatchUpDeps> = {}) {
    const w = world(entries);
    const lines: string[] = [];
    const deps: CatchUpDeps = {
      ...w.deps,
      listEntryIds: async (owner) => entries.filter((e) => owner === null || e.ownerUser === owner).map((e) => e.id),
      sleep: async (ms) => { sleeps.push(ms); },
      say: (line) => lines.push(line),
      ...over,
    };
    return { ...w, deps, lines };
  }
  beforeEach(() => { sleeps.length = 0; });

  const many = (n: number): Entry[] => Array.from({ length: n }, (_, i) => entry({ id: `e${i + 1}`, summary: `${SUMMARY} (numero ${i + 1})` }));

  it('a dry run counts what is missing and calls no model and writes nothing', async () => {
    const { deps, embed, places, store } = catchUp([...many(3), entry({ id: 'short', summary: 'poco' })]);
    const summary = await catchUpInputs(deps, { apply: false });
    expect(summary).toMatchObject({ scanned: 4, needAny: 3, needVector: 3, needPlaces: 3, upToDate: 0, noText: 1, done: 0, pending: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect(places).not.toHaveBeenCalled();
    expect((await store.inputHashes(['e1', 'e2', 'e3'])).size).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it('an apply run does the work, one entry at a time, and a second run finds nothing left to do', async () => {
    const { deps, embed, places } = catchUp(many(3));
    const first = await catchUpInputs(deps, { apply: true, delayMs: 5 });
    expect(first).toMatchObject({ scanned: 3, needVector: 3, needPlaces: 3, done: 3, pending: 0 });
    expect(embed).toHaveBeenCalledTimes(3);
    expect(places).toHaveBeenCalledTimes(3);
    const second = await catchUpInputs(deps, { apply: true, delayMs: 5 });
    expect(second).toMatchObject({ scanned: 3, needVector: 0, needPlaces: 0, upToDate: 3, done: 0 });
    expect(embed).toHaveBeenCalledTimes(3);
    expect(places).toHaveBeenCalledTimes(3);
  });

  it('resumes where it stopped: an entry whose hashes already match is skipped, one that needs only the places gets only the places', async () => {
    const entries = many(3);
    const { deps, store, embed, places } = catchUp(entries);
    await processEntryInputs('e1', deps);                                   // e1 is complete
    const text = entryEmbeddingText({ caption: null, results: { summary: entries[1].results.summary, tags: [] } }) as string;
    await store.saveVector('e2', EMBED_MODEL, [1, 1], embeddingTextHash(text));   // e2 has its vector only
    embed.mockClear();
    places.mockClear();
    const summary = await catchUpInputs(deps, { apply: true, delayMs: 0 });
    expect(summary).toMatchObject({ scanned: 3, upToDate: 1, needAny: 2, needVector: 1, needPlaces: 2, done: 2 });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(places).toHaveBeenCalledTimes(2);
  });

  it('waits a little between the entries it asks a model about (not before the first, not after the last), and for none that needs nothing', async () => {
    const { deps } = catchUp(many(4));
    await processEntryInputs('e1', deps);
    sleeps.length = 0;
    await catchUpInputs(deps, { apply: true, delayMs: 250 });
    expect(sleeps).toEqual([250, 250]);
  });

  it('does not wait at all in a dry run, and not when the delay is zero', async () => {
    const dry = catchUp(many(3));
    await catchUpInputs(dry.deps, { apply: false, delayMs: 250 });
    expect(sleeps).toEqual([]);
    const fast = catchUp(many(3));
    await catchUpInputs(fast.deps, { apply: true, delayMs: 0 });
    expect(sleeps).toEqual([]);
  });

  it('stops after the number of entries asked for (those that need something), the newest first', async () => {
    const { deps, embed } = catchUp(many(5));
    const summary = await catchUpInputs(deps, { apply: true, delayMs: 0, limit: 2 });
    expect(summary.done).toBe(2);
    expect(embed).toHaveBeenCalledTimes(2);
    const dry = await catchUpInputs(catchUp(many(5)).deps, { apply: false, limit: 2 });
    expect(dry.needVector).toBe(2);
  });

  it('stops looking once the limit is reached: no more questions to the store, no more entries read', async () => {
    const w = catchUp(many(6));
    const spy = vi.spyOn(w.store, 'inputHashes');
    const read = vi.fn(w.deps.getEntry);
    w.deps.getEntry = read;
    const summary = await catchUpInputs(w.deps, { apply: false, limit: 2, chunk: 2 });
    expect(summary).toMatchObject({ scanned: 2, needAny: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('counts for the limit the entries that need something, not the ones that are done or have no text', async () => {
    const entries = [entry({ id: 'short', summary: 'poco' }), ...many(4)];
    const w = catchUp(entries);
    await processEntryInputs('e1', w.deps);
    const summary = await catchUpInputs(w.deps, { apply: false, limit: 2 });
    expect(summary).toMatchObject({ scanned: 4, noText: 1, upToDate: 1, needAny: 2 });
  });

  it('only the entries of one user when asked', async () => {
    const mine = [entry({ id: 'm1' }), entry({ id: 'm2', summary: `${SUMMARY} bis` })];
    const others = { ...entry({ id: 'a1', summary: `${SUMMARY} ter` }), ownerUser: 'archi' } as Entry;
    const { deps } = catchUp([...mine, others]);
    const summary = await catchUpInputs(deps, { apply: false, owner: 'archi' });
    expect(summary.scanned).toBe(1);
  });

  it('an entry that fails does not stop the run: it is counted «pending» (the next run asks again) and the rest goes on', async () => {
    const entries = many(3);
    const { deps, embed } = catchUp(entries);
    embed.mockImplementation(async (texts: string[]) => {
      if (texts[0].includes('numero 2')) throw new Error('router asleep');
      return texts.map(() => [1, 1]);
    });
    const summary = await catchUpInputs(deps, { apply: true, delayMs: 0 });
    expect(summary).toMatchObject({ scanned: 3, done: 2, pending: 1 });
    expect(embed).toHaveBeenCalledTimes(3);
  });

  it('a stretch whose records cannot be asked is counted «pending» (and told in the log), and the run goes on with the next stretch', async () => {
    const w = catchUp(many(4));
    const real = w.store.inputHashes.bind(w.store);
    let asked = 0;
    w.deps.store = {
      saveVector: w.store.saveVector.bind(w.store),
      savePlacesAndVenues: w.store.savePlacesAndVenues.bind(w.store),
      inputHashes: async (ids: string[]) => {
        asked += 1;
        if (asked === 1) throw new Error('db hiccup');
        return real(ids);
      },
    };
    const summary = await catchUpInputs(w.deps, { apply: true, delayMs: 0, chunk: 2 });
    expect(summary).toMatchObject({ scanned: 4, pending: 2, done: 2 });
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('could not be asked'), expect.objectContaining({ error: 'db hiccup' }));
  });

  it('an entry that cannot even be read is counted «pending» and does not stop the run', async () => {
    const entries = many(2);
    const { deps } = catchUp(entries, { getEntry: async (id) => { if (id === 'e1') throw new Error('db hiccup'); return entries.find((e) => e.id === id) ?? null; } });
    const summary = await catchUpInputs(deps, { apply: true, delayMs: 0 });
    expect(summary).toMatchObject({ scanned: 2, done: 1, pending: 1 });
  });

  it('a chunk of zero (or less) still looks at every entry (it is one entry at a time, never a loop that does not move)', async () => {
    const w = catchUp(many(3));
    const summary = await catchUpInputs(w.deps, { apply: false, chunk: 0 });
    expect(summary.scanned).toBe(3);
    expect((await catchUpInputs(catchUp(many(3)).deps, { apply: false, chunk: -5 })).scanned).toBe(3);
  });

  it('reads what was recorded in chunks, not one entry at a time', async () => {
    const entries = many(7);
    const w = catchUp(entries);
    const spy = vi.spyOn(w.store, 'inputHashes');
    await catchUpInputs(w.deps, { apply: false, chunk: 3 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((c) => c[0].length)).toEqual([3, 3, 1]);
  });

  it('says how it goes: a line every 25 entries it worked on, and one for each entry that has to be tried again', async () => {
    const { deps, lines, embed } = catchUp(many(26));
    embed.mockImplementation(async (texts: string[]) => {
      if (texts[0].includes('numero 3)')) throw new Error('router asleep');
      return texts.map(() => [1, 1]);
    });
    await catchUpInputs(deps, { apply: true, delayMs: 0 });
    expect(lines.filter((l) => l.includes('e3:'))).toHaveLength(1);
    expect(lines.filter((l) => /^ {2}25 voci fatte \(1 da riprovare\), 25 guardate su 26$/.test(l))).toHaveLength(1);
    expect(lines).toHaveLength(2);
  });

  it('says nothing in a dry run (the script prints the totals)', async () => {
    const { deps, lines } = catchUp(many(30));
    await catchUpInputs(deps, { apply: false });
    expect(lines).toEqual([]);
  });

  it('works without anyone listening (no `say`)', async () => {
    const { deps } = catchUp(many(2), { say: undefined });
    await expect(catchUpInputs(deps, { apply: true, delayMs: 0 })).resolves.toMatchObject({ done: 2 });
  });
});
