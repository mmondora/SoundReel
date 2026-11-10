import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../utils/db';
import { PgCollectionsStore } from './collectionsStore';
import { seedGroupOf, type NamingGroup } from './collectionsNaming';
import { UNNAMED, assignOne, consolidate, rebuildPreview, type EngineDeps } from './collectionsEngine';
import { addAutoMembers, entryFeatures, hasCollections, listOwners, realAssignOneDeps } from './collectionsEngineData';

// The real SQL of the engine on a REAL database, and the engine on the Postgres store (the same passes the unit tests run on the in-memory one).
// Only behind COLLECTIONS_INT=1 and only on a scratch database (recipe of collectionsStore.int.test.ts):
//
//   COLLECTIONS_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=collections_check DB_USER=postgres DB_PASSWORD=… \
//     npx vitest run --no-file-parallelism src/services/collectionsEngineData.int.test.ts
//
// Everything the tests make has an id that begins with `ctest_` (users too) and is removed by that prefix; the test refuses the database called `soundreel`.

const on = process.env.COLLECTIONS_INT === '1';
if (on && (!process.env.DB_NAME || process.env.DB_NAME === 'soundreel')) {
  throw new Error('COLLECTIONS_INT=1 needs a scratch DB_NAME (never the real one)');
}
const d = on ? describe : describe.skip;

const MIKE = 'ctest_eng_mike';
const SARA = 'ctest_eng_sara';
const ANON = 'anonymous';

async function wipe(): Promise<void> {
  await pool.query("DELETE FROM collections WHERE owner_user LIKE 'ctest\\_%'");
  await pool.query("DELETE FROM entries WHERE id LIKE 'ctest\\_%'");
}

async function addEntry(id: string, owner: string, results: Record<string, unknown>, caption: string | null = null, createdAt = '2026-01-01T10:00:00Z'): Promise<void> {
  await pool.query(
    `INSERT INTO entries (id, source_url, source_platform, input_channel, status, created_at, owner_user, caption, results)
     VALUES ($1, $2, 'instagram', 'web', 'completed', $3, $4, $5, $6::jsonb)`,
    [id, `https://example.test/${id}`, createdAt, owner, caption, JSON.stringify(results)],
  );
}

