/**
 * The store of the collections (ADR-0022, spec 2026-11-09-library-collections-auto-topics-design.md §8): the vector, the places and the venues
 * of every entry, the collections found from them, who is in which, and the corrections of the user.
 *
 * Two implementations with ONE behaviour (the same contract suite runs on both, `collectionsStoreContract.ts`): `PgCollectionsStore` (raw SQL,
 * what the server uses) and `MemoryCollectionsStore` (what the tests of the engine use).
 *
 * The rules they share:
 * - Everything is derived and rebuilt, EXCEPT the corrections of the user, which survive every `saveCollections`: a name given by the user, a
 *   hidden collection, a merged one, an entry put in by hand (`user_add`) and an entry taken out by hand (`user_remove`, which REMEMBERS the
 *   entry: it never comes back). `saveCollections` replaces only what is automatic.
 * - A user sees his own entries and those shared with him (the rule of `GET /api/entries`, no administrator clause): `vectorsOf`, the members of
 *   a collection and its size only ever count entries its owner can see; one user never gets another user's rows, and the writers change only a
 *   collection of the user who asks (they answer `false` for any other, and change nothing).
 * - A vector is replaced only when its text (the hash) or its model changes: the same text twice is stored once, so two nightly passes on
 *   unchanged data give the same collections.
 * - What was READ from an entry is recorded: the vector keeps the hash of its text, and a reading of places and venues keeps the hash of the text it read
 *   (`inputHashes`), even when it found nothing, so an entry with no place is not asked again and a reading that failed (no record) is tried again.
 * - Deleting an entry deletes its vector, places, venues, the record of what was read and memberships (cascade).
 */
import type { PoolClient } from 'pg';
import type { PlaceKind } from '../data/places';
import { query, withClient } from '../utils/db';

// ---------------------------------------------------------------------------------------------------------------- types

export type CollectionState = 'watching' | 'active' | 'hidden' | 'merged';
export type CollectionOrigin = 'seed' | 'found' | 'manual';
export type CollectionNameBy = 'auto' | 'user';
export type MemberSource = 'auto' | 'user_add' | 'user_remove';

/** What the engine decides for a collection it finds: `watching` (3-4 entries, not shown) or `active`. Hidden and merged are the user's. */
export type DecidedState = 'watching' | 'active';

export interface StoredVector {
  entryId: string;
  /** The date of the ENTRY (ISO 8601): the grouping goes in date order. */
  createdAt: string;
  vector: Float32Array;
  textHash: string;
}

/** What `parsePlacesAndVenues` gives as the place of a post (its `place`). */
export interface PlaceInput {
  name: string;
  kind: string;
}

/** What `parsePlacesAndVenues` gives as a venue of a post (one of its `venues`). */
export interface VenueInput {
  key: string;
  name: string;
  kind: string;
  place: string | null;
}

/** What was read from an entry, as the stores record it: the hash of the text of the vector (and its model) and the hash of the text the places were read from. */
export interface InputHashes {
  vectorHash: string | null;
  model: string | null;
  placesHash: string | null;
}

export interface EntryPlaceRow {
  entryId: string;
  name: string;
  kind: PlaceKind;
}

export interface EntryVenueRow {
  entryId: string;
  key: string;
  name: string;
  kind: string;
  place: string | null;
}

