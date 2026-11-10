/**
 * ONE contract for the two stores of the collections (ADR-0022): the in-memory one the engine tests use and the Postgres one the server uses
 * must behave the same, so the same tests run against both (`collectionsStore.test.ts` on the memory store, `collectionsStore.int.test.ts` on
 * Postgres behind `COLLECTIONS_INT=1`, like `autoPlaylistStore.int.test.ts`). A non-test file on purpose, because two test files import it;
 * it is only ever loaded by tests (precedent: `src/test/harness.ts`).
 *
 * Every id the contract uses starts with `ctest_`, so the Postgres world can clean up what it made and nothing else, even if somebody points
 * the test at the wrong database.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CollectionInput, CollectionsStore } from './collectionsStore';

export const MIKE = 'ctest_mike';
export const ARCHI = 'ctest_archi';
export const SARA = 'ctest_sara';
export const e = (n: number): string => `ctest_e${n}`;
export const c = (n: number): string => `ctest_c${n}`;
export const day = (n: number): string => `2026-01-${String(n).padStart(2, '0')}T10:00:00.000Z`;

/** The entries around the store: what the database has and the memory store has to be told. */
export interface ContractWorld {
  /** An empty world, and a store on it. */
  reset(): Promise<CollectionsStore>;
  addEntry(id: string, owner: string, createdAt: string): Promise<void>;
  share(entryId: string, withUser: string): Promise<void>;
  unshare(entryId: string, withUser: string): Promise<void>;
  deleteEntry(entryId: string): Promise<void>;
}

/** A collection as the engine hands it over: members with scores that a float32 holds exactly (1, .75, .5, .25, 0). */
export function input(id: string, entryIds: string[], extra: Partial<CollectionInput> = {}): CollectionInput {
  const scores = [1, 0.75, 0.5, 0.25, 0.125, 0.0625];
  return {
    id,
    name: `Name ${id}`,
    groupLabel: null,
    parentId: null,
    state: 'active',
    origin: 'found',
    centroid: new Float32Array([0.5, 0.25]),
    coherence: 0.75,
    members: entryIds.map((entryId, i) => ({ entryId, score: scores[i] ?? 0.03125 })),
    ...extra,
  };
}

