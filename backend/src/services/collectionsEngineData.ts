/**
 * Where the engine of the collections meets the database (Raccolte, task 7; spec 2026-11-09-library-collections-auto-topics-design.md §5): what the store does
 * not give. The store holds vectors, places, venues and collections; the engine also needs the OWNERS to run the nightly pass for, what each entry SAYS (the
 * text the model is shown and the evidence of a name is looked for in) and whether it has songs from the content or films (a group that is mostly that is a
 * TYPE, not a theme), and the one insert of the fast lane. The rules are in `collectionsEngine.ts` and are pure; this only connects them.
 *
 * «Songs from the content» is the SAME notion the auto-playlists use (`CONTENT_SONG_SOURCES`: `ai_analysis`, `both`, `music_list`): the audio fingerprint is the
 * background track of any reel and says nothing about the subject.
 */
import { query } from '../utils/db';
import { CONTENT_SONG_SOURCES } from './autoPlaylists';
import {
  newCollectionId,
  nameWithLocalModel,
  type AssignOneDeps,
  type EngineDeps,
  type EntryFeatures,
} from './collectionsEngine';
import { PgCollectionsStore } from './collectionsStore';

/**
 * The users the nightly pass is for: the owners of entries that have a vector, and the users such entries are shared with (a family member who has no
 * entries of his own still sees collections of what was shared with him). Never «anonymous», never an empty name.
 */
export async function listOwners(): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM (
       SELECT e.owner_user AS user_id FROM entries e JOIN entry_vectors v ON v.entry_id = e.id
       UNION
       SELECT s.shared_with AS user_id FROM entry_shares s JOIN entry_vectors v ON v.entry_id = s.entry_id
     ) users
      WHERE user_id IS NOT NULL AND user_id <> '' AND user_id <> 'anonymous'
      ORDER BY user_id`,
  );
  return rows.map((r) => r.user_id);
}

/**
 * Has this owner a first publication? Any row of the table of the collections, in any state: a hidden or a merged one is a publication too (the owner has been
 * through the first run, and what he corrected must survive). The nightly pass consolidates only an owner who has; the first ones are the script's.
 */
export async function hasCollections(owner: string): Promise<boolean> {
  const rows = await query<{ one: number }>('SELECT 1 AS one FROM collections WHERE owner_user = $1 LIMIT 1', [owner]);
  return rows.length > 0;
}

const BATCH = 1000;

interface FeatureRow {
  id: string;
  text: string | null;
  tags: unknown;
  has_content_songs: boolean | null;
  has_films: boolean | null;
}

/**
 * What the engine asks to know about these entries (they are the ones of the user's vectors: the visibility is already decided). The text is the summary,
 * else the caption; the tags are the ones of the analysis. One question for each thousand ids.
 */
export async function entryFeatures(_userId: string, entryIds: string[]): Promise<Map<string, EntryFeatures>> {
  const out = new Map<string, EntryFeatures>();
  for (let from = 0; from < entryIds.length; from += BATCH) {
    const rows = await query<FeatureRow>(
      `SELECT e.id,
              COALESCE(NULLIF(btrim(e.results->>'summary'), ''), NULLIF(btrim(e.caption), ''), '') AS text,
              CASE WHEN jsonb_typeof(e.results->'tags') = 'array' THEN e.results->'tags' ELSE '[]'::jsonb END AS tags,
              CASE WHEN jsonb_typeof(e.results->'songs') = 'array'
                   THEN EXISTS (SELECT 1 FROM jsonb_array_elements(e.results->'songs') s WHERE s->>'source' = ANY($2::text[]))
                   ELSE false END AS has_content_songs,
              CASE WHEN jsonb_typeof(e.results->'films') = 'array' THEN jsonb_array_length(e.results->'films') > 0 ELSE false END AS has_films
         FROM entries e
        WHERE e.id = ANY($1::text[])`,
      [entryIds.slice(from, from + BATCH), [...CONTENT_SONG_SOURCES]],
    );
    for (const r of rows) {
      out.set(r.id, {
        text: r.text ?? '',
        tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
        hasContentSongs: r.has_content_songs === true,
        hasFilms: r.has_films === true,
      });
    }
  }
  return out;
}

/**
 * The fast lane's write (`assignOne`): AUTOMATIC members for the ACTIVE collections of this user. It only adds: a row that is already there (a member, or an
 * entry the user took out by hand: that row is a memory, `user_remove`) is left exactly as it is.
 */
export async function addAutoMembers(userId: string, additions: Array<{ collectionId: string; entryId: string; score: number }>): Promise<void> {
  if (additions.length === 0) return;
  await query(
    `INSERT INTO collection_entries (collection_id, entry_id, score, source)
     SELECT c.id, a.entry_id, a.score, 'auto'
       FROM unnest($1::text[], $2::text[], $3::real[]) AS a(collection_id, entry_id, score)
       JOIN collections c ON c.id = a.collection_id AND c.owner_user = $4 AND c.state = 'active'
     ON CONFLICT (collection_id, entry_id) DO NOTHING`,
    [additions.map((a) => a.collectionId), additions.map((a) => a.entryId), additions.map((a) => a.score), userId],
  );
}

/** The engine with its real parts: the database store, the real features, the local model for the names (through the gpu-router) and a UUID for each new collection. */
export function realEngineDeps(): EngineDeps {
  return { store: new PgCollectionsStore(), features: entryFeatures, nameGroup: nameWithLocalModel, newId: newCollectionId };
}

export function realAssignOneDeps(): AssignOneDeps {
  return { store: new PgCollectionsStore(), addMembers: addAutoMembers };
}