d('the engine on a real database', () => {
  const store = new PgCollectionsStore();
  beforeAll(wipe);
  afterAll(async () => {
    if (on) await wipe();
    await pool.end();
  });

  describe('entryFeatures', () => {
    it('reads the text (the summary, else the caption, else nothing), the tags, and the two flags; the audio fingerprint is not a song of the content', async () => {
      await wipe();
      await addEntry('ctest_f1', MIKE, { summary: 'Un post sul vino', tags: ['#vino', '#cantina'], songs: [{ title: 'a', source: 'ai_analysis' }], films: [] });
      await addEntry('ctest_f2', MIKE, { summary: '  ', tags: [], songs: [{ title: 'b', source: 'audio_fingerprint' }], films: [{ title: 'Dune' }] }, 'La didascalia');
      await addEntry('ctest_f3', MIKE, { summary: null });                         // an entry that has no lists at all (the database does not let a list be anything else)
      await addEntry('ctest_f4', MIKE, { songs: [{ source: 'music_list' }, { source: 'both' }] });
      await addEntry('ctest_f5', MIKE, { summary: ' Il riassunto ', tags: [] }, 'La didascalia');        // both: the summary wins, trimmed
      const out = await entryFeatures(MIKE, ['ctest_f1', 'ctest_f2', 'ctest_f3', 'ctest_f4', 'ctest_f5', 'ctest_missing']);
      expect(out.get('ctest_f1')).toEqual({ text: 'Un post sul vino', tags: ['#vino', '#cantina'], hasContentSongs: true, hasFilms: false });
      expect(out.get('ctest_f2')).toEqual({ text: 'La didascalia', tags: [], hasContentSongs: false, hasFilms: true });
      expect(out.get('ctest_f3')).toEqual({ text: '', tags: [], hasContentSongs: false, hasFilms: false });
      expect(out.get('ctest_f4')?.hasContentSongs).toBe(true);
      expect(out.get('ctest_f5')?.text).toBe('Il riassunto');
      expect(out.has('ctest_missing')).toBe(false);
    });
  });

  describe('hasCollections', () => {
    it('is true for an owner who has a collection in ANY state (a hidden one too: he has been through the first publication), false for one who has none, and never mixes two owners up', async () => {
      await wipe();
      expect(await hasCollections(MIKE)).toBe(false);
      await pool.query("INSERT INTO collections (id, owner_user, name, state) VALUES ('ctest_hc1', $1, 'Nascosta', 'hidden')", [MIKE]);
      expect(await hasCollections(MIKE)).toBe(true);
      expect(await hasCollections(SARA)).toBe(false);
      await pool.query("INSERT INTO collections (id, owner_user, name, state) VALUES ('ctest_hc2', $1, 'In osservazione', 'watching')", [SARA]);
      expect(await hasCollections(SARA)).toBe(true);
    });
  });

  describe('listOwners', () => {
    it('are the owners that have a vector and the users it is shared with, never «anonymous»', async () => {
      await wipe();
      await addEntry('ctest_o1', MIKE, {});
      await addEntry('ctest_o2', SARA, {});
      await addEntry('ctest_o3', ANON, {});
      await addEntry('ctest_o4', 'ctest_eng_nobody', {});               // an owner with no vector: not in the list
      for (const id of ['ctest_o1', 'ctest_o2', 'ctest_o3']) await store.saveVector(id, 'm', [1, 0, 0], `h${id}`);
      await pool.query("INSERT INTO entry_shares (entry_id, shared_with, shared_by) VALUES ('ctest_o1', 'ctest_eng_guest', $1)", [MIKE]);
      const owners = (await listOwners()).filter((u) => u.startsWith('ctest_'));
      expect(owners).toEqual(['ctest_eng_guest', MIKE, SARA]);
      expect(await listOwners()).not.toContain(ANON);
    });
  });

  describe('addAutoMembers', () => {
    it('adds automatic members to the active collections of the user, and leaves alone every row that is already there', async () => {
      await wipe();
      for (const id of ['ctest_a1', 'ctest_a2', 'ctest_a3', 'ctest_a4']) await addEntry(id, MIKE, {});
      await store.saveCollections(MIKE, [
        { id: 'ctest_c_active', name: 'Vino', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: [1, 0, 0], coherence: 0.9, members: [{ entryId: 'ctest_a1', score: 0.9 }] },
        { id: 'ctest_c_watching', name: UNNAMED, groupLabel: null, parentId: null, state: 'watching', origin: 'found', centroid: [0, 1, 0], coherence: 0.9, members: [{ entryId: 'ctest_a1', score: 0.9 }] },
      ]);
      await store.removeEntry(MIKE, 'ctest_c_active', 'ctest_a3');             // taken out by hand: a memory that must stay
      await store.addEntry(MIKE, 'ctest_c_active', 'ctest_a4');                // put in by hand
      await addAutoMembers(MIKE, [
        { collectionId: 'ctest_c_active', entryId: 'ctest_a2', score: 0.8 },
        { collectionId: 'ctest_c_active', entryId: 'ctest_a1', score: 0.1 },    // already a member: the score stays
        { collectionId: 'ctest_c_active', entryId: 'ctest_a3', score: 0.8 },    // taken out: never comes back
        { collectionId: 'ctest_c_active', entryId: 'ctest_a4', score: 0.8 },    // put in by hand: stays a hand-made row
        { collectionId: 'ctest_c_watching', entryId: 'ctest_a2', score: 0.8 },  // a watching collection takes nobody
      ]);
      const members = await store.membersOf('ctest_c_active');
      expect(members.map((m) => [m.entryId, m.source]).sort()).toEqual([['ctest_a1', 'auto'], ['ctest_a2', 'auto'], ['ctest_a4', 'user_add']]);
      expect(members.find((m) => m.entryId === 'ctest_a1')?.score).toBeCloseTo(0.9, 5);
      expect((await store.membersOf('ctest_c_watching')).map((m) => m.entryId)).toEqual(['ctest_a1']);
    });

    it('never touches the collection of another user', async () => {
      await wipe();
      await addEntry('ctest_b1', SARA, {});
      await store.saveCollections(SARA, [{ id: 'ctest_c_sara', name: 'Vino', groupLabel: null, parentId: null, state: 'active', origin: 'found', centroid: [1, 0, 0], coherence: 0.9, members: [{ entryId: 'ctest_b1', score: 0.9 }] }]);
      await addEntry('ctest_b2', MIKE, {});
      await addAutoMembers(MIKE, [{ collectionId: 'ctest_c_sara', entryId: 'ctest_b2', score: 0.5 }]);
      expect((await store.membersOf('ctest_c_sara')).map((m) => m.entryId)).toEqual(['ctest_b1']);
    });
  });

  describe('the whole engine on Postgres', () => {
    const DIM = 24;
    /** A vector near the axis `k` (the others a little noisy): three well separated topics and some entries that belong to none. */
    function vec(k: number, i: number): number[] {
      return Array.from({ length: DIM }, (_, j) => (j === k ? 1 : 0.18 * Math.sin((i + 1) * (j + 3) * 12.9898)));
    }
    const TOPICS: Array<[string, number, number, string]> = [['wine', 0, 8, 'Vino'], ['food', 1, 7, 'Ristoranti'], ['tech', 2, 6, 'Intelligenza artificiale']];

    async function world(): Promise<EngineDeps> {
      await wipe();
      let n = 0;
      for (const [key, axis, count] of TOPICS) {
        for (let i = 0; i < count; i += 1) {
          const id = `ctest_${key}${i}`;
          await addEntry(id, MIKE, { summary: `${key} post ${i}`, tags: [`#${key}`], songs: [], films: [] }, null, new Date(Date.UTC(2026, 0, 1, 10, n++)).toISOString());
          await store.saveVector(id, 'm', vec(axis, i), `h${id}`);
        }
      }
      for (let i = 0; i < 60; i += 1) {
        const id = `ctest_noise${i}`;
        await addEntry(id, MIKE, { summary: `noise post ${i}`, tags: [], songs: [], films: [] }, null, new Date(Date.UTC(2026, 0, 1, 10, n++)).toISOString());
        await store.saveVector(id, 'm', Array.from({ length: DIM }, (_, j) => Math.sin((i + 1) * (j + 1) * 78.233)), `h${id}`);
      }
      let counter = 0;
      const names: Record<string, string> = Object.fromEntries(TOPICS.map(([key, , , name]) => [key, name]));
      return {
        store,
        features: entryFeatures,
        nameGroup: async (g: NamingGroup) => {
          const key = g.members[0].text.split(' ')[0];
          const name = names[key];
          return name ? { name, group: seedGroupOf(name) } : null;
        },
        newId: () => `ctest_c${++counter}`,
      };
    }

    it('a pass makes the collections, a second one changes nothing, the preview shows the same, and the fast lane adds a new entry without touching the rest', async () => {
      const deps = await world();
      const first = await consolidate(MIKE, deps);
      const rows = await store.listCollections(MIKE);
      expect(rows.filter((r) => r.state === 'active').map((r) => r.name).sort()).toEqual(['Intelligenza artificiale', 'Ristoranti', 'Vino']);
      expect(first.created).toBe(rows.length);
      const wine = rows.find((r) => r.name === 'Vino')!;
      expect((await store.membersOf(wine.id)).map((m) => m.entryId)).toEqual(expect.arrayContaining(Array.from({ length: 8 }, (_, i) => `ctest_wine${i}`)));

      const second = await consolidate(MIKE, deps);
      expect(second.created).toBe(0);
      expect(second.modelCalls).toBe(0);
      expect((await store.listCollections(MIKE)).map((r) => [r.id, r.name, r.state, r.size])).toEqual(rows.map((r) => [r.id, r.name, r.state, r.size]));

      const preview = await rebuildPreview(MIKE, deps);
      expect(preview.map((p) => p.id).sort()).toEqual(rows.map((r) => r.id).sort());

      await addEntry('ctest_wine_new', MIKE, { summary: 'wine post new', tags: ['#wine'], songs: [], films: [] }, null, '2026-02-01T10:00:00Z');
      await store.saveVector('ctest_wine_new', 'm', vec(0, 99), 'hnew');
      const joined = await assignOne(MIKE, 'ctest_wine_new', realAssignOneDeps());
      expect(joined).toContain(wine.id);
      expect((await store.membersOf(wine.id)).find((m) => m.entryId === 'ctest_wine_new')?.source).toBe('auto');
      expect((await store.listCollections(MIKE)).map((r) => [r.id, r.name, r.state])).toEqual(rows.map((r) => [r.id, r.name, r.state]));
      // and the next night keeps it
      await consolidate(MIKE, deps);
      expect((await store.membersOf(wine.id)).map((m) => m.entryId)).toContain('ctest_wine_new');
    });
  });
});
