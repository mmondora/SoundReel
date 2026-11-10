import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pool } from '../utils/db';
import { PgCollectionsStore } from './collectionsStore';
import { ARCHI, MIKE, c, day, e, describeCollectionsStoreContract, input, type ContractWorld } from './collectionsStoreContract';

// The Postgres store runs the same contract as the memory one (collectionsStore.test.ts), on a REAL database.
// Only behind COLLECTIONS_INT=1 and only on a scratch database (recipe of autoPlaylistStore.int.test.ts):
//
//   COLLECTIONS_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=collections_check DB_USER=postgres DB_PASSWORD=… \
//     npx vitest run --no-file-parallelism src/services/collectionsStore.int.test.ts
//
// The database must already have init.sql and the migrations (the scratch recipe: create it on `pg-scratch`, apply init.sql and every
// migration, then run this). Everything the tests make has an id that begins with `ctest_` and is removed by that prefix, and the test
// refuses the database that is called `soundreel`.

const on = process.env.COLLECTIONS_INT === '1';
if (on && (!process.env.DB_NAME || process.env.DB_NAME === 'soundreel')) {
  throw new Error('COLLECTIONS_INT=1 needs a scratch DB_NAME (never the real one)');
}
const d = on ? describe : describe.skip;

const pgWorld: ContractWorld = {
  async reset() {
    await pool.query("DELETE FROM collections WHERE owner_user LIKE 'ctest\\_%'");
    await pool.query("DELETE FROM entries WHERE id LIKE 'ctest\\_%'");
    return new PgCollectionsStore();
  },
  async addEntry(id, owner, createdAt) {
    await pool.query(
      `INSERT INTO entries (id, source_url, source_platform, input_channel, status, created_at, owner_user)
       VALUES ($1, $2, 'instagram', 'web', 'completed', $3, $4)`,
      [id, `https://example.test/${id}`, createdAt, owner],
    );
  },
  async share(entryId, withUser) {
    await pool.query(
      `INSERT INTO entry_shares (entry_id, shared_with, shared_by) VALUES ($1, $2, 'ctest_system') ON CONFLICT DO NOTHING`,
      [entryId, withUser],
    );
  },
  async unshare(entryId, withUser) {
    await pool.query('DELETE FROM entry_shares WHERE entry_id = $1 AND shared_with = $2', [entryId, withUser]);
  },
  async deleteEntry(entryId) {
    await pool.query('DELETE FROM entries WHERE id = $1', [entryId]);
  },
};

describeCollectionsStoreContract('PgCollectionsStore: the contract of the stores', pgWorld, { skip: !on });

