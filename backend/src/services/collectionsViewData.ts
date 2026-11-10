/**
 * The real sources of the view layer of the collections (`services/collectionsView.ts` has the rules, docs/collections.md the contract).
 *
 * Every question is for ONE user and the user is always a bound parameter, never part of the text: the posts he owns and the ones shared with him
 * (the rule of `GET /api/entries`, WITHOUT the administrator clause: collections are strictly per user, an administrator sees no more than anyone).
 * The types are predicates on the results of the post (songs, films, software, notes of the place and of the book), the places come from
 * `entry_places`, the themes and who is in them from `collections` and `collection_entries`. Nothing is kept from one request to the next.
 */
import { query } from '../utils/db';
import { logWarning } from '../utils/logger';
import type { PlaceKind } from '../data/places';
import type { CollectionChip, EntrySummaryRow } from '../types';
import { PgCollectionsStore } from './collectionsStore';
import { getUserSongs } from './userSongs';
import {
  chipsForEntries,
  groupVenues,
  timeOf,
  type ChipPlaceRow,
  type ChipThemeRow,
  type CollectionVenue,
  type EntryFact,
  type MemberRef,
  type MemberRow,
  type PlaceFacts,
  type ThemeRow,
  type ThemeState,
  type TypeId,
  type ViewSources,
} from './collectionsView';

// ---------------------------------------------------------------------------------------------------------------- SQL pieces

/** The posts a user can read: his own, and the ones shared with him. */
const visible = (entry: string, user: string): string =>
  `(${entry}.owner_user = ${user} OR EXISTS (SELECT 1 FROM entry_shares s WHERE s.entry_id = ${entry}.id AND s.shared_with = ${user}))`;

/** The length of an array in the results, 0 when it is missing or is not an array (a stored value is not schema-checked). */
const arrayLength = (path: string): string => `(CASE WHEN jsonb_typeof(${path}) = 'array' THEN jsonb_array_length(${path}) ELSE 0 END)`;

/** True when a note of this category is in the results. */
const hasNote = (category: 'place' | 'book'): string =>
  `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.results->'notes') = 'array' THEN e.results->'notes' ELSE '[]'::jsonb END) AS n WHERE n->>'category' = '${category}')`;

/** What makes a post belong to a type (spec §4.1: «predicati sul database», not rows of the table). */
const TYPE_PREDICATE: Readonly<Record<TypeId, string>> = {
  'type:music': `${arrayLength("e.results->'songs'")} > 0`,
  'type:films': `${arrayLength("e.results->'films'")} > 0`,
  'type:software': `${arrayLength("e.results->'software'")} > 0`,
  'type:places': hasNote('place'),
  'type:books': hasNote('book'),
};

/** The row of the list of entries (`listEntrySummaries`), the same fields in the same shape (the table's own trigger refuses a list that is not a list; `toMemberRow` keeps only the texts). */
const SUMMARY_COLUMNS = `
  e.id, e.source_url, e.source_platform, e.caption, e.thumbnail_url, e.status, e.created_at,
  e.results->>'summary' AS summary,
  ${arrayLength("e.results->'songs'")} AS song_count,
  ${arrayLength("e.results->'films'")} AS film_count,
  ${arrayLength("e.results->'notes'")} AS note_count,
  COALESCE(e.results->'tags', '[]'::jsonb) AS tags`;

const NEWEST_FIRST = 'ORDER BY e.created_at DESC, e.id COLLATE "C" ASC';

interface FactRow {
  id: string;
  created_at: Date;
  thumbnail_url: string | null;
}

const toFact = (r: FactRow): EntryFact => ({ id: r.id, createdAt: r.created_at.toISOString(), thumbnailUrl: r.thumbnail_url });

interface SummaryDbRow {
  id: string;
  source_url: string;
  source_platform: string;
  caption: string | null;
  thumbnail_url: string | null;
  status: string;
  created_at: Date;
  summary: string | null;
  song_count: number | string;
  film_count: number | string;
  note_count: number | string;
  tags: unknown;
  score: number | string;
  source: string;
}

function toMemberRow(r: SummaryDbRow): MemberRow {
  return {
    id: r.id,
    sourceUrl: r.source_url,
    sourcePlatform: r.source_platform,
    caption: r.caption,
    thumbnailUrl: r.thumbnail_url,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    summary: r.summary,
    songCount: Number(r.song_count),
    filmCount: Number(r.film_count),
    noteCount: Number(r.note_count),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    score: Number(r.score),
    source: r.source === 'user_add' ? 'user_add' : r.source === 'auto' ? 'auto' : 'computed',
  };
}

// ---------------------------------------------------------------------------------------------------------------- the sources

