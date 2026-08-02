import { query } from '../utils/db';
import type { FilmMetaRecord, FilmUserMeta, StreamingPlatformOption } from '../types';
import type { ArchiveEnrichmentResult } from './archiveEnrichment';

export function filmKey(title: string, year: string | number | null | undefined): string {
  const t = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const y = typeof year === 'string' ? year.trim() : typeof year === 'number' ? String(year) : '';
  return `${t}::${y}`;
}

interface FilmMetaRow {
  film_key: string;
  tmdb_id: number | null;
  genres: string[];
  overview: string | null;
  film_cast: string[];
  tmdb_score: string | null;
  watched: boolean;
  rating: 'fresh' | 'rotten' | null;
  score: number | null;
  availability: FilmUserMeta['availability'];
  streaming_options: StreamingPlatformOption[] | null;
  streaming_checked_at: Date | null;
  watchmode_title_id: number | null;
  ia_identifier: string | null;
  ia_title: string | null;
  ia_year: string | null;
  ia_page_url: string | null;
  ia_file_url: string | null;
  ia_checked_at: Date | null;
  ia_downloaded_path: string | null;
}

function rowToRecord(row: FilmMetaRow): FilmMetaRecord {
  return {
    filmKey: row.film_key,
    tmdbId: row.tmdb_id,
    genres: row.genres,
    overview: row.overview,
    cast: row.film_cast,
    tmdbScore: row.tmdb_score === null ? null : Number(row.tmdb_score),
    watched: row.watched,
    rating: row.rating,
    score: row.score,
    availability: row.availability ?? {},
    streamingOptions: row.streaming_options ?? null,
    streamingCheckedAt: row.streaming_checked_at ? row.streaming_checked_at.toISOString() : null,
    watchmodeTitleId: row.watchmode_title_id ?? null,
    iaIdentifier: row.ia_identifier,
    iaTitle: row.ia_title,
    iaYear: row.ia_year,
    iaPageUrl: row.ia_page_url,
    iaFileUrl: row.ia_file_url,
    iaCheckedAt: row.ia_checked_at ? row.ia_checked_at.toISOString() : null,
    iaDownloadedPath: row.ia_downloaded_path,
  };
}

const SELECT_COLS =
  'film_key, tmdb_id, genres, overview, film_cast, tmdb_score, watched, rating, score, availability, ' +
  'streaming_options, streaming_checked_at, watchmode_title_id, ' +
  'ia_identifier, ia_title, ia_year, ia_page_url, ia_file_url, ia_checked_at, ia_downloaded_path';

export async function upsertFilmEnrichment(input: {
  filmKey: string;
  tmdbId: number;
  genres: string[];
  overview: string | null;
  cast: string[];
  tmdbScore: number | null;
}): Promise<void> {
  await query(
    `INSERT INTO film_meta (film_key, tmdb_id, genres, overview, film_cast, tmdb_score)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (film_key) DO UPDATE SET
       tmdb_id = EXCLUDED.tmdb_id,
       genres = EXCLUDED.genres,
       overview = EXCLUDED.overview,
       film_cast = EXCLUDED.film_cast,
       tmdb_score = EXCLUDED.tmdb_score,
       updated_at = now()`,
    [input.filmKey, input.tmdbId, input.genres, input.overview, input.cast, input.tmdbScore]
  );
}

export async function upsertStreamingOptions(input: {
  filmKey: string;
  options: StreamingPlatformOption[];
  watchmodeTitleId: number | null; // null preserves the existing value (COALESCE)
}): Promise<void> {
  // Ensure the row exists, then apply only the streaming columns — never
  // touches user-state columns (watched/rating/score/availability).
  await query(`INSERT INTO film_meta (film_key) VALUES ($1) ON CONFLICT (film_key) DO NOTHING`, [input.filmKey]);
  await query(
    `UPDATE film_meta SET
       streaming_options = $2::jsonb,
       streaming_checked_at = now(),
       watchmode_title_id = COALESCE($3, watchmode_title_id),
       updated_at = now()
     WHERE film_key = $1`,
    [input.filmKey, JSON.stringify(input.options), input.watchmodeTitleId]
  );
}