/** A collection as stored. `size` is the number of live members NOW (the ones its owner can see), not a copy kept at the last save. */
export interface CollectionRow {
  id: string;
  ownerUser: string;
  name: string;
  nameBy: CollectionNameBy;
  groupLabel: string | null;
  /** The parent theme, or, when `state` is `merged`, the collection it was merged into. */
  parentId: string | null;
  state: CollectionState;
  origin: CollectionOrigin;
  centroid: Float32Array | null;
  size: number;
  coherence: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A collection as the engine hands it over: what it found, with its automatic members. The corrections are never in it. */
export interface CollectionInput {
  id: string;
  name: string;
  groupLabel: string | null;
  parentId: string | null;
  state: DecidedState;
  origin: CollectionOrigin;
  centroid: Float32Array | number[] | null;
  coherence: number | null;
  members: Array<{ entryId: string; score: number }>;
}

export interface CollectionMember {
  entryId: string;
  score: number;
  source: Exclude<MemberSource, 'user_remove'>;
}

/** Every correction of a user, to apply last. */
export interface Corrections {
  renamed: Array<{ id: string; name: string }>;
  hidden: string[];
  merged: Array<{ id: string; into: string }>;
  added: Array<{ collectionId: string; entryId: string }>;
  removed: Array<{ collectionId: string; entryId: string }>;
}

export interface CollectionsStore {
  /** Stores the vector of an entry unless it already has one for the same text and model; `true` when something was written. */
  saveVector(entryId: string, model: string, vector: number[], textHash: string): Promise<boolean>;
  /** The vectors of the entries the user can see, in the order of the dates of the entries (then by id). */
  vectorsOf(userId: string): Promise<StoredVector[]>;
  /**
   * Replaces the places and the venues of an entry (what the text no longer says goes away). With `textHash` it also records, in the same
   * transaction, that the places were read from THAT text (even when there is no place and no venue: a reading that found nothing is a reading).
   * Without it the record of the reading is left as it is. An empty hash is refused.
   */
  savePlacesAndVenues(entryId: string, places: PlaceInput[], venues: VenueInput[], textHash?: string): Promise<void>;
  /**
   * What was read from these entries, in ONE question: the hash and the model of the vector, the hash of the text of the places. An entry with
   * nothing recorded is not in the map; an empty list gives an empty map. Whoever asks is the pipeline of an entry, not a user: no visibility rule.
   */
  inputHashes(entryIds: string[]): Promise<Map<string, InputHashes>>;
  placesOf(entryIds: string[]): Promise<EntryPlaceRow[]>;
  venuesOf(entryIds: string[]): Promise<EntryVenueRow[]>;
  /** Every collection of the user, in every state, in the order they were created. */
  listCollections(userId: string): Promise<CollectionRow[]>;
  /**
   * One transaction: stores what the engine found and replaces the AUTOMATIC members of those collections; keeps every correction. A collection
   * that is not in `rows` is deleted unless the user touched it, in which case it stays (without its automatic members, and `watching` if it
   * was `active`: no group stands behind it any more). Members the user cannot see, or that do not exist, are dropped.
   */
  saveCollections(userId: string, rows: CollectionInput[]): Promise<void>;
  /** The live members (automatic and put in by hand), best score first; only entries the OWNER of the collection can see. */
  membersOf(collectionId: string): Promise<CollectionMember[]>;
  corrections(userId: string): Promise<Corrections>;
  /** The writers answer `true` when the collection is the user's and the correction is in place, `false` (and change nothing) otherwise. */
  rename(userId: string, collectionId: string, name: string): Promise<boolean>;
  merge(userId: string, fromId: string, intoId: string): Promise<boolean>;
  hide(userId: string, collectionId: string): Promise<boolean>;
  unhide(userId: string, collectionId: string): Promise<boolean>;
  addEntry(userId: string, collectionId: string, entryId: string): Promise<boolean>;
  removeEntry(userId: string, collectionId: string, entryId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------------------------- validation (shared)

const PLACE_KINDS: readonly string[] = ['city', 'region', 'country'];
const ORIGINS: readonly string[] = ['seed', 'found', 'manual'];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cleanLine = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** A vector of finite numbers that a float32 holds (what `REAL[]` is). */
function checkVector(vector: ArrayLike<number>): number[] {
  if (!vector || vector.length === 0) throw new Error('vector_empty');
  const out: number[] = new Array<number>(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    if (typeof v !== 'number' || !Number.isFinite(Math.fround(v))) throw new Error('vector_not_finite');
    out[i] = v;
  }
  return out;
}

function checkVectorRecord(model: string, textHash: string): void {
  if (typeof model !== 'string' || !model) throw new Error('vector_model_required');
  if (typeof textHash !== 'string' || !textHash) throw new Error('vector_hash_required');
}

/** The hash of the text the places were read from: absent (the old way, nothing is recorded) or a text. */
function checkPlacesHash(textHash: string | undefined): void {
  if (textHash !== undefined && (typeof textHash !== 'string' || !textHash)) throw new Error('places_hash_required');
}

function normalizePlaces(places: PlaceInput[]): Array<{ name: string; kind: PlaceKind }> {
  const out: Array<{ name: string; kind: PlaceKind }> = [];
  const seen = new Set<string>();
  for (const p of places ?? []) {
    const name = cleanLine(p?.name);
    if (!name) throw new Error('place_name_required');
    if (!PLACE_KINDS.includes(p.kind)) throw new Error(`place_kind_invalid: ${String(p.kind)}`);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, kind: p.kind as PlaceKind });
  }
  return out;
}

function normalizeVenues(venues: VenueInput[]): VenueInput[] {
  const out: VenueInput[] = [];
  const seen = new Set<string>();
  for (const v of venues ?? []) {
    if (typeof v?.key !== 'string' || !v.key) throw new Error('venue_key_required');
    const name = cleanLine(v.name);
    if (!name) throw new Error('venue_name_required');
    if (seen.has(v.key)) continue;
    seen.add(v.key);
    out.push({ key: v.key, name, kind: cleanLine(v.kind) || 'other', place: cleanLine(v.place) || null });
  }
  return out;
}

interface NormalizedInput {
  id: string;
  name: string;
  groupLabel: string | null;
  parentId: string | null;
  state: DecidedState;
  origin: CollectionOrigin;
  centroid: number[] | null;
  coherence: number | null;
  /** One per entry (the best score), best first. */
  members: Array<{ entryId: string; score: number }>;
}

function normalizeInput(row: CollectionInput): NormalizedInput {
  const id = typeof row?.id === 'string' ? row.id.trim() : '';
  if (!id) throw new Error('collection_id_required');
  const name = cleanLine(row.name);
  if (!name) throw new Error('collection_name_required');
  if (row.state !== 'watching' && row.state !== 'active') throw new Error(`collection_state_invalid: ${String(row.state)}`);
  if (!ORIGINS.includes(row.origin)) throw new Error(`collection_origin_invalid: ${String(row.origin)}`);
  const parentId = typeof row.parentId === 'string' && row.parentId.trim() ? row.parentId.trim() : null;
  if (parentId === id) throw new Error('collection_parent_is_itself');
  const centroid = row.centroid === null || row.centroid === undefined ? null : checkVector(row.centroid);
  if (row.coherence !== null && row.coherence !== undefined && !Number.isFinite(row.coherence)) throw new Error('collection_coherence_invalid');
  const best = new Map<string, number>();
  for (const m of row.members ?? []) {
    if (typeof m?.entryId !== 'string' || !m.entryId) throw new Error('member_entry_required');
    if (typeof m.score !== 'number' || !Number.isFinite(m.score)) throw new Error('member_score_invalid');
    const seen = best.get(m.entryId);
    if (seen === undefined || m.score > seen) best.set(m.entryId, m.score);
  }
  return {
    id,
    name,
    groupLabel: cleanLine(row.groupLabel) || null,
    parentId,
    state: row.state,
    origin: row.origin,
    centroid,
    coherence: row.coherence ?? null,
    members: [...best].map(([entryId, score]) => ({ entryId, score })).sort((a, b) => b.score - a.score || cmp(a.entryId, b.entryId)),
  };
}

function assertUniqueIds(inputs: NormalizedInput[]): void {
  const seen = new Set<string>();
  for (const row of inputs) {
    if (seen.has(row.id)) throw new Error(`collection_id_repeated: ${row.id}`);
    seen.add(row.id);
  }
}

/**
 * What a save does with the collections of the user that are not in it: a plain one is deleted (its group is gone), one the user touched is
 * kept. A `parentId` must be a collection that will exist after the save.
 */
function planSave(inputs: NormalizedInput[], stored: Array<{ id: string; corrected: boolean }>): { drop: string[]; keepAbsent: string[] } {
  const incoming = new Set(inputs.map((i) => i.id));
  const drop: string[] = [];
  const keepAbsent: string[] = [];
  for (const s of stored) {
    if (incoming.has(s.id)) continue;
    (s.corrected ? keepAbsent : drop).push(s.id);
  }
  const after = new Set([...incoming, ...keepAbsent]);
  for (const row of inputs) {
    if (row.parentId && !after.has(row.parentId)) throw new Error(`collection_parent_not_found: ${row.parentId}`);
  }
  return { drop, keepAbsent };
}

// ---------------------------------------------------------------------------------------------------------------- Postgres

/** The entries a user can see: his own and those shared with him (the rule of `GET /api/entries`, without the administrator clause). */
const visibleSql = (entry: string, user: string): string =>
  `(${entry}.owner_user = ${user} OR EXISTS (SELECT 1 FROM entry_shares s WHERE s.entry_id = ${entry}.id AND s.shared_with = ${user}))`;

type CollectionDbRow = {
  id: string;
  owner_user: string;
  name: string;
  name_by: string;
  group_label: string | null;
  parent_id: string | null;
  state: string;
  origin: string;
  centroid: number[] | null;
  coherence: number | null;
  created_at: Date;
  updated_at: Date;
  live_size: number;
};

function toCollectionRow(r: CollectionDbRow): CollectionRow {
  return {
    id: r.id,
    ownerUser: r.owner_user,
    name: r.name,
    nameBy: r.name_by as CollectionNameBy,
    groupLabel: r.group_label,
    parentId: r.parent_id,
    state: r.state as CollectionState,
    origin: r.origin as CollectionOrigin,
    centroid: r.centroid ? Float32Array.from(r.centroid) : null,
    size: r.live_size,
    coherence: r.coherence,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // the connection is gone: there is nothing left to roll back
      }
      throw err;
    }
  });
}