export function describeCollectionsStoreContract(label: string, world: ContractWorld, options: { skip?: boolean } = {}): void {
  const suite = options.skip ? describe.skip : describe;

  suite(label, () => {
    let store: CollectionsStore;
    beforeEach(async () => {
      store = await world.reset();
    });

    /** Entries 1..n of Mike, one per day. */
    const mikeEntries = async (n: number): Promise<void> => {
      for (let i = 1; i <= n; i++) await world.addEntry(e(i), MIKE, day(i));
    };

    // ------------------------------------------------------------------ vectors
    describe('vectors', () => {
      it('round-trip as a Float32Array, with the date of the entry and the hash of the text', async () => {
        await world.addEntry(e(1), MIKE, day(3));
        expect(await store.saveVector(e(1), 'nomic-embed-text', [0.1, 0.2, -0.3], 'h1')).toBe(true);
        const got = await store.vectorsOf(MIKE);
        expect(got).toHaveLength(1);
        expect(got[0].entryId).toBe(e(1));
        expect(got[0].createdAt).toBe(day(3));
        expect(got[0].textHash).toBe('h1');
        expect(got[0].vector).toBeInstanceOf(Float32Array);
        expect(Array.from(got[0].vector)).toEqual(Array.from(Float32Array.from([0.1, 0.2, -0.3])));
      });

      it('are replaced only when the text (its hash) or the model changes', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        expect(await store.saveVector(e(1), 'm1', [1, 2], 'h1')).toBe(true);
        // the same text with the same model: nothing changes, not even when the numbers differ (no flicker between two passes)
        expect(await store.saveVector(e(1), 'm1', [9, 9], 'h1')).toBe(false);
        expect(Array.from((await store.vectorsOf(MIKE))[0].vector)).toEqual([1, 2]);
        // another text: replaced
        expect(await store.saveVector(e(1), 'm1', [3, 4], 'h2')).toBe(true);
        let [now] = await store.vectorsOf(MIKE);
        expect(Array.from(now.vector)).toEqual([3, 4]);
        expect(now.textHash).toBe('h2');
        // another model (vectors of two models cannot be compared): replaced
        expect(await store.saveVector(e(1), 'm2', [5, 6], 'h2')).toBe(true);
        [now] = await store.vectorsOf(MIKE);
        expect(Array.from(now.vector)).toEqual([5, 6]);
        expect(await store.vectorsOf(MIKE)).toHaveLength(1);
      });

      it('refuse a vector that is empty or has a value that is not a finite number, and store nothing', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        await expect(store.saveVector(e(1), 'm', [], 'h')).rejects.toThrow();
        await expect(store.saveVector(e(1), 'm', [1, Number.NaN], 'h')).rejects.toThrow();
        await expect(store.saveVector(e(1), 'm', [1, Number.POSITIVE_INFINITY], 'h')).rejects.toThrow();
        expect(await store.vectorsOf(MIKE)).toEqual([]);
      });

      it('come in the order of the dates of the entries (the grouping needs it), a tie by id', async () => {
        await world.addEntry(e(3), MIKE, day(5));
        await world.addEntry(e(1), MIKE, day(1));
        await world.addEntry(e(2), MIKE, day(3));
        await world.addEntry(e(4), MIKE, day(3));
        for (const n of [3, 1, 4, 2]) await store.saveVector(e(n), 'm', [n, n], `h${n}`);
        expect((await store.vectorsOf(MIKE)).map((v) => v.entryId)).toEqual([e(1), e(2), e(4), e(3)]);
      });

      it('give a user only the entries he can see: his own and those shared with him (the rule of GET /api/entries)', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        await world.addEntry(e(2), ARCHI, day(2));
        await world.addEntry(e(3), MIKE, day(3));
        await world.addEntry(e(4), SARA, day(4));
        await world.share(e(3), ARCHI);
        for (const n of [1, 2, 3, 4]) await store.saveVector(e(n), 'm', [n, 1], `h${n}`);
        expect((await store.vectorsOf(MIKE)).map((v) => v.entryId)).toEqual([e(1), e(3)]);
        expect((await store.vectorsOf(ARCHI)).map((v) => v.entryId)).toEqual([e(2), e(3)]);
        expect((await store.vectorsOf(SARA)).map((v) => v.entryId)).toEqual([e(4)]);
        expect(await store.vectorsOf('ctest_nobody')).toEqual([]);
      });

      it('go with their entry: deleting the entry deletes its vector', async () => {
        await mikeEntries(2);
        await store.saveVector(e(1), 'm', [1, 1], 'h1');
        await store.saveVector(e(2), 'm', [2, 2], 'h2');
        await world.deleteEntry(e(1));
        expect((await store.vectorsOf(MIKE)).map((v) => v.entryId)).toEqual([e(2)]);
        // the same id can come back as a new entry (a link analysed again): no old vector is waiting for it, the same text is embedded again
        await world.addEntry(e(1), MIKE, day(1));
        expect((await store.vectorsOf(MIKE)).map((v) => v.entryId)).toEqual([e(2)]);
        expect(await store.saveVector(e(1), 'm', [1, 1], 'h1')).toBe(true);
      });

      it('cannot be saved for an entry that does not exist', async () => {
        await expect(store.saveVector(e(99), 'm', [1, 1], 'h')).rejects.toThrow();
      });
    });

    // ------------------------------------------------------------------ places and venues
    describe('places and venues', () => {
      const venue = (name: string, key: string, place: string | null = 'Milano') => ({ name, kind: 'restaurant', place, key });

      it('are saved for an entry and read back by entry', async () => {
        await mikeEntries(2);
        await store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'city' }], [venue('Trattoria dei Navigli', 'trattoria dei navigli|milano'), venue('Bar Basso', 'bar basso|milano')]);
        await store.savePlacesAndVenues(e(2), [{ name: 'Piemonte', kind: 'region' }], []);
        expect(await store.placesOf([e(1), e(2)])).toEqual([
          { entryId: e(1), name: 'Milano', kind: 'city' },
          { entryId: e(2), name: 'Piemonte', kind: 'region' },
        ]);
        expect(await store.venuesOf([e(1), e(2)])).toEqual([
          { entryId: e(1), key: 'bar basso|milano', name: 'Bar Basso', kind: 'restaurant', place: 'Milano' },
          { entryId: e(1), key: 'trattoria dei navigli|milano', name: 'Trattoria dei Navigli', kind: 'restaurant', place: 'Milano' },
        ]);
        expect(await store.placesOf([e(2)])).toEqual([{ entryId: e(2), name: 'Piemonte', kind: 'region' }]);
        expect(await store.venuesOf([e(2)])).toEqual([]);
      });

      it('are replaced as a whole by a second save of the same entry (what the text no longer says goes away)', async () => {
        await mikeEntries(1);
        await store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'city' }], [venue('Bar Basso', 'bar basso|milano')]);
        await store.savePlacesAndVenues(e(1), [{ name: 'Roma', kind: 'city' }], []);
        expect(await store.placesOf([e(1)])).toEqual([{ entryId: e(1), name: 'Roma', kind: 'city' }]);
        expect(await store.venuesOf([e(1)])).toEqual([]);
        await store.savePlacesAndVenues(e(1), [], []);
        expect(await store.placesOf([e(1)])).toEqual([]);
      });

      it('keep a place once and a venue once (by key) when a save repeats them: the first wins', async () => {
        await mikeEntries(1);
        await store.savePlacesAndVenues(
          e(1),
          [{ name: 'Milano', kind: 'city' }, { name: 'Milano', kind: 'city' }],
          [venue('Bar Basso', 'bar basso|milano'), { name: 'BAR BASSO', kind: 'bar', place: 'Milano', key: 'bar basso|milano' }],
        );
        expect(await store.placesOf([e(1)])).toHaveLength(1);
        const venues = await store.venuesOf([e(1)]);
        expect(venues).toHaveLength(1);
        expect(venues[0].name).toBe('Bar Basso');
      });

      it('keep a venue with no city as «no city» (null), not as an empty text', async () => {
        await mikeEntries(1);
        await store.savePlacesAndVenues(e(1), [], [venue('Rifugio Auronzo', 'rifugio auronzo|', null)]);
        expect((await store.venuesOf([e(1)]))[0].place).toBeNull();
      });

      it('come in a fixed order: by entry, then by name', async () => {
        await mikeEntries(2);
        await store.savePlacesAndVenues(e(2), [{ name: 'Torino', kind: 'city' }, { name: 'Roma', kind: 'city' }], []);
        await store.savePlacesAndVenues(e(1), [{ name: 'Roma', kind: 'city' }, { name: 'Milano', kind: 'city' }, { name: 'Lombardia', kind: 'region' }], []);
        expect((await store.placesOf([e(2), e(1)])).map((p) => `${p.entryId}:${p.name}`)).toEqual([`${e(1)}:Lombardia`, `${e(1)}:Milano`, `${e(1)}:Roma`, `${e(2)}:Roma`, `${e(2)}:Torino`]);
      });

      it('are one row per entry: the same venue in two posts is two rows with the same key (the view makes one of them)', async () => {
        await mikeEntries(2);
        await store.savePlacesAndVenues(e(1), [], [venue('Bar Basso', 'bar basso|milano')]);
        await store.savePlacesAndVenues(e(2), [], [venue('Bar Basso', 'bar basso|milano')]);
        const rows = await store.venuesOf([e(1), e(2)]);
        expect(rows.map((v) => [v.entryId, v.key])).toEqual([[e(1), 'bar basso|milano'], [e(2), 'bar basso|milano']]);
      });

      it('reading no entries, or entries that have nothing, gives nothing', async () => {
        await mikeEntries(1);
        expect(await store.placesOf([])).toEqual([]);
        expect(await store.venuesOf([])).toEqual([]);
        expect(await store.placesOf([e(1), e(99)])).toEqual([]);
        expect(await store.venuesOf([e(1), e(99)])).toEqual([]);
      });

      it('refuse a kind of place that is not a city, a region or a country', async () => {
        await mikeEntries(1);
        await expect(store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'planet' }], [])).rejects.toThrow();
        expect(await store.placesOf([e(1)])).toEqual([]);
      });

      it('go with their entry: deleting the entry deletes its places and venues', async () => {
        await mikeEntries(2);
        for (const n of [1, 2]) await store.savePlacesAndVenues(e(n), [{ name: 'Milano', kind: 'city' }], [venue('Bar Basso', 'bar basso|milano')]);
        await world.deleteEntry(e(1));
        expect((await store.placesOf([e(1), e(2)])).map((p) => p.entryId)).toEqual([e(2)]);
        expect((await store.venuesOf([e(1), e(2)])).map((p) => p.entryId)).toEqual([e(2)]);
      });

      it('cannot be saved for an entry that does not exist', async () => {
        await expect(store.savePlacesAndVenues(e(99), [{ name: 'Milano', kind: 'city' }], [])).rejects.toThrow();
        await expect(store.savePlacesAndVenues(e(99), [], [])).rejects.toThrow();
      });
    });

    // ------------------------------------------------------------------ what was read, and when (the wiring of task 4 asks before it calls a model)
    describe('the record of what was read (input hashes)', () => {
      const venue = (name: string, key: string) => ({ name, kind: 'restaurant', place: 'Milano', key });

      it('is empty for an entry with nothing stored, and for no entries at all', async () => {
        await mikeEntries(1);
        expect((await store.inputHashes([e(1)])).size).toBe(0);
        expect((await store.inputHashes([])).size).toBe(0);
        expect((await store.inputHashes([e(99)])).size).toBe(0);
      });

      it('has the hash and the model of the vector, and no hash of places when none was read', async () => {
        await mikeEntries(1);
        await store.saveVector(e(1), 'nomic-embed-text', [1, 2], 'v1');
        expect((await store.inputHashes([e(1)])).get(e(1))).toEqual({ vectorHash: 'v1', model: 'nomic-embed-text', placesHash: null });
      });

      it('has the hash of the text the places were read from, and no vector when there is none', async () => {
        await mikeEntries(1);
        await store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'city' }], [venue('Bar Basso', 'bar basso|milano')], 'p1');
        expect((await store.inputHashes([e(1)])).get(e(1))).toEqual({ vectorHash: null, model: null, placesHash: 'p1' });
      });

      it('has both, for the entries asked about and only for them', async () => {
        await mikeEntries(3);
        await store.saveVector(e(1), 'm', [1, 1], 'v1');
        await store.savePlacesAndVenues(e(1), [], [], 'p1');
        await store.saveVector(e(2), 'm', [2, 2], 'v2');
        await store.savePlacesAndVenues(e(3), [], [], 'p3');
        const got = await store.inputHashes([e(1), e(2), e(99)]);
        expect([...got.keys()].sort()).toEqual([e(1), e(2)]);
        expect(got.get(e(1))).toEqual({ vectorHash: 'v1', model: 'm', placesHash: 'p1' });
        expect(got.get(e(2))).toEqual({ vectorHash: 'v2', model: 'm', placesHash: null });
      });

      it('remembers an entry that has NO place and no venue: a read that found nothing is a read (it is not asked again)', async () => {
        await mikeEntries(1);
        await store.savePlacesAndVenues(e(1), [], [], 'p1');
        expect(await store.placesOf([e(1)])).toEqual([]);
        expect(await store.venuesOf([e(1)])).toEqual([]);
        expect((await store.inputHashes([e(1)])).get(e(1))?.placesHash).toBe('p1');
      });

      it('changes with the text: a second save with another hash replaces the rows and the hash, the same hash again changes nothing but the time', async () => {
        await mikeEntries(1);
        await store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'city' }], [venue('Bar Basso', 'bar basso|milano')], 'p1');
        await store.savePlacesAndVenues(e(1), [{ name: 'Roma', kind: 'city' }], [], 'p2');
        expect(await store.placesOf([e(1)])).toEqual([{ entryId: e(1), name: 'Roma', kind: 'city' }]);
        expect(await store.venuesOf([e(1)])).toEqual([]);
        expect((await store.inputHashes([e(1)])).get(e(1))?.placesHash).toBe('p2');
        await store.savePlacesAndVenues(e(1), [{ name: 'Roma', kind: 'city' }], [], 'p2');
        expect((await store.inputHashes([e(1)])).get(e(1))?.placesHash).toBe('p2');
        expect(await store.placesOf([e(1)])).toHaveLength(1);
      });

      it('a save with no hash (the old way) writes the places and leaves the record of the reading as it was', async () => {
        await mikeEntries(2);
        await store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'city' }], [], 'p1');
        await store.savePlacesAndVenues(e(1), [{ name: 'Roma', kind: 'city' }], []);
        expect((await store.inputHashes([e(1)])).get(e(1))?.placesHash).toBe('p1');
        await store.savePlacesAndVenues(e(2), [{ name: 'Roma', kind: 'city' }], []);
        expect((await store.inputHashes([e(2)])).size).toBe(0);
      });

      it('is kept apart from the vector: a new vector does not touch the hash of the places, and the other way round', async () => {
        await mikeEntries(1);
        await store.saveVector(e(1), 'm', [1, 1], 'v1');
        await store.savePlacesAndVenues(e(1), [], [], 'p1');
        await store.saveVector(e(1), 'm2', [2, 2], 'v2');
        expect((await store.inputHashes([e(1)])).get(e(1))).toEqual({ vectorHash: 'v2', model: 'm2', placesHash: 'p1' });
        await store.savePlacesAndVenues(e(1), [], [], 'p2');
        expect((await store.inputHashes([e(1)])).get(e(1))).toEqual({ vectorHash: 'v2', model: 'm2', placesHash: 'p2' });
      });

      it('refuses an empty hash, and a save that fails leaves neither the rows nor the hash', async () => {
        await mikeEntries(1);
        await expect(store.savePlacesAndVenues(e(1), [], [], '')).rejects.toThrow();
        await expect(store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'planet' }], [], 'p1')).rejects.toThrow();
        await expect(store.savePlacesAndVenues(e(99), [], [], 'p1')).rejects.toThrow();
        expect(await store.placesOf([e(1)])).toEqual([]);
        expect((await store.inputHashes([e(1)])).size).toBe(0);
        // not even for the entry that does not exist: nothing is recorded for it
        expect((await store.inputHashes([e(99)])).size).toBe(0);
      });

      it('goes with its entry: deleting the entry deletes the record, and the same id coming back is read again', async () => {
        await mikeEntries(2);
        for (const n of [1, 2]) {
          await store.saveVector(e(n), 'm', [n, n], `v${n}`);
          await store.savePlacesAndVenues(e(n), [], [], `p${n}`);
        }
        await world.deleteEntry(e(1));
        await world.addEntry(e(1), MIKE, day(1));
        expect((await store.inputHashes([e(1), e(2)])).get(e(1))).toBeUndefined();
        expect((await store.inputHashes([e(1), e(2)])).get(e(2))?.placesHash).toBe('p2');
      });

      it('asks once for any number of entries and answers by entry id (a long list is not a problem)', async () => {
        await mikeEntries(1);
        await store.savePlacesAndVenues(e(1), [], [], 'p1');
        const many = Array.from({ length: 600 }, (_, i) => e(1000 + i));
        const got = await store.inputHashes([...many, e(1)]);
        expect([...got.keys()]).toEqual([e(1)]);
      });
    });

    // ------------------------------------------------------------------ collections
    describe('saving the collections', () => {
      it('stores the rows and their members, and reads them back with the size that the members give', async () => {
        await mikeEntries(5);
        await store.saveCollections(MIKE, [
          input(c(1), [e(1), e(2), e(3)], { name: 'Vino', groupLabel: 'Cibo e bevande', origin: 'seed' }),
          input(c(2), [e(4), e(5)], { state: 'watching', coherence: null, centroid: null }),
        ]);
        const list = await store.listCollections(MIKE);
        expect(list.map((r) => r.id)).toEqual([c(1), c(2)]);
        const [vino, watching] = list;
        expect(vino).toMatchObject({ ownerUser: MIKE, name: 'Vino', nameBy: 'auto', groupLabel: 'Cibo e bevande', parentId: null, state: 'active', origin: 'seed', size: 3, coherence: 0.75 });
        expect(vino.centroid).toBeInstanceOf(Float32Array);
        expect(Array.from(vino.centroid!)).toEqual([0.5, 0.25]);
        expect(typeof vino.createdAt).toBe('string');
        expect(typeof vino.updatedAt).toBe('string');
        expect(watching).toMatchObject({ state: 'watching', size: 2, coherence: null, centroid: null, groupLabel: null });
        expect(await store.membersOf(c(1))).toEqual([
          { entryId: e(1), score: 1, source: 'auto' },
          { entryId: e(2), score: 0.75, source: 'auto' },
          { entryId: e(3), score: 0.5, source: 'auto' },
        ]);
      });

      it('replaces the members of a collection it already has and keeps its creation date; the name of an automatic one follows', async () => {
        await mikeEntries(5);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3)], { name: 'Vino' })]);
        const before = (await store.listCollections(MIKE))[0];
        await store.saveCollections(MIKE, [input(c(1), [e(3), e(4), e(5)], { name: 'Vino e cantine' })]);
        const after = (await store.listCollections(MIKE))[0];
        expect(after.createdAt).toBe(before.createdAt);
        expect(after.updatedAt >= before.updatedAt).toBe(true);
        expect(after.name).toBe('Vino e cantine');
        expect(after.size).toBe(3);
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(3), e(4), e(5)]);
      });

      it('twice with the same data gives the same rows and members (no flicker between two passes)', async () => {
        await mikeEntries(4);
        const rows = [input(c(1), [e(1), e(2), e(3)], { name: 'Vino' }), input(c(2), [e(2), e(4)], { name: 'Casa', state: 'watching' })];
        await store.saveCollections(MIKE, rows);
        const first = { list: await store.listCollections(MIKE), m1: await store.membersOf(c(1)), m2: await store.membersOf(c(2)) };
        await store.saveCollections(MIKE, rows);
        const second = { list: await store.listCollections(MIKE), m1: await store.membersOf(c(1)), m2: await store.membersOf(c(2)) };
        const strip = (l: typeof first.list) => l.map(({ updatedAt: _u, ...rest }) => rest);
        expect(strip(second.list)).toEqual(strip(first.list));
        expect(second.m1).toEqual(first.m1);
        expect(second.m2).toEqual(first.m2);
      });

      it('deletes a collection that is not in the new set when nobody ever touched it (a dead group), with its members', async () => {
        await mikeEntries(4);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3)]), input(c(2), [e(2), e(4)])]);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3)])]);
        expect((await store.listCollections(MIKE)).map((r) => r.id)).toEqual([c(1)]);
        expect(await store.membersOf(c(2))).toEqual([]);
        await store.saveCollections(MIKE, []);
        expect(await store.listCollections(MIKE)).toEqual([]);
      });

      it('keeps a member only if the entry exists and the user can see it (an entry of another user, or one that does not exist, is dropped)', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        await world.addEntry(e(2), ARCHI, day(2));
        await world.addEntry(e(3), ARCHI, day(3));
        await world.share(e(3), MIKE);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3), e(99)])]);
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(3)]);
        expect((await store.listCollections(MIKE))[0].size).toBe(2);
      });

      it('keeps an entry once when a collection lists it twice (the best score)', async () => {
        await mikeEntries(2);
        await store.saveCollections(MIKE, [input(c(1), [], { members: [{ entryId: e(1), score: 0.75 }, { entryId: e(2), score: 0.5 }, { entryId: e(1), score: 0.25 }] })]);
        expect(await store.membersOf(c(1))).toEqual([
          { entryId: e(1), score: 0.75, source: 'auto' },
          { entryId: e(2), score: 0.5, source: 'auto' },
        ]);
      });

      it('gives a user only his own collections, and refuses a collection that is another user\'s', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        await world.addEntry(e(2), ARCHI, day(2));
        await store.saveCollections(MIKE, [input(c(1), [e(1)])]);
        await store.saveCollections(ARCHI, [input(c(2), [e(2)])]);
        expect((await store.listCollections(MIKE)).map((r) => r.id)).toEqual([c(1)]);
        expect((await store.listCollections(ARCHI)).map((r) => r.id)).toEqual([c(2)]);
        expect(await store.listCollections(SARA)).toEqual([]);
        await expect(store.saveCollections(ARCHI, [input(c(1), [e(2)])])).rejects.toThrow();
        // nothing of Mike's moved
        expect((await store.listCollections(MIKE)).map((r) => [r.id, r.name, r.ownerUser])).toEqual([[c(1), `Name ${c(1)}`, MIKE]]);
        expect((await store.membersOf(c(1))).map((m) => m.entryId)).toEqual([e(1)]);
        // saving the set of one user never touches the collections of another
        await store.saveCollections(ARCHI, []);
        expect((await store.listCollections(MIKE)).map((r) => r.id)).toEqual([c(1)]);
      });

      it('refuses a state that the engine does not decide (hidden, merged), a kind of origin it does not know, and an empty id or name', async () => {
        await mikeEntries(1);
        await expect(store.saveCollections(MIKE, [input(c(1), [e(1)], { state: 'hidden' as never })])).rejects.toThrow();
        await expect(store.saveCollections(MIKE, [input(c(1), [e(1)], { state: 'merged' as never })])).rejects.toThrow();
        await expect(store.saveCollections(MIKE, [input(c(1), [e(1)], { origin: 'invented' as never })])).rejects.toThrow();
        await expect(store.saveCollections(MIKE, [input('', [e(1)])])).rejects.toThrow();
        await expect(store.saveCollections(MIKE, [input(c(1), [e(1)], { name: '   ' })])).rejects.toThrow();
        await expect(store.saveCollections(MIKE, [input(c(1), [e(1)], { centroid: new Float32Array([Number.NaN]) })])).rejects.toThrow();
        expect(await store.listCollections(MIKE)).toEqual([]);
      });

      it('refuses a save that has the same collection twice', async () => {
        await mikeEntries(2);
        await expect(store.saveCollections(MIKE, [input(c(1), [e(1)]), input(c(1), [e(2)])])).rejects.toThrow();
        expect(await store.listCollections(MIKE)).toEqual([]);
      });

      it('a save that is refused changes nothing: what was there stays', async () => {
        await mikeEntries(3);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)], { name: 'Vino' })]);
        await expect(store.saveCollections(MIKE, [input(c(1), [e(3)], { name: 'Cambiato' }), input(c(2), [e(3)], { name: '' })])).rejects.toThrow();
        const [row] = await store.listCollections(MIKE);
        expect(row.name).toBe('Vino');
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(2)]);
      });

      it('lists the collections in the order they were created (a tie by id)', async () => {
        await mikeEntries(3);
        await store.saveCollections(MIKE, [input(c(2), [e(1)]), input(c(1), [e(2)]), input(c(3), [e(3)])]);
        const ids = (await store.listCollections(MIKE)).map((r) => r.id);
        expect([...ids].sort()).toEqual([c(1), c(2), c(3)]);
        await store.saveCollections(MIKE, [input(c(2), [e(1)]), input(c(1), [e(2)]), input(c(3), [e(3)]), input(c(0), [e(1)])]);
        const later = (await store.listCollections(MIKE)).map((r) => r.id);
        expect(later.slice(0, 3)).toEqual(ids);
        expect(later[3]).toBe(c(0));
      });

      it('has the size that the members have NOW: an entry that is deleted, or no longer visible, is not counted', async () => {
        await mikeEntries(4);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3), e(4)])]);
        await world.deleteEntry(e(2));
        expect((await store.listCollections(MIKE))[0].size).toBe(3);
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(3), e(4)]);
      });

      it('shows as members only the entries the OWNER can see: when an entry is no longer shared with him it drops out of the collection (and of its size)', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        await world.addEntry(e(2), ARCHI, day(2));
        await world.share(e(2), MIKE);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)])]);
        expect(await store.membersOf(c(1))).toHaveLength(2);
        await world.unshare(e(2), MIKE);
        expect((await store.membersOf(c(1))).map((m) => m.entryId)).toEqual([e(1)]);
        expect((await store.listCollections(MIKE))[0].size).toBe(1);
      });

      it('lets a child come before its parent in the same save, and refuses a parent that does not exist or is another user\'s', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        await world.addEntry(e(2), ARCHI, day(2));
        await store.saveCollections(MIKE, [input(c(2), [e(1)], { parentId: c(1), name: 'Figlio' }), input(c(1), [e(1)], { name: 'Padre' })]);
        const byId = Object.fromEntries((await store.listCollections(MIKE)).map((r) => [r.id, r]));
        expect(byId[c(2)].parentId).toBe(c(1));
        expect(byId[c(1)].parentId).toBeNull();
        await expect(store.saveCollections(MIKE, [input(c(3), [e(1)], { parentId: c(99) })])).rejects.toThrow();
        await store.saveCollections(ARCHI, [input(c(5), [e(2)])]);
        await expect(store.saveCollections(MIKE, [input(c(3), [e(1)], { parentId: c(5) })])).rejects.toThrow();
        expect((await store.listCollections(MIKE)).map((r) => r.id).sort()).toEqual([c(1), c(2)]);
        expect((await store.listCollections(ARCHI)).map((r) => r.id)).toEqual([c(5)]);
      });
    });

    // ------------------------------------------------------------------ corrections
    describe('the corrections of the user', () => {
      it('an entry taken out by hand (user_remove) does not come back with a later save, and is not counted', async () => {
        await mikeEntries(4);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3)])]);
        expect(await store.removeEntry(MIKE, c(1), e(2))).toBe(true);
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(3)]);
        expect((await store.listCollections(MIKE))[0].size).toBe(2);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3), e(4)])]);
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(3), e(4)]);
        expect((await store.corrections(MIKE)).removed).toEqual([{ collectionId: c(1), entryId: e(2) }]);
        expect((await store.listCollections(MIKE))[0].size).toBe(3);
      });

      it('an entry put in by hand (user_add) stays with a later save that does not have it, and stays one row when it has it', async () => {
        await mikeEntries(5);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)])]);
        expect(await store.addEntry(MIKE, c(1), e(5))).toBe(true);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(3)])]);
        expect(await store.membersOf(c(1))).toEqual(
          expect.arrayContaining([
            { entryId: e(5), score: 1, source: 'user_add' },
            { entryId: e(1), score: 1, source: 'auto' },
            { entryId: e(3), score: 0.75, source: 'auto' },
          ]),
        );
        expect(await store.membersOf(c(1))).toHaveLength(3);
        // now the automatic pass finds it too: still ONE row, still the user's
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(5)])]);
        const members = await store.membersOf(c(1));
        expect(members.filter((m) => m.entryId === e(5))).toEqual([{ entryId: e(5), score: 1, source: 'user_add' }]);
        expect((await store.corrections(MIKE)).added).toEqual([{ collectionId: c(1), entryId: e(5) }]);
      });

      it('putting back an entry that was taken out, and taking out one that was put in, change the correction (the last one wins)', async () => {
        await mikeEntries(2);
        await store.saveCollections(MIKE, [input(c(1), [e(1)])]);
        await store.removeEntry(MIKE, c(1), e(1));
        expect((await store.corrections(MIKE)).removed).toHaveLength(1);
        await store.addEntry(MIKE, c(1), e(1));
        let corr = await store.corrections(MIKE);
        expect(corr.removed).toEqual([]);
        expect(corr.added).toEqual([{ collectionId: c(1), entryId: e(1) }]);
        await store.removeEntry(MIKE, c(1), e(1));
        corr = await store.corrections(MIKE);
        expect(corr.added).toEqual([]);
        expect(corr.removed).toEqual([{ collectionId: c(1), entryId: e(1) }]);
        expect(await store.membersOf(c(1))).toEqual([]);
      });

      it('a collection hidden by the user stays hidden with every later save, until he shows it again', async () => {
        await mikeEntries(3);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3)])]);
        expect(await store.hide(MIKE, c(1))).toBe(true);
        expect((await store.listCollections(MIKE))[0].state).toBe('hidden');
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3)], { state: 'active' })]);
        expect((await store.listCollections(MIKE))[0].state).toBe('hidden');
        expect((await store.corrections(MIKE)).hidden).toEqual([c(1)]);
        expect(await store.unhide(MIKE, c(1))).toBe(true);
        expect((await store.listCollections(MIKE))[0].state).toBe('active');
        expect((await store.corrections(MIKE)).hidden).toEqual([]);
        // the automatic state decides again
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3)], { state: 'watching' })]);
        expect((await store.listCollections(MIKE))[0].state).toBe('watching');
      });

      it('a name given by the user is never changed by a later save, and an automatic one still follows', async () => {
        await mikeEntries(3);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)], { name: 'Vino' }), input(c(2), [e(3)], { name: 'Casa' })]);
        expect(await store.rename(MIKE, c(1), '  Vini rossi  ')).toBe(true);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)], { name: 'Vino e cantine' }), input(c(2), [e(3)], { name: 'Casa e design' })]);
        const [vino, casa] = await store.listCollections(MIKE);
        expect([vino.name, vino.nameBy]).toEqual(['Vini rossi', 'user']);
        expect([casa.name, casa.nameBy]).toEqual(['Casa e design', 'auto']);
        expect((await store.corrections(MIKE)).renamed).toEqual([{ id: c(1), name: 'Vini rossi' }]);
        await expect(store.rename(MIKE, c(1), '   ')).rejects.toThrow();
        expect((await store.listCollections(MIKE))[0].name).toBe('Vini rossi');
      });

      it('a merge hides the collection, puts its entries in the other one by hand and survives every later save', async () => {
        await mikeEntries(6);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(3)], { name: 'Vino' }), input(c(2), [e(3), e(4), e(5)], { name: 'Cantine' })]);
        expect(await store.merge(MIKE, c(2), c(1))).toBe(true);
        let [vino, cantine] = await store.listCollections(MIKE);
        expect(vino.state).toBe('active');
        expect(cantine).toMatchObject({ id: c(2), state: 'merged', parentId: c(1) });
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(2), e(3), e(4), e(5)]);
        expect((await store.corrections(MIKE)).merged).toEqual([{ id: c(2), into: c(1) }]);
        expect(vino.size).toBe(5);
        // the automatic pass, which still finds both groups, changes neither the merge nor the entries put in by it
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)], { name: 'Vino' }), input(c(2), [e(4), e(5), e(6)], { name: 'Cantine', parentId: null })]);
        [vino, cantine] = await store.listCollections(MIKE);
        expect(cantine).toMatchObject({ state: 'merged', parentId: c(1) });
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(2), e(3), e(4), e(5)]);
        // and the merged one is kept even when the automatic pass no longer finds its group
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)], { name: 'Vino' })]);
        expect((await store.listCollections(MIKE)).map((r) => [r.id, r.state])).toEqual([[c(1), 'active'], [c(2), 'merged']]);
      });

      it('a merge does not put back an entry that the user had taken out of the other collection', async () => {
        await mikeEntries(4);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)]), input(c(2), [e(2), e(3), e(4)])]);
        await store.removeEntry(MIKE, c(1), e(3));
        await store.merge(MIKE, c(2), c(1));
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(2), e(4)]);
      });

      it('a merge does not carry the entries the user had taken out of the collection that goes away', async () => {
        await mikeEntries(4);
        await store.saveCollections(MIKE, [input(c(1), [e(1)]), input(c(2), [e(2), e(3), e(4)])]);
        await store.removeEntry(MIKE, c(2), e(4));
        await store.merge(MIKE, c(2), c(1));
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(2), e(3)]);
        expect((await store.corrections(MIKE)).removed).toEqual([{ collectionId: c(2), entryId: e(4) }]);
      });

      it('a merged collection cannot be hidden, shown, or changed by hand: it is out of the way', async () => {
        await mikeEntries(3);
        await store.saveCollections(MIKE, [input(c(1), [e(1)]), input(c(2), [e(2)])]);
        await store.merge(MIKE, c(2), c(1));
        expect(await store.hide(MIKE, c(2))).toBe(false);
        expect(await store.unhide(MIKE, c(2))).toBe(false);
        expect(await store.addEntry(MIKE, c(2), e(3))).toBe(false);
        expect(await store.removeEntry(MIKE, c(2), e(2))).toBe(false);
        expect((await store.listCollections(MIKE)).find((r) => r.id === c(2))?.state).toBe('merged');
        expect((await store.corrections(MIKE)).added.filter((a) => a.collectionId === c(2))).toEqual([]);
        expect((await store.corrections(MIKE)).removed).toEqual([]);
      });

      it('refuses a merge into itself, into one already merged, of one already merged, and of what does not exist or is not his', async () => {
        await mikeEntries(3);
        await world.addEntry(e(10), ARCHI, day(10));
        await store.saveCollections(MIKE, [input(c(1), [e(1)]), input(c(2), [e(2)]), input(c(3), [e(3)])]);
        await store.saveCollections(ARCHI, [input(c(9), [e(10)])]);
        expect(await store.merge(MIKE, c(1), c(1))).toBe(false);
        expect(await store.merge(MIKE, c(1), c(99))).toBe(false);
        expect(await store.merge(MIKE, c(99), c(1))).toBe(false);
        expect(await store.merge(MIKE, c(1), c(9))).toBe(false);
        expect(await store.merge(MIKE, c(9), c(1))).toBe(false);
        expect(await store.merge(MIKE, c(2), c(1))).toBe(true);
        expect(await store.merge(MIKE, c(3), c(2))).toBe(false); // c2 is merged
        expect(await store.merge(MIKE, c(2), c(3))).toBe(false); // c2 is already merged
        const states = Object.fromEntries((await store.listCollections(MIKE)).map((r) => [r.id, r.state]));
        expect(states).toEqual({ [c(1)]: 'active', [c(2)]: 'merged', [c(3)]: 'active' });
        expect((await store.listCollections(ARCHI))[0].state).toBe('active');
      });

      it('a collection with corrections is kept when the automatic pass no longer finds its group (and is not shown: it is «watching»), a plain one is deleted', async () => {
        await mikeEntries(6);
        await store.saveCollections(MIKE, [
          input(c(1), [e(1), e(2)], { name: 'Vino' }),
          input(c(2), [e(2), e(3)], { name: 'Casa' }),
          input(c(3), [e(3), e(4)], { name: 'Viaggi' }),
          input(c(4), [e(4), e(5)], { name: 'Sport' }),
          input(c(5), [e(5), e(6)], { name: 'Foto' }),
        ]);
        await store.rename(MIKE, c(1), 'I miei vini'); // renamed
        await store.hide(MIKE, c(2)); // hidden
        await store.addEntry(MIKE, c(4), e(1)); // an entry put in by hand
        await store.removeEntry(MIKE, c(5), e(5)); // an entry taken out by hand
        // c3: nothing was touched
        await store.saveCollections(MIKE, []);
        const rows = await store.listCollections(MIKE);
        expect(rows.map((r) => r.id)).toEqual([c(1), c(2), c(4), c(5)]);
        const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
        expect([byId[c(1)].name, byId[c(1)].nameBy, byId[c(1)].state]).toEqual(['I miei vini', 'user', 'watching']);
        expect(byId[c(2)].state).toBe('hidden');
        // the automatic members go, the entries put in by hand stay
        expect(await store.membersOf(c(1))).toEqual([]);
        expect(await store.membersOf(c(4))).toEqual([{ entryId: e(1), score: 1, source: 'user_add' }]);
        expect(await store.membersOf(c(5))).toEqual([]);
        expect((await store.corrections(MIKE)).removed).toEqual([{ collectionId: c(5), entryId: e(5) }]);
        expect(byId[c(4)].size).toBe(1);
      });

      it('refuses every correction on a collection of another user, or that does not exist, and changes nothing', async () => {
        await mikeEntries(3);
        await world.addEntry(e(10), ARCHI, day(10));
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)], { name: 'Vino' }), input(c(2), [e(3)])]);
        expect(await store.rename(ARCHI, c(1), 'Mio')).toBe(false);
        expect(await store.hide(ARCHI, c(1))).toBe(false);
        expect(await store.unhide(ARCHI, c(1))).toBe(false);
        expect(await store.merge(ARCHI, c(2), c(1))).toBe(false);
        expect(await store.addEntry(ARCHI, c(1), e(10))).toBe(false);
        expect(await store.removeEntry(ARCHI, c(1), e(1))).toBe(false);
        expect(await store.rename(MIKE, c(99), 'Niente')).toBe(false);
        expect(await store.hide(MIKE, c(99))).toBe(false);
        expect(await store.addEntry(MIKE, c(99), e(1))).toBe(false);
        expect(await store.removeEntry(MIKE, c(99), e(1))).toBe(false);
        const [vino] = await store.listCollections(MIKE);
        expect(vino).toMatchObject({ name: 'Vino', nameBy: 'auto', state: 'active', size: 2 });
        expect(await store.corrections(MIKE)).toEqual({ renamed: [], hidden: [], merged: [], added: [], removed: [] });
        expect(await store.corrections(ARCHI)).toEqual({ renamed: [], hidden: [], merged: [], added: [], removed: [] });
      });

      it('an entry the user cannot see cannot be put in a collection, and one that does not exist cannot be taken out', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        await world.addEntry(e(2), ARCHI, day(2));
        await store.saveCollections(MIKE, [input(c(1), [e(1)])]);
        expect(await store.addEntry(MIKE, c(1), e(2))).toBe(false);
        expect(await store.addEntry(MIKE, c(1), e(99))).toBe(false);
        expect(await store.removeEntry(MIKE, c(1), e(99))).toBe(false);
        expect(await store.membersOf(c(1))).toEqual([{ entryId: e(1), score: 1, source: 'auto' }]);
        await world.share(e(2), MIKE);
        expect(await store.addEntry(MIKE, c(1), e(2))).toBe(true);
        expect((await store.membersOf(c(1))).map((m) => m.entryId).sort()).toEqual([e(1), e(2)]);
      });

      it('shows a user only his own corrections', async () => {
        await world.addEntry(e(1), MIKE, day(1));
        await world.addEntry(e(2), ARCHI, day(2));
        await store.saveCollections(MIKE, [input(c(1), [e(1)])]);
        await store.saveCollections(ARCHI, [input(c(2), [e(2)])]);
        await store.rename(MIKE, c(1), 'Del Mike');
        await store.hide(ARCHI, c(2));
        expect(await store.corrections(MIKE)).toEqual({ renamed: [{ id: c(1), name: 'Del Mike' }], hidden: [], merged: [], added: [], removed: [] });
        expect(await store.corrections(ARCHI)).toEqual({ renamed: [], hidden: [c(2)], merged: [], added: [], removed: [] });
      });

      it('go with the entry: deleting it removes it from the collections and from the corrections', async () => {
        await mikeEntries(3);
        await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)])]);
        await store.addEntry(MIKE, c(1), e(3));
        await store.removeEntry(MIKE, c(1), e(2));
        await world.deleteEntry(e(3));
        await world.deleteEntry(e(2));
        expect(await store.corrections(MIKE)).toEqual({ renamed: [], hidden: [], merged: [], added: [], removed: [] });
        expect((await store.membersOf(c(1))).map((m) => m.entryId)).toEqual([e(1)]);
      });
    });
  });
}
