import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryCollectionsStore } from './collectionsStore';
import { MIKE, ARCHI, c, day, e, describeCollectionsStoreContract, input, type ContractWorld } from './collectionsStoreContract';

// The in-memory store (the one the engine tests use) runs the SAME contract as the Postgres one (collectionsStore.int.test.ts, behind
// COLLECTIONS_INT=1). Here also the checks that need no database: the SQL of the migration and its mirror in init.sql.

let memory: MemoryCollectionsStore;
const world: ContractWorld = {
  async reset() {
    memory = new MemoryCollectionsStore({ strict: true });
    return memory;
  },
  async addEntry(id, owner, createdAt) {
    memory.registerEntry({ id, ownerUser: owner, createdAt });
  },
  async share(entryId, withUser) {
    memory.shareEntry(entryId, withUser);
  },
  async unshare(entryId, withUser) {
    memory.unshareEntry(entryId, withUser);
  },
  async deleteEntry(entryId) {
    memory.deleteEntry(entryId);
  },
};

describeCollectionsStoreContract('MemoryCollectionsStore: the contract of the stores', world);

describe('MemoryCollectionsStore: what is only for the tests of the engine', () => {
  it('by default knows an entry as soon as a vector is saved for it, and everybody can see it (no setup for a synthetic library)', async () => {
    const store = new MemoryCollectionsStore();
    await store.saveVector('a', 'm', [1, 0], 'h');
    await store.saveVector('b', 'm', [0, 1], 'h');
    expect((await store.vectorsOf('anyone')).map((v) => v.entryId)).toEqual(['a', 'b']);
    await store.saveCollections('anyone', [input('k1', ['a', 'b'])]);
    expect((await store.membersOf('k1')).map((m) => m.entryId).sort()).toEqual(['a', 'b']);
    // but an entry nobody ever saw is no entry
    await store.saveCollections('anyone', [input('k1', ['a', 'zzz'])]);
    expect((await store.membersOf('k1')).map((m) => m.entryId)).toEqual(['a']);
  });

  it('takes an injected «who sees what», like the visibility rule of the entries does in the database', async () => {
    const sees: Record<string, string[]> = { mike: ['a', 'b'], archi: ['b', 'c'] };
    const store = new MemoryCollectionsStore({ visibleEntryIds: (user) => sees[user] ?? [] });
    for (const id of ['a', 'b', 'c']) await store.saveVector(id, 'm', [1, 1], `h${id}`);
    expect((await store.vectorsOf('mike')).map((v) => v.entryId)).toEqual(['a', 'b']);
    expect((await store.vectorsOf('archi')).map((v) => v.entryId)).toEqual(['b', 'c']);
    expect(await store.vectorsOf('sara')).toEqual([]);
    await store.saveCollections('mike', [input('k1', ['a', 'b', 'c'])]);
    expect((await store.membersOf('k1')).map((m) => m.entryId).sort()).toEqual(['a', 'b']);
  });

  it('gives back copies: changing what was read does not change what is stored', async () => {
    const store = new MemoryCollectionsStore();
    await store.saveVector('a', 'm', [1, 2, 3], 'h');
    const [first] = await store.vectorsOf('x');
    first.vector[0] = 99;
    expect(Array.from((await store.vectorsOf('x'))[0].vector)).toEqual([1, 2, 3]);
    const input1 = [4, 5, 6];
    await store.saveVector('b', 'm', input1, 'h');
    input1[0] = -1;
    expect(Array.from((await store.vectorsOf('x'))[1].vector)).toEqual([4, 5, 6]);

    const centroid = new Float32Array([0.5, 0.5]);
    await store.saveCollections('x', [input('k1', ['a', 'b'], { centroid })]);
    centroid[0] = 7;
    const [row] = await store.listCollections('x');
    expect(Array.from(row.centroid!)).toEqual([0.5, 0.5]);
    row.centroid![1] = 9;
    expect(Array.from((await store.listCollections('x'))[0].centroid!)).toEqual([0.5, 0.5]);
  });

  it('has a clock that only goes forward: two saves in the same millisecond still order the collections as created', async () => {
    const frozen = new Date('2026-02-01T10:00:00.000Z');
    const store = new MemoryCollectionsStore({ strict: true, now: () => frozen });
    store.registerEntry({ id: e(1), ownerUser: MIKE, createdAt: day(1) });
    await store.saveCollections(MIKE, [input(c(2), [e(1)])]);
    await store.saveCollections(MIKE, [input(c(2), [e(1)]), input(c(1), [e(1)])]);
    expect((await store.listCollections(MIKE)).map((r) => r.id)).toEqual([c(2), c(1)]);
  });

  it('in strict mode behaves as the database does for an entry it does not know', async () => {
    const store = new MemoryCollectionsStore({ strict: true });
    await expect(store.saveVector(e(1), 'm', [1], 'h')).rejects.toThrow();
    store.registerEntry({ id: e(1), ownerUser: ARCHI });
    await expect(store.saveVector(e(1), 'm', [1], 'h')).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the SQL
const dbDir = path.join(__dirname, '..', 'db');
const migration = readFileSync(path.join(dbDir, 'migrations', '024_collections.sql'), 'utf8');
const initSql = readFileSync(path.join(dbDir, 'init.sql'), 'utf8');

/** The statements of an SQL text, without comments. */
const statements = (sql: string): string[] =>
  sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

describe('the SQL of the collections (migration 024 and its mirror in init.sql)', () => {
  it('is only idempotent statements: tables and indexes IF NOT EXISTS, nothing that drops or rewrites', () => {
    const all = statements(migration);
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const s of all) {
      expect(s, s).toMatch(/^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS) /);
    }
    expect(all.join(';')).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b|\bUPDATE \w+ SET\b|\bINSERT\b/i);
  });

  it('has the five tables of the spec and the record of what was read, with their columns, and nothing else', () => {
    const tables = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables).toEqual(['entry_vectors', 'entry_places', 'entry_venues', 'entry_place_runs', 'collections', 'collection_entries']);
    const body = (table: string): string => statements(migration).find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${table} `)) ?? '';
    const columnsOf = (table: string): string[] =>
      [...body(table).matchAll(/(?:\(\s*|,\s+)(\w+) (?:TEXT|REAL\[\]|REAL|INTEGER|TIMESTAMPTZ)\b/g)].map((m) => m[1]);
    expect(columnsOf('entry_vectors')).toEqual(['entry_id', 'model', 'vector', 'text_hash', 'embedded_at']);
    expect(columnsOf('entry_places')).toEqual(['entry_id', 'place', 'kind']);
    expect(columnsOf('entry_venues')).toEqual(['entry_id', 'venue_key', 'name', 'kind', 'place']);
    expect(columnsOf('entry_place_runs')).toEqual(['entry_id', 'text_hash', 'ran_at']);
    expect(columnsOf('collections')).toEqual([
      'id', 'owner_user', 'name', 'name_by', 'group_label', 'parent_id', 'state', 'origin', 'centroid', 'size', 'coherence', 'created_at', 'updated_at',
    ]);
    expect(columnsOf('collection_entries')).toEqual(['collection_id', 'entry_id', 'score', 'source']);
  });

  it('keys and cascades as the spec says: the vector, the places, the venues, the record of what was read and the memberships go with the entry', () => {
    expect(body('entry_vectors')).toMatch(/entry_id TEXT PRIMARY KEY REFERENCES entries\(id\) ON DELETE CASCADE/);
    expect(body('entry_vectors')).toMatch(/vector REAL\[\] NOT NULL/);
    expect(body('entry_places')).toMatch(/entry_id TEXT NOT NULL REFERENCES entries\(id\) ON DELETE CASCADE/);
    expect(body('entry_places')).toMatch(/PRIMARY KEY \(entry_id, place\)/);
    expect(body('entry_venues')).toMatch(/entry_id TEXT NOT NULL REFERENCES entries\(id\) ON DELETE CASCADE/);
    expect(body('entry_venues')).toMatch(/PRIMARY KEY \(entry_id, venue_key\)/);
    expect(body('entry_place_runs')).toMatch(/entry_id TEXT PRIMARY KEY REFERENCES entries\(id\) ON DELETE CASCADE/);
    expect(body('entry_place_runs')).toMatch(/text_hash TEXT NOT NULL/);
    expect(body('collections')).toMatch(/id TEXT PRIMARY KEY/);
    expect(body('collections')).toMatch(/centroid REAL\[\]/);
    expect(body('collection_entries')).toMatch(/collection_id TEXT NOT NULL REFERENCES collections\(id\) ON DELETE CASCADE/);
    expect(body('collection_entries')).toMatch(/entry_id TEXT NOT NULL REFERENCES entries\(id\) ON DELETE CASCADE/);
    expect(body('collection_entries')).toMatch(/PRIMARY KEY \(collection_id, entry_id\)/);
  });

  it('closes the sets of values the code relies on (kind of place, name_by, state, origin, source) with CHECKs', () => {
    expect(body('entry_places')).toMatch(/CHECK \(kind IN \('city', 'region', 'country'\)\)/);
    expect(body('collections')).toMatch(/CHECK \(name_by IN \('auto', 'user'\)\)/);
    expect(body('collections')).toMatch(/CHECK \(state IN \('watching', 'active', 'hidden', 'merged'\)\)/);
    expect(body('collections')).toMatch(/CHECK \(origin IN \('seed', 'found', 'manual'\)\)/);
    expect(body('collection_entries')).toMatch(/CHECK \(source IN \('auto', 'user_add', 'user_remove'\)\)/);
  });

  it('has no pgvector and no coordinates (ADR-0001, spec §4.3)', () => {
    expect(statements(migration).join(';')).not.toMatch(/\bvector\(|CREATE EXTENSION|\blatitude\b|\blongitude\b|\blat\b|\blon\b|\blng\b|geography|geometry/i);
  });

  it('is in init.sql too, verbatim (a database made from init.sql and one migrated by the runner are the same)', () => {
    expect(initSql.replace(/\r\n/g, '\n')).toContain(migration.replace(/\r\n/g, '\n').trim());
  });

  it('has an index for what is asked by something else than the key: places by name, venues by key, memberships by entry, collections by owner', () => {
    const idx = statements(migration).filter((s) => s.startsWith('CREATE INDEX') || s.startsWith('CREATE UNIQUE INDEX'));
    const text = idx.join('\n');
    expect(text).toMatch(/ON entry_places \(place\)/);
    expect(text).toMatch(/ON entry_venues \(venue_key\)/);
    expect(text).toMatch(/ON collection_entries \(entry_id\)/);
    expect(text).toMatch(/ON collections \(owner_user/);
  });

  function body(table: string): string {
    return statements(migration).find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${table} `)) ?? '';
  }
});