/** The number of members that count (the ones not taken out by hand) and the time of the change. */
async function refreshSize(client: PoolClient, collectionId: string): Promise<void> {
  await client.query(
    `UPDATE collections
        SET size = (SELECT count(*)::int FROM collection_entries ce WHERE ce.collection_id = collections.id AND ce.source <> 'user_remove'),
            updated_at = now()
      WHERE id = $1`,
    [collectionId],
  );
}

const UPSERT_COLLECTION_SQL = `
  INSERT INTO collections (id, owner_user, name, group_label, parent_id, state, origin, centroid, coherence)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::real[], $9)
  ON CONFLICT (id) DO UPDATE SET
    name = CASE WHEN collections.name_by = 'user' THEN collections.name ELSE EXCLUDED.name END,
    group_label = EXCLUDED.group_label,
    parent_id = CASE WHEN collections.state = 'merged' THEN collections.parent_id ELSE EXCLUDED.parent_id END,
    state = CASE WHEN collections.state IN ('hidden', 'merged') THEN collections.state ELSE EXCLUDED.state END,
    origin = CASE WHEN collections.origin = 'manual' THEN collections.origin ELSE EXCLUDED.origin END,
    centroid = EXCLUDED.centroid,
    coherence = EXCLUDED.coherence,
    updated_at = now()
  WHERE collections.owner_user = EXCLUDED.owner_user`;

const INSERT_MEMBERS_SQL = `
  INSERT INTO collection_entries (collection_id, entry_id, score, source)
  SELECT $1, m.entry_id, m.score, 'auto'
    FROM unnest($2::text[], $3::real[]) AS m(entry_id, score)
    JOIN entries e ON e.id = m.entry_id
   WHERE ${visibleSql('e', '$4')}
  ON CONFLICT (collection_id, entry_id) DO NOTHING`;

export class PgCollectionsStore implements CollectionsStore {
  async saveVector(entryId: string, model: string, vector: number[], textHash: string): Promise<boolean> {
    const values = checkVector(vector);
    checkVectorRecord(model, textHash);
    const rows = await query(
      `INSERT INTO entry_vectors (entry_id, model, vector, text_hash, embedded_at)
       VALUES ($1, $2, $3::real[], $4, now())
       ON CONFLICT (entry_id) DO UPDATE
         SET model = EXCLUDED.model, vector = EXCLUDED.vector, text_hash = EXCLUDED.text_hash, embedded_at = now()
         WHERE entry_vectors.text_hash IS DISTINCT FROM EXCLUDED.text_hash OR entry_vectors.model IS DISTINCT FROM EXCLUDED.model
       RETURNING entry_id`,
      [entryId, model, values, textHash],
    );
    return rows.length > 0;
  }

