import { query } from '../utils/db';
import type { NoteCategory, NoteMetaRecord } from '../types';

const CANONICAL_CATEGORIES: ReadonlySet<NoteCategory> = new Set([
  'place', 'event', 'brand', 'book', 'product', 'quote', 'person', 'other',
]);

/**
 * Any category outside the canonical 8 — including legacy/unexpected values
 * like 'note', 'link', 'service', or a missing category — collapses to
 * 'other'. Case-insensitive so upstream AI/JSONB data doesn't need to match
 * casing exactly.
 */
export function normalizeNoteCategory(raw: string | null | undefined): NoteCategory {
  const normalized = (raw ?? '').trim().toLowerCase();
  return CANONICAL_CATEGORIES.has(normalized as NoteCategory) ? (normalized as NoteCategory) : 'other';
}

export function noteKey(category: string | null | undefined, text: string): string {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${normalizeNoteCategory(category)}::${t}`;
}

interface NoteMetaRow {
  note_key: string;
  book_title: string | null;
  book_author: string | null;
  book_year: number | null;
  cover_url: string | null;
  openlibrary_url: string | null;
  place_name: string | null;
  place_display_name: string | null;
  place_lat: number | null;
  place_lon: number | null;
  osm_url: string | null;
  enriched_at: Date | null;
}

function rowToRecord(row: NoteMetaRow): NoteMetaRecord {
  return {
    noteKey: row.note_key,
    bookTitle: row.book_title,
    bookAuthor: row.book_author,
    bookYear: row.book_year,
    coverUrl: row.cover_url,
    openlibraryUrl: row.openlibrary_url,
    placeName: row.place_name,
    placeDisplayName: row.place_display_name,
    placeLat: row.place_lat,
    placeLon: row.place_lon,
    osmUrl: row.osm_url,
    enrichedAt: row.enriched_at ? row.enriched_at.toISOString() : null,
  };
}

const SELECT_COLS =
  'note_key, book_title, book_author, book_year, cover_url, openlibrary_url, ' +
  'place_name, place_display_name, place_lat, place_lon, osm_url, enriched_at';

/** Upserts only the book_* / cover_url / openlibrary_url columns — never touches place_* / osm_url. */
export async function upsertNoteEnrichment(input: {
  noteKey: string;
  bookTitle: string | null;
  bookAuthor: string | null;
  bookYear: number | null;
  coverUrl: string | null;
  openlibraryUrl: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO note_meta (note_key, book_title, book_author, book_year, cover_url, openlibrary_url, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (note_key) DO UPDATE SET
       book_title = EXCLUDED.book_title,
       book_author = EXCLUDED.book_author,
       book_year = EXCLUDED.book_year,
       cover_url = EXCLUDED.cover_url,
       openlibrary_url = EXCLUDED.openlibrary_url,
       enriched_at = now(),
       updated_at = now()`,
    [input.noteKey, input.bookTitle, input.bookAuthor, input.bookYear, input.coverUrl, input.openlibraryUrl]
  );
}

/** Upserts only the place_* / osm_url columns — never touches book_* / cover_url / openlibrary_url. */
export async function upsertPlaceEnrichment(input: {
  noteKey: string;
  placeName: string | null;
  placeDisplayName: string | null;
  placeLat: number | null;
  placeLon: number | null;
  osmUrl: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO note_meta (note_key, place_name, place_display_name, place_lat, place_lon, osm_url, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (note_key) DO UPDATE SET
       place_name = EXCLUDED.place_name,
       place_display_name = EXCLUDED.place_display_name,
       place_lat = EXCLUDED.place_lat,
       place_lon = EXCLUDED.place_lon,
       osm_url = EXCLUDED.osm_url,
       enriched_at = now(),
       updated_at = now()`,
    [input.noteKey, input.placeName, input.placeDisplayName, input.placeLat, input.placeLon, input.osmUrl]
  );
}

export async function listNoteMeta(): Promise<Map<string, NoteMetaRecord>> {
  const rows = await query<NoteMetaRow>(`SELECT ${SELECT_COLS} FROM note_meta`);
  return new Map(rows.map((r) => [r.note_key, rowToRecord(r)]));
}

/**
 * Single-row lookup, mirrors getSongMeta/getFilmMeta's per-request hot-path
 * use (TTL staleness check before firing an enrichment refresh) — cheaper
 * than `listNoteMeta()` (which loads every note).
 */
export async function getNoteMeta(key: string): Promise<NoteMetaRecord | null> {
  const rows = await query<NoteMetaRow>(`SELECT ${SELECT_COLS} FROM note_meta WHERE note_key = $1`, [key]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}