export type FilmUserMetaPatch = Omit<Partial<FilmUserMeta>, 'availability'> & {
  availability?: Record<string, 'free' | 'paid' | 'absent' | null>;
};

export async function patchFilmUserMeta(
  key: string,
  patch: FilmUserMetaPatch
): Promise<FilmMetaRecord> {
  // Ensure the row exists, then apply only provided fields.
  await query(`INSERT INTO film_meta (film_key) VALUES ($1) ON CONFLICT (film_key) DO NOTHING`, [key]);

  const sets: string[] = [];
  const params: unknown[] = [key];

  // Determine if rating/score force watched to true.
  const forceWatched =
    (patch.rating !== undefined && patch.rating !== null) ||
    (patch.score !== undefined && patch.score !== null);

  if (patch.rating !== undefined) {
    params.push(patch.rating);
    sets.push(`rating = $${params.length}`);
  }
  if (patch.score !== undefined) {
    params.push(patch.score);
    sets.push(`score = $${params.length}`);
  }

  // Apply watched: forceWatched wins over explicit value.
  // Only push to params if we actually use the parameterized form.
  if (forceWatched) {
    sets.push('watched = true');
  } else if (patch.watched !== undefined) {
    params.push(patch.watched);
    sets.push(`watched = $${params.length}`);
  }

  if (patch.availability !== undefined) {
    // Merge per-key; explicit null removes the service key.
    const removals = Object.entries(patch.availability)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    const additions = Object.fromEntries(
      Object.entries(patch.availability).filter(([, v]) => v !== null)
    );
    params.push(JSON.stringify(additions));
    let expr = `availability || $${params.length}::jsonb`;
    for (const k of removals) {
      params.push(k);
      expr = `(${expr}) - $${params.length}`;
    }
    sets.push(`availability = ${expr}`);
  }

  sets.push('updated_at = now()');

  const rows = await query<FilmMetaRow>(
    `UPDATE film_meta SET ${sets.join(', ')} WHERE film_key = $1 RETURNING ${SELECT_COLS}`,
    params
  );
  return rowToRecord(rows[0]);
}

export async function listFilmMeta(): Promise<Map<string, FilmMetaRecord>> {
  const rows = await query<FilmMetaRow>(`SELECT ${SELECT_COLS} FROM film_meta`);
  return new Map(rows.map((r) => [r.film_key, rowToRecord(r)]));
}

/**
 * Single-row lookup, used by the analyze.ts pipeline hook to check TTL
 * staleness and reuse a cached watchmode_title_id before firing a streaming
 * refresh — cheaper than `listFilmMeta()` (which loads every film) on the
 * per-request hot path.
 */
export async function getFilmMeta(key: string): Promise<FilmMetaRecord | null> {
  const rows = await query<FilmMetaRow>(`SELECT ${SELECT_COLS} FROM film_meta WHERE film_key = $1`, [key]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Writes the Internet Archive lookup outcome. `result: null` records a
 * checked-and-not-found, so a backfill can skip re-querying it for a while.
 * Deliberately never writes ia_downloaded_path: a later re-check must not
 * erase a film already sitting on disk.
 */
export async function upsertArchiveEnrichment(input: {
  filmKey: string;
  result: ArchiveEnrichmentResult | null;
}): Promise<void> {
  await query(`INSERT INTO film_meta (film_key) VALUES ($1) ON CONFLICT (film_key) DO NOTHING`, [input.filmKey]);
  await query(
    `UPDATE film_meta SET
       ia_identifier = $2,
       ia_title = $3,
       ia_year = $4,
       ia_page_url = $5,
       ia_file_url = $6,
       ia_checked_at = now(),
       updated_at = now()
     WHERE film_key = $1`,
    [
      input.filmKey,
      input.result?.identifier ?? null,
      input.result?.title ?? null,
      input.result?.year ?? null,
      input.result?.pageUrl ?? null,
      input.result?.fileUrl ?? null,
    ]
  );
}

/** Records where a downloaded public-domain film landed on disk. */
export async function setArchiveDownloadedPath(filmKey: string, path: string | null): Promise<void> {
  await query(
    `UPDATE film_meta SET ia_downloaded_path = $2, updated_at = now() WHERE film_key = $1`,
    [filmKey, path]
  );
}