  async vectorsOf(userId: string): Promise<StoredVector[]> {
    const rows = await query<{ entry_id: string; created_at: Date; vector: number[]; text_hash: string }>(
      `SELECT v.entry_id, e.created_at, v.vector, v.text_hash
         FROM entry_vectors v JOIN entries e ON e.id = v.entry_id
        WHERE ${visibleSql('e', '$1')}
        ORDER BY e.created_at ASC, e.id COLLATE "C" ASC`,
      [userId],
    );
    return rows.map((r) => ({ entryId: r.entry_id, createdAt: r.created_at.toISOString(), vector: Float32Array.from(r.vector), textHash: r.text_hash }));
  }

  async savePlacesAndVenues(entryId: string, places: PlaceInput[], venues: VenueInput[], textHash?: string): Promise<void> {
    checkPlacesHash(textHash);
    const cleanPlaces = normalizePlaces(places);
    const cleanVenues = normalizeVenues(venues);
    await inTransaction(async (client) => {
      const known = await client.query('SELECT 1 FROM entries WHERE id = $1', [entryId]);
      if (known.rowCount === 0) throw new Error(`entry_not_found: ${entryId}`);
      await client.query('DELETE FROM entry_places WHERE entry_id = $1', [entryId]);
      await client.query('DELETE FROM entry_venues WHERE entry_id = $1', [entryId]);
      for (const p of cleanPlaces) {
        await client.query('INSERT INTO entry_places (entry_id, place, kind) VALUES ($1, $2, $3)', [entryId, p.name, p.kind]);
      }
      for (const v of cleanVenues) {
        await client.query('INSERT INTO entry_venues (entry_id, venue_key, name, kind, place) VALUES ($1, $2, $3, $4, $5)', [entryId, v.key, v.name, v.kind, v.place]);
      }
      if (textHash !== undefined) {
        await client.query(
          `INSERT INTO entry_place_runs (entry_id, text_hash, ran_at) VALUES ($1, $2, now())
           ON CONFLICT (entry_id) DO UPDATE SET text_hash = EXCLUDED.text_hash, ran_at = now()`,
          [entryId, textHash],
        );
      }
    });
  }

  async inputHashes(entryIds: string[]): Promise<Map<string, InputHashes>> {
    const out = new Map<string, InputHashes>();
    if (entryIds.length === 0) return out;
    const rows = await query<{ entry_id: string; vector_hash: string | null; model: string | null; places_hash: string | null }>(
      `SELECT ids.id AS entry_id, v.text_hash AS vector_hash, v.model, r.text_hash AS places_hash
         FROM unnest($1::text[]) AS ids(id)
         LEFT JOIN entry_vectors v ON v.entry_id = ids.id
         LEFT JOIN entry_place_runs r ON r.entry_id = ids.id
        WHERE v.entry_id IS NOT NULL OR r.entry_id IS NOT NULL`,
      [entryIds],
    );
    for (const r of rows) out.set(r.entry_id, { vectorHash: r.vector_hash, model: r.model, placesHash: r.places_hash });
    return out;
  }

  async placesOf(entryIds: string[]): Promise<EntryPlaceRow[]> {
    if (entryIds.length === 0) return [];
    const rows = await query<{ entry_id: string; place: string; kind: string }>(
      'SELECT entry_id, place, kind FROM entry_places WHERE entry_id = ANY($1::text[]) ORDER BY entry_id COLLATE "C", place COLLATE "C"',
      [entryIds],
    );
    return rows.map((r) => ({ entryId: r.entry_id, name: r.place, kind: r.kind as PlaceKind }));
  }

  async venuesOf(entryIds: string[]): Promise<EntryVenueRow[]> {
    if (entryIds.length === 0) return [];
    const rows = await query<{ entry_id: string; venue_key: string; name: string; kind: string; place: string | null }>(
      'SELECT entry_id, venue_key, name, kind, place FROM entry_venues WHERE entry_id = ANY($1::text[]) ORDER BY entry_id COLLATE "C", venue_key COLLATE "C"',
      [entryIds],
    );
    return rows.map((r) => ({ entryId: r.entry_id, key: r.venue_key, name: r.name, kind: r.kind, place: r.place }));
  }

  async listCollections(userId: string): Promise<CollectionRow[]> {
    const rows = await query<CollectionDbRow>(
      `SELECT c.id, c.owner_user, c.name, c.name_by, c.group_label, c.parent_id, c.state, c.origin, c.centroid, c.coherence, c.created_at, c.updated_at,
              (SELECT count(*)::int
                 FROM collection_entries ce JOIN entries e ON e.id = ce.entry_id
                WHERE ce.collection_id = c.id AND ce.source <> 'user_remove' AND ${visibleSql('e', 'c.owner_user')}) AS live_size
         FROM collections c
        WHERE c.owner_user = $1
        ORDER BY c.created_at ASC, c.id COLLATE "C" ASC`,
      [userId],
    );
    return rows.map(toCollectionRow);
  }