const store = new PgCollectionsStore();

/** The sources of the lists, of one collection and of the chips, for the real database. They keep nothing: a call is a question. */
export function realViewSources(): ViewSources {
  return {
    async typeEntries(userId) {
      const rows = await query<FactRow & { music: boolean; films: boolean; software: boolean; places: boolean; books: boolean }>(
        `SELECT * FROM (
           SELECT e.id, e.created_at, e.thumbnail_url,
                  (${TYPE_PREDICATE['type:music']}) AS music,
                  (${TYPE_PREDICATE['type:films']}) AS films,
                  (${TYPE_PREDICATE['type:software']}) AS software,
                  (${TYPE_PREDICATE['type:places']}) AS places,
                  (${TYPE_PREDICATE['type:books']}) AS books
             FROM entries e
            WHERE ${visible('e', '$1')}
         ) t
         WHERE music OR films OR software OR places OR books
         ORDER BY created_at DESC, id COLLATE "C" ASC`,
        [userId],
      );
      const flag: Record<TypeId, 'music' | 'films' | 'software' | 'places' | 'books'> = {
        'type:music': 'music', 'type:films': 'films', 'type:software': 'software', 'type:places': 'places', 'type:books': 'books',
      };
      const out: Partial<Record<TypeId, EntryFact[]>> = {};
      for (const row of rows) {
        for (const type of Object.keys(flag) as TypeId[]) {
          if (row[flag[type]]) (out[type] ??= []).push(toFact(row));
        }
      }
      return out;
    },

    async placeEntries(userId) {
      const rows = await query<FactRow & { place: string; kind: PlaceKind }>(
        `SELECT p.place, p.kind, e.id, e.created_at, e.thumbnail_url
           FROM entry_places p JOIN entries e ON e.id = p.entry_id
          WHERE ${visible('e', '$1')}
          ${NEWEST_FIRST}, p.place COLLATE "C" ASC`,
        [userId],
      );
      const groups = new Map<string, PlaceFacts>();
      for (const row of rows) {
        const key = `${row.place}\u0000${row.kind}`;
        const group = groups.get(key) ?? { name: row.place, kind: row.kind, entries: [] };
        group.entries.push(toFact(row));
        groups.set(key, group);
      }
      return [...groups.values()];
    },

    async themeRows(userId): Promise<ThemeRow[]> {
      const rows = await query<{ id: string; name: string; name_by: string; group_label: string | null; parent_id: string | null; state: string; created_at: Date }>(
        `SELECT id, name, name_by, group_label, parent_id, state, created_at
           FROM collections
          WHERE owner_user = $1
          ORDER BY created_at ASC, id COLLATE "C" ASC`,
        [userId],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        nameBy: r.name_by === 'user' ? 'user' : 'auto',
        groupLabel: r.group_label,
        parentId: r.parent_id,
        state: r.state as ThemeState,
        createdAt: r.created_at.toISOString(),
      }));
    },

    async themeMembers(userId) {
      const rows = await query<FactRow & { collection_id: string }>(
        `SELECT ce.collection_id, e.id, e.created_at, e.thumbnail_url
           FROM collection_entries ce
           JOIN collections c ON c.id = ce.collection_id
           JOIN entries e ON e.id = ce.entry_id
          WHERE c.owner_user = $1 AND c.state <> 'merged' AND ce.source <> 'user_remove' AND ${visible('e', '$1')}
          ${NEWEST_FIRST}`,
        [userId],
      );
      const out: Record<string, EntryFact[]> = {};
      for (const row of rows) (out[row.collection_id] ??= []).push(toFact(row));
      return out;
    },

    async members(userId, ref: MemberRef) {
      let text: string;
      let params: unknown[];
      if (ref.kind === 'type') {
        text = `SELECT ${SUMMARY_COLUMNS}, 0 AS score, 'computed' AS source
                  FROM entries e
                 WHERE ${visible('e', '$1')} AND (${TYPE_PREDICATE[ref.type]})
                 ${NEWEST_FIRST}`;
        params = [userId];
      } else if (ref.kind === 'place') {
        text = `SELECT ${SUMMARY_COLUMNS}, 0 AS score, 'computed' AS source
                  FROM entries e
                 WHERE ${visible('e', '$1')} AND EXISTS (SELECT 1 FROM entry_places p WHERE p.entry_id = e.id AND p.place = ANY($2::text[]))
                 ${NEWEST_FIRST}`;
        params = [userId, ref.names];
      } else {
        text = `SELECT ${SUMMARY_COLUMNS}, ce.score, ce.source
                  FROM collection_entries ce
                  JOIN collections c ON c.id = ce.collection_id
                  JOIN entries e ON e.id = ce.entry_id
                 WHERE c.id = $2 AND c.owner_user = $1 AND ce.source <> 'user_remove' AND ${visible('e', '$1')}
                 ${NEWEST_FIRST}`;
        params = [userId, ref.id];
      }
      return (await query<SummaryDbRow>(text, params)).map(toMemberRow);
    },

    placesOf: (entryIds) => store.placesOf(entryIds),
    venuesOf: (entryIds) => store.venuesOf(entryIds),

    async chipThemes(userId, entryIds): Promise<ChipThemeRow[]> {
      const rows = await query<{ entry_id: string; id: string; name: string; parent_id: string | null; score: number | string }>(
        `SELECT ce.entry_id, c.id, c.name, c.parent_id, ce.score
           FROM collection_entries ce JOIN collections c ON c.id = ce.collection_id
          WHERE c.owner_user = $1 AND c.state = 'active' AND ce.source <> 'user_remove' AND ce.entry_id = ANY($2::text[])`,
        [userId, entryIds],
      );
      return rows.map((r) => ({ entryId: r.entry_id, id: r.id, name: r.name, parentId: r.parent_id, score: Number(r.score) }));
    },

    async chipPlaces(userId, entryIds): Promise<ChipPlaceRow[]> {
      const rows = await query<{ entry_id: string; place: string; kind: PlaceKind; n: number | string }>(
        `SELECT p.entry_id, p.place, p.kind,
                (SELECT count(DISTINCT p2.entry_id)
                   FROM entry_places p2 JOIN entries e2 ON e2.id = p2.entry_id
                  WHERE p2.place = p.place AND ${visible('e2', '$1')}) AS n
           FROM entry_places p
          WHERE p.entry_id = ANY($2::text[])`,
        [userId, entryIds],
      );
      return rows.map((r) => ({ entryId: r.entry_id, name: r.place, kind: r.kind, entries: Number(r.n) }));
    },

    async songs(userId) {
      // the journal of the user, as the Songs page aggregates it (the same keys): an administrator's journal (the anonymous posts) is not his collections
      const songs = await getUserSongs(userId, false);
      return [...songs.values()]
        .filter((song) => !song.libraryOnly)
        .map((song) => {
          const dated = song.mentions.map((m) => m.createdAt).filter((at) => Number.isFinite(timeOf(at)));
          const newest = dated.length > 0 ? dated.reduce((a, b) => (timeOf(b) > timeOf(a) ? b : a)) : (song.mentions[0]?.createdAt ?? '');
          return { key: song.songKey, at: newest };
        });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------- what the routes of the entries use

/**
 * The rows of a list of posts with the chips of the collections each is in (docs/collections.md). A failure of the collections NEVER breaks the list:
 * the rows come back with an empty list of chips and the failure is logged.
 */
export async function withCollectionChips<T extends { id: string }>(items: T[], userId: string): Promise<Array<T & { collections: CollectionChip[] }>> {
  try {
    const chips = await chipsForEntries(userId, items.map((i) => i.id), realViewSources());
    return items.map((item) => ({ ...item, collections: chips.get(item.id) ?? [] }));
  } catch (err) {
    logWarning('collections: the chips of a list of posts could not be read (the list is answered without them)', { error: err instanceof Error ? err.message : String(err) });
    return items.map((item) => ({ ...item, collections: [] }));
  }
}

/** The place and the venues of ONE post, for the post in full; null when they cannot be read (the post is answered without them, and it is logged). */
export async function placesAndVenuesOfEntry(
  entry: Pick<EntrySummaryRow, 'id' | 'sourceUrl' | 'sourcePlatform' | 'createdAt'>,
): Promise<{ places: Array<{ name: string; kind: PlaceKind }>; venues: CollectionVenue[] } | null> {
  try {
    const [places, venues] = await Promise.all([store.placesOf([entry.id]), store.venuesOf([entry.id])]);
    return {
      places: places.map((p) => ({ name: p.name, kind: p.kind })),
      venues: groupVenues(venues, new Map([[entry.id, { id: entry.id, sourceUrl: entry.sourceUrl, sourcePlatform: entry.sourcePlatform, createdAt: entry.createdAt }]])),
    };
  } catch (err) {
    logWarning('collections: the places of a post could not be read (the post is answered without them)', { entryId: entry.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Whether the post is one the user can read (his own, or shared with him): the corrections of a collection work only on those. */
export async function entryVisibleTo(userId: string, entryId: string): Promise<boolean> {
  const rows = await query(`SELECT 1 AS ok FROM entries e WHERE e.id = $2 AND ${visible('e', '$1')} LIMIT 1`, [userId, entryId]);
  return rows.length > 0;
}