d('the tables, on a real database', () => {
  afterAll(async () => {
    if (on) {
      await pool.query("DELETE FROM collections WHERE owner_user LIKE 'ctest\\_%'");
      await pool.query("DELETE FROM entries WHERE id LIKE 'ctest\\_%'");
    }
    await pool.end();
  });

  const migration = readFileSync(path.join(__dirname, '..', 'db', 'migrations', '024_collections.sql'), 'utf8');

  it('applies twice (the runner re-applies every migration at each boot) and makes the tables', async () => {
    const client = await pool.connect();
    const schema = `ctest_mig_${Date.now()}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query('CREATE TABLE entries (id TEXT PRIMARY KEY)');
      await client.query(migration);
      await client.query(migration);
      const { rows } = await client.query<{ table_name: string }>(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
        [schema],
      );
      expect(rows.map((r) => r.table_name)).toEqual(['collection_entries', 'collections', 'entries', 'entry_place_runs', 'entry_places', 'entry_vectors', 'entry_venues']);
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });

  it('keeps a vector as REAL[] (no pgvector) and the centroid too', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string; udt_name: string }>(
      `SELECT table_name, column_name, udt_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND ((table_name = 'entry_vectors' AND column_name = 'vector') OR (table_name = 'collections' AND column_name = 'centroid'))
       ORDER BY table_name`,
    );
    expect(rows.map((r) => [r.table_name, r.column_name, r.udt_name])).toEqual([
      ['collections', 'centroid', '_float4'],
      ['entry_vectors', 'vector', '_float4'],
    ]);
  });

  it('refuses a value the code does not know, even from outside the store (the CHECKs)', async () => {
    await pgWorld.reset();
    await expect(
      pool.query("INSERT INTO collections (id, owner_user, name, state) VALUES ('ctest_bad', 'ctest_mike', 'x', 'dancing')"),
    ).rejects.toThrow();
    await expect(
      pool.query("INSERT INTO collections (id, owner_user, name, name_by) VALUES ('ctest_bad', 'ctest_mike', 'x', 'robot')"),
    ).rejects.toThrow();
  });

  it('does not even STORE a member the user cannot see or that does not exist (the filter is in the INSERT, not only on the way out)', async () => {
    const store = await pgWorld.reset();
    await pgWorld.addEntry(e(1), MIKE, day(1));
    await pgWorld.addEntry(e(2), ARCHI, day(2));
    await store.saveCollections(MIKE, [input(c(1), [e(1), e(2), e(99)])]);
    const { rows } = await pool.query<{ entry_id: string }>('SELECT entry_id FROM collection_entries WHERE collection_id = $1 ORDER BY entry_id', [c(1)]);
    expect(rows.map((r) => r.entry_id)).toEqual([e(1)]);
    const stored = await pool.query<{ size: number }>('SELECT size FROM collections WHERE id = $1', [c(1)]);
    expect(stored.rows[0].size).toBe(1);
  });

  it('keeps the size column as the number of live members at the last change (a cache for the admin; the API counts live)', async () => {
    const store = await pgWorld.reset();
    for (let i = 1; i <= 3; i++) await pgWorld.addEntry(e(i), MIKE, day(i));
    await store.saveCollections(MIKE, [input(c(1), [e(1), e(2)])]);
    await store.addEntry(MIKE, c(1), e(3));
    await store.removeEntry(MIKE, c(1), e(1));
    const { rows } = await pool.query<{ size: number }>('SELECT size FROM collections WHERE id = $1', [c(1)]);
    expect(rows[0].size).toBe(2);
  });

  it('answers what was read for any number of entries with ONE query (no question per entry)', async () => {
    const store = await pgWorld.reset();
    for (let i = 1; i <= 3; i++) await pgWorld.addEntry(e(i), MIKE, day(i));
    await store.saveVector(e(1), 'm', [1, 1], 'v1');
    await store.savePlacesAndVenues(e(2), [], [], 'p2');
    const spy = vi.spyOn(pool, 'query');
    try {
      const got = await store.inputHashes([e(1), e(2), e(3), ...Array.from({ length: 300 }, (_, i) => e(500 + i))]);
      expect([...got.keys()].sort()).toEqual([e(1), e(2)]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('records what was read in the same transaction as the rows: a failed save leaves the hash of the reading before it', async () => {
    const store = await pgWorld.reset();
    await pgWorld.addEntry(e(1), MIKE, day(1));
    await store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'city' }], [], 'p1');
    // a venue with no key fails after the places were deleted: the transaction undoes everything, hash included
    await expect(store.savePlacesAndVenues(e(1), [{ name: 'Roma', kind: 'city' }], [{ key: '', name: 'x', kind: 'bar', place: null }], 'p2')).rejects.toThrow();
    expect(await store.placesOf([e(1)])).toEqual([{ entryId: e(1), name: 'Milano', kind: 'city' }]);
    expect((await store.inputHashes([e(1)])).get(e(1))?.placesHash).toBe('p1');
  });

  it('writes the rows and the record of the reading through ONE connection (the transaction): nothing goes through the pool on its own', async () => {
    const store = await pgWorld.reset();
    await pgWorld.addEntry(e(1), MIKE, day(1));
    const spy = vi.spyOn(pool, 'query');
    try {
      await store.savePlacesAndVenues(e(1), [{ name: 'Milano', kind: 'city' }], [], 'p1');
      expect(spy.mock.calls.filter((call) => /entry_place_runs|entry_places|entry_venues/.test(String(call[0])))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect((await store.inputHashes([e(1)])).get(e(1))?.placesHash).toBe('p1');
  });

  it('has an index to cascade the deletion of an entry quickly (membership by entry)', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'collection_entries'",
    );
    expect(rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(['idx_collection_entries_entry']));
  });
});