  async saveCollections(userId: string, rows: CollectionInput[]): Promise<void> {
    const inputs = rows.map(normalizeInput);
    assertUniqueIds(inputs);
    await inTransaction(async (client) => {
      const ids = inputs.map((i) => i.id);
      if (ids.length > 0) {
        const foreign = await client.query<{ id: string }>('SELECT id FROM collections WHERE id = ANY($1::text[]) AND owner_user <> $2', [ids, userId]);
        if (foreign.rows.length > 0) throw new Error(`collection_belongs_to_another_user: ${foreign.rows[0].id}`);
      }
      // two saves of the same user never interleave
      const stored = await client.query<{ id: string; corrected: boolean }>(
        `SELECT c.id,
                (c.name_by = 'user' OR c.state IN ('hidden', 'merged')
                 OR EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.collection_id = c.id AND ce.source <> 'auto')) AS corrected
           FROM collections c
          WHERE c.owner_user = $1
          ORDER BY c.id COLLATE "C"
            FOR UPDATE OF c`,
        [userId],
      );
      const plan = planSave(inputs, stored.rows);

      for (const row of inputs) {
        await client.query(UPSERT_COLLECTION_SQL, [
          row.id, userId, row.name, row.groupLabel, row.parentId, row.state, row.origin, row.centroid, row.coherence,
        ]);
        await client.query("DELETE FROM collection_entries WHERE collection_id = $1 AND source = 'auto'", [row.id]);
        if (row.members.length > 0) {
          await client.query(INSERT_MEMBERS_SQL, [row.id, row.members.map((m) => m.entryId), row.members.map((m) => m.score), userId]);
        }
      }
      if (plan.drop.length > 0) {
        await client.query('DELETE FROM collections WHERE owner_user = $1 AND id = ANY($2::text[])', [userId, plan.drop]);
      }
      if (plan.keepAbsent.length > 0) {
        await client.query("DELETE FROM collection_entries WHERE source = 'auto' AND collection_id = ANY($1::text[])", [plan.keepAbsent]);
        await client.query("UPDATE collections SET state = 'watching', updated_at = now() WHERE id = ANY($1::text[]) AND state = 'active'", [plan.keepAbsent]);
      }
      await client.query(
        `UPDATE collections
            SET size = (SELECT count(*)::int FROM collection_entries ce WHERE ce.collection_id = collections.id AND ce.source <> 'user_remove')
          WHERE owner_user = $1`,
        [userId],
      );
    });
  }

  async membersOf(collectionId: string): Promise<CollectionMember[]> {
    const rows = await query<{ entry_id: string; score: number; source: string }>(
      `SELECT ce.entry_id, ce.score, ce.source
         FROM collection_entries ce
         JOIN collections c ON c.id = ce.collection_id
         JOIN entries e ON e.id = ce.entry_id
        WHERE ce.collection_id = $1 AND ce.source <> 'user_remove' AND ${visibleSql('e', 'c.owner_user')}
        ORDER BY ce.score DESC, ce.entry_id COLLATE "C" ASC`,
      [collectionId],
    );
    return rows.map((r) => ({ entryId: r.entry_id, score: r.score, source: r.source as CollectionMember['source'] }));
  }

  async corrections(userId: string): Promise<Corrections> {
    const collections = await query<{ id: string; name: string; name_by: string; state: string; parent_id: string | null }>(
      `SELECT id, name, name_by, state, parent_id
         FROM collections
        WHERE owner_user = $1 AND (name_by = 'user' OR state IN ('hidden', 'merged'))
        ORDER BY created_at ASC, id COLLATE "C" ASC`,
      [userId],
    );
    const entries = await query<{ collection_id: string; entry_id: string; source: string }>(
      `SELECT ce.collection_id, ce.entry_id, ce.source
         FROM collection_entries ce JOIN collections c ON c.id = ce.collection_id
        WHERE c.owner_user = $1 AND ce.source IN ('user_add', 'user_remove')
        ORDER BY ce.collection_id COLLATE "C", ce.entry_id COLLATE "C"`,
      [userId],
    );
    return {
      renamed: collections.filter((c) => c.name_by === 'user').map((c) => ({ id: c.id, name: c.name })),
      hidden: collections.filter((c) => c.state === 'hidden').map((c) => c.id),
      merged: collections.filter((c) => c.state === 'merged' && c.parent_id).map((c) => ({ id: c.id, into: c.parent_id as string })),
      added: entries.filter((r) => r.source === 'user_add').map((r) => ({ collectionId: r.collection_id, entryId: r.entry_id })),
      removed: entries.filter((r) => r.source === 'user_remove').map((r) => ({ collectionId: r.collection_id, entryId: r.entry_id })),
    };
  }

  async rename(userId: string, collectionId: string, name: string): Promise<boolean> {
    const clean = cleanLine(name);
    if (!clean) throw new Error('collection_name_required');
    const rows = await query(
      "UPDATE collections SET name = $3, name_by = 'user', updated_at = now() WHERE id = $2 AND owner_user = $1 RETURNING id",
      [userId, collectionId, clean],
    );
    return rows.length > 0;
  }

  async hide(userId: string, collectionId: string): Promise<boolean> {
    const rows = await query(
      "UPDATE collections SET state = 'hidden', updated_at = now() WHERE id = $2 AND owner_user = $1 AND state <> 'merged' RETURNING id",
      [userId, collectionId],
    );
    return rows.length > 0;
  }

  async unhide(userId: string, collectionId: string): Promise<boolean> {
    const rows = await query(
      `UPDATE collections SET state = CASE WHEN state = 'hidden' THEN 'active' ELSE state END, updated_at = now()
        WHERE id = $2 AND owner_user = $1 AND state <> 'merged' RETURNING id`,
      [userId, collectionId],
    );
    return rows.length > 0;
  }

  async merge(userId: string, fromId: string, intoId: string): Promise<boolean> {
    if (fromId === intoId) return false;
    return inTransaction(async (client) => {
      const found = await client.query<{ id: string; state: string }>(
        'SELECT id, state FROM collections WHERE owner_user = $1 AND id = ANY($2::text[]) FOR UPDATE',
        [userId, [fromId, intoId]],
      );
      const from = found.rows.find((r) => r.id === fromId);
      const into = found.rows.find((r) => r.id === intoId);
      if (!from || !into || from.state === 'merged' || into.state === 'merged') return false;
      // its entries are put in the other collection BY HAND (so they stay), except those the user had taken out of it
      await client.query(
        `INSERT INTO collection_entries (collection_id, entry_id, score, source)
         SELECT $2, ce.entry_id, 1, 'user_add' FROM collection_entries ce WHERE ce.collection_id = $1 AND ce.source <> 'user_remove'
         ON CONFLICT (collection_id, entry_id) DO UPDATE SET score = 1, source = 'user_add' WHERE collection_entries.source = 'auto'`,
        [fromId, intoId],
      );
      await client.query("UPDATE collections SET state = 'merged', parent_id = $2 WHERE id = $1", [fromId, intoId]);
      await refreshSize(client, intoId);
      await refreshSize(client, fromId);
      return true;
    });
  }

  async addEntry(userId: string, collectionId: string, entryId: string): Promise<boolean> {
    return inTransaction(async (client) => {
      const done = await client.query(
        `INSERT INTO collection_entries (collection_id, entry_id, score, source)
         SELECT c.id, e.id, 1, 'user_add'
           FROM collections c, entries e
          WHERE c.id = $2 AND c.owner_user = $1 AND c.state <> 'merged' AND e.id = $3 AND ${visibleSql('e', '$1')}
         ON CONFLICT (collection_id, entry_id) DO UPDATE SET score = 1, source = 'user_add'
         RETURNING entry_id`,
        [userId, collectionId, entryId],
      );
      if (done.rows.length === 0) return false;
      await refreshSize(client, collectionId);
      return true;
    });
  }

  async removeEntry(userId: string, collectionId: string, entryId: string): Promise<boolean> {
    return inTransaction(async (client) => {
      const done = await client.query(
        `INSERT INTO collection_entries (collection_id, entry_id, score, source)
         SELECT c.id, e.id, 0, 'user_remove'
           FROM collections c, entries e
          WHERE c.id = $2 AND c.owner_user = $1 AND c.state <> 'merged' AND e.id = $3
         ON CONFLICT (collection_id, entry_id) DO UPDATE SET score = 0, source = 'user_remove'
         RETURNING entry_id`,
        [userId, collectionId, entryId],
      );
      if (done.rows.length === 0) return false;
      await refreshSize(client, collectionId);
      return true;
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------- memory

interface MemoryEntry {
  ownerUser: string | null;
  createdAt: string;
  sharedWith: Set<string>;
}

interface MemoryCollection {
  id: string;
  ownerUser: string;
  name: string;
  nameBy: CollectionNameBy;
  groupLabel: string | null;
  parentId: string | null;
  state: CollectionState;
  origin: CollectionOrigin;
  centroid: Float32Array | null;
  coherence: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCollectionsOptions {
  /**
   * Which entries a user can see, in place of the registry of entries (and of their owners and sharing): the way a test of the engine says
   * «mike sees these» without setting the entries up one by one.
   */
  visibleEntryIds?: (userId: string) => Iterable<string>;
  /**
   * Behave as the database does for an entry that does not exist (a vector or places for it are refused). By default an entry is known as soon
   * as a vector, a place or a venue is saved for it, and everybody sees it: a synthetic library needs no setup.
   */
  strict?: boolean;
  /** The clock; it only ever goes forward (two saves in the same millisecond are still two moments, as in the database). */
  now?: () => Date;
}

/** The store of the tests of the engine: the same behaviour as `PgCollectionsStore`, in memory. */
export class MemoryCollectionsStore implements CollectionsStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly vectors = new Map<string, { model: string; vector: Float32Array; textHash: string }>();
  private readonly places = new Map<string, EntryPlaceRow[]>();
  private readonly venues = new Map<string, EntryVenueRow[]>();
  private readonly placeRuns = new Map<string, string>();
  private readonly collections = new Map<string, MemoryCollection>();
  private readonly members = new Map<string, Map<string, { score: number; source: MemberSource }>>();
  private lastTick = 0;
  private syntheticDate = Date.UTC(2020, 0, 1);

  constructor(private readonly options: MemoryCollectionsOptions = {}) {}

  // ---- the world around the store (what the database has and a test has to say)

  registerEntry(entry: { id: string; ownerUser?: string | null; createdAt?: string }): void {
    const known = this.entries.get(entry.id);
    const createdAt = entry.createdAt ?? known?.createdAt ?? this.nextSyntheticDate();
    this.entries.set(entry.id, { ownerUser: entry.ownerUser ?? known?.ownerUser ?? null, createdAt, sharedWith: known?.sharedWith ?? new Set() });
  }

  shareEntry(entryId: string, withUser: string): void {
    this.entries.get(entryId)?.sharedWith.add(withUser);
  }

  unshareEntry(entryId: string, withUser: string): void {
    this.entries.get(entryId)?.sharedWith.delete(withUser);
  }

  /** What deleting an entry does in the database: its vector, places, venues and memberships go (the cascade). */
  deleteEntry(entryId: string): void {
    this.entries.delete(entryId);
    this.vectors.delete(entryId);
    this.places.delete(entryId);
    this.venues.delete(entryId);
    this.placeRuns.delete(entryId);
    for (const members of this.members.values()) members.delete(entryId);
  }

  // ---- internals

  private nextSyntheticDate(): string {
    this.syntheticDate += 1000;
    return new Date(this.syntheticDate).toISOString();
  }

  private tick(): string {
    const t = Math.max((this.options.now?.() ?? new Date()).getTime(), this.lastTick + 1);
    this.lastTick = t;
    return new Date(t).toISOString();
  }

  /** The entry of a vector, a place or a venue: in strict mode it must exist, otherwise it is known from now on. */
  private requireEntry(entryId: string): void {
    if (this.entries.has(entryId)) return;
    if (this.options.strict) throw new Error(`entry_not_found: ${entryId}`);
    this.registerEntry({ id: entryId });
  }

  private seesEntry(userId: string): (entryId: string) => boolean {
    if (this.options.visibleEntryIds) {
      const ids = new Set(this.options.visibleEntryIds(userId));
      return (entryId) => this.entries.has(entryId) && ids.has(entryId);
    }
    return (entryId) => {
      const entry = this.entries.get(entryId);
      return !!entry && (entry.ownerUser === null || entry.ownerUser === userId || entry.sharedWith.has(userId));
    };
  }

  private membersMap(collectionId: string): Map<string, { score: number; source: MemberSource }> {
    let map = this.members.get(collectionId);
    if (!map) {
      map = new Map();
      this.members.set(collectionId, map);
    }
    return map;
  }

  private liveMembers(collection: MemoryCollection): CollectionMember[] {
    const sees = this.seesEntry(collection.ownerUser);
    const out: CollectionMember[] = [];
    for (const [entryId, m] of this.members.get(collection.id) ?? []) {
      if (m.source === 'user_remove' || !sees(entryId)) continue;
      out.push({ entryId, score: m.score, source: m.source });
    }
    return out.sort((a, b) => b.score - a.score || cmp(a.entryId, b.entryId));
  }

  private isCorrected(collection: MemoryCollection): boolean {
    if (collection.nameBy === 'user' || collection.state === 'hidden' || collection.state === 'merged') return true;
    for (const m of this.members.get(collection.id)?.values() ?? []) if (m.source !== 'auto') return true;
    return false;
  }

  private owned(userId: string, collectionId: string): MemoryCollection | undefined {
    const collection = this.collections.get(collectionId);
    return collection && collection.ownerUser === userId ? collection : undefined;
  }

  private toRow(c: MemoryCollection): CollectionRow {
    return { ...c, centroid: c.centroid ? Float32Array.from(c.centroid) : null, size: this.liveMembers(c).length };
  }

  // ---- the store

  async saveVector(entryId: string, model: string, vector: number[], textHash: string): Promise<boolean> {
    const values = checkVector(vector);
    checkVectorRecord(model, textHash);
    this.requireEntry(entryId);
    const stored = this.vectors.get(entryId);
    if (stored && stored.textHash === textHash && stored.model === model) return false;
    this.vectors.set(entryId, { model, vector: Float32Array.from(values), textHash });
    return true;
  }

  async vectorsOf(userId: string): Promise<StoredVector[]> {
    const sees = this.seesEntry(userId);
    const out: StoredVector[] = [];
    for (const [entryId, v] of this.vectors) {
      if (!sees(entryId)) continue;
      out.push({ entryId, createdAt: this.entries.get(entryId)?.createdAt ?? '', vector: Float32Array.from(v.vector), textHash: v.textHash });
    }
    return out.sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.entryId, b.entryId));
  }

  async savePlacesAndVenues(entryId: string, places: PlaceInput[], venues: VenueInput[], textHash?: string): Promise<void> {
    checkPlacesHash(textHash);
    const cleanPlaces = normalizePlaces(places);
    const cleanVenues = normalizeVenues(venues);
    this.requireEntry(entryId);
    this.places.set(entryId, cleanPlaces.map((p) => ({ entryId, name: p.name, kind: p.kind })));
    this.venues.set(entryId, cleanVenues.map((v) => ({ entryId, key: v.key, name: v.name, kind: v.kind, place: v.place })));
    if (textHash !== undefined) this.placeRuns.set(entryId, textHash);
  }

  async inputHashes(entryIds: string[]): Promise<Map<string, InputHashes>> {
    const out = new Map<string, InputHashes>();
    for (const id of entryIds) {
      const vector = this.vectors.get(id);
      const placesHash = this.placeRuns.get(id) ?? null;
      if (!vector && placesHash === null) continue;
      out.set(id, { vectorHash: vector?.textHash ?? null, model: vector?.model ?? null, placesHash });
    }
    return out;
  }

  async placesOf(entryIds: string[]): Promise<EntryPlaceRow[]> {
    const out: EntryPlaceRow[] = [];
    for (const id of new Set(entryIds)) for (const p of this.places.get(id) ?? []) out.push({ ...p });
    return out.sort((a, b) => cmp(a.entryId, b.entryId) || cmp(a.name, b.name));
  }

  async venuesOf(entryIds: string[]): Promise<EntryVenueRow[]> {
    const out: EntryVenueRow[] = [];
    for (const id of new Set(entryIds)) for (const v of this.venues.get(id) ?? []) out.push({ ...v });
    return out.sort((a, b) => cmp(a.entryId, b.entryId) || cmp(a.key, b.key));
  }

  async listCollections(userId: string): Promise<CollectionRow[]> {
    return [...this.collections.values()]
      .filter((c) => c.ownerUser === userId)
      .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))
      .map((c) => this.toRow(c));
  }

  async saveCollections(userId: string, rows: CollectionInput[]): Promise<void> {
    const inputs = rows.map(normalizeInput);
    assertUniqueIds(inputs);
    for (const row of inputs) {
      const existing = this.collections.get(row.id);
      if (existing && existing.ownerUser !== userId) throw new Error(`collection_belongs_to_another_user: ${row.id}`);
    }
    const mine = [...this.collections.values()].filter((c) => c.ownerUser === userId);
    const plan = planSave(inputs, mine.map((c) => ({ id: c.id, corrected: this.isCorrected(c) })));

    // nothing can fail from here on: the save is all or nothing
    const stamp = this.tick();
    const sees = this.seesEntry(userId);
    for (const row of inputs) {
      const existing = this.collections.get(row.id);
      const centroid = row.centroid ? Float32Array.from(row.centroid) : null;
      if (existing) {
        if (existing.nameBy !== 'user') existing.name = row.name;
        existing.groupLabel = row.groupLabel;
        if (existing.state !== 'merged') existing.parentId = row.parentId;
        if (existing.state !== 'hidden' && existing.state !== 'merged') existing.state = row.state;
        if (existing.origin !== 'manual') existing.origin = row.origin;
        existing.centroid = centroid;
        existing.coherence = row.coherence;
        existing.updatedAt = stamp;
      } else {
        this.collections.set(row.id, {
          id: row.id, ownerUser: userId, name: row.name, nameBy: 'auto', groupLabel: row.groupLabel, parentId: row.parentId, state: row.state,
          origin: row.origin, centroid, coherence: row.coherence, createdAt: stamp, updatedAt: stamp,
        });
      }
      const members = this.membersMap(row.id);
      for (const [entryId, m] of [...members]) if (m.source === 'auto') members.delete(entryId);
      for (const m of row.members) {
        if (!sees(m.entryId) || members.has(m.entryId)) continue;
        members.set(m.entryId, { score: m.score, source: 'auto' });
      }
    }
    for (const id of plan.drop) {
      this.collections.delete(id);
      this.members.delete(id);
      for (const other of this.collections.values()) if (other.parentId === id) other.parentId = null;
    }
    for (const id of plan.keepAbsent) {
      const collection = this.collections.get(id);
      if (!collection) continue;
      const members = this.membersMap(id);
      for (const [entryId, m] of [...members]) if (m.source === 'auto') members.delete(entryId);
      if (collection.state === 'active') {
        collection.state = 'watching';
        collection.updatedAt = stamp;
      }
    }
  }

  async membersOf(collectionId: string): Promise<CollectionMember[]> {
    const collection = this.collections.get(collectionId);
    return collection ? this.liveMembers(collection) : [];
  }

  async corrections(userId: string): Promise<Corrections> {
    const mine = [...this.collections.values()]
      .filter((c) => c.ownerUser === userId)
      .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
    const entries: Array<{ collectionId: string; entryId: string; source: MemberSource }> = [];
    for (const c of mine) {
      for (const [entryId, m] of this.members.get(c.id) ?? []) {
        if (m.source !== 'auto') entries.push({ collectionId: c.id, entryId, source: m.source });
      }
    }
    entries.sort((a, b) => cmp(a.collectionId, b.collectionId) || cmp(a.entryId, b.entryId));
    return {
      renamed: mine.filter((c) => c.nameBy === 'user').map((c) => ({ id: c.id, name: c.name })),
      hidden: mine.filter((c) => c.state === 'hidden').map((c) => c.id),
      merged: mine.filter((c) => c.state === 'merged' && c.parentId).map((c) => ({ id: c.id, into: c.parentId as string })),
      added: entries.filter((r) => r.source === 'user_add').map(({ collectionId, entryId }) => ({ collectionId, entryId })),
      removed: entries.filter((r) => r.source === 'user_remove').map(({ collectionId, entryId }) => ({ collectionId, entryId })),
    };
  }

  async rename(userId: string, collectionId: string, name: string): Promise<boolean> {
    const clean = cleanLine(name);
    if (!clean) throw new Error('collection_name_required');
    const collection = this.owned(userId, collectionId);
    if (!collection) return false;
    collection.name = clean;
    collection.nameBy = 'user';
    collection.updatedAt = this.tick();
    return true;
  }

  async hide(userId: string, collectionId: string): Promise<boolean> {
    const collection = this.owned(userId, collectionId);
    if (!collection || collection.state === 'merged') return false;
    collection.state = 'hidden';
    collection.updatedAt = this.tick();
    return true;
  }

  async unhide(userId: string, collectionId: string): Promise<boolean> {
    const collection = this.owned(userId, collectionId);
    if (!collection || collection.state === 'merged') return false;
    if (collection.state === 'hidden') collection.state = 'active';
    collection.updatedAt = this.tick();
    return true;
  }

  async merge(userId: string, fromId: string, intoId: string): Promise<boolean> {
    if (fromId === intoId) return false;
    const from = this.owned(userId, fromId);
    const into = this.owned(userId, intoId);
    if (!from || !into || from.state === 'merged' || into.state === 'merged') return false;
    const target = this.membersMap(intoId);
    for (const [entryId, m] of this.members.get(fromId) ?? []) {
      if (m.source === 'user_remove') continue;
      const there = target.get(entryId);
      if (!there || there.source === 'auto') target.set(entryId, { score: 1, source: 'user_add' });
    }
    const stamp = this.tick();
    from.state = 'merged';
    from.parentId = intoId;
    from.updatedAt = stamp;
    into.updatedAt = stamp;
    return true;
  }

  async addEntry(userId: string, collectionId: string, entryId: string): Promise<boolean> {
    const collection = this.owned(userId, collectionId);
    if (!collection || collection.state === 'merged' || !this.seesEntry(userId)(entryId)) return false;
    this.membersMap(collectionId).set(entryId, { score: 1, source: 'user_add' });
    collection.updatedAt = this.tick();
    return true;
  }

  async removeEntry(userId: string, collectionId: string, entryId: string): Promise<boolean> {
    const collection = this.owned(userId, collectionId);
    if (!collection || collection.state === 'merged' || !this.entries.has(entryId)) return false;
    this.membersMap(collectionId).set(entryId, { score: 0, source: 'user_remove' });
    collection.updatedAt = this.tick();
    return true;
  }
}
