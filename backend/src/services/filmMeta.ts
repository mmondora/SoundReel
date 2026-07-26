import { query } from '../utils/db';
import type { FilmMetaRecord, FilmUserMeta } from '../types';

export function filmKey(title: string, year: string | null | undefined): string {
  const t = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const y = (year ?? '').trim();
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
  };
}

const SELECT_COLS =
  'film_key, tmdb_id, genres, overview, film_cast, tmdb_score, watched, rating, score, availability';

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

  // Handle watched separately — it may be overridden by forceWatched.
  let watchedAssignment: string | null = null;
  if (patch.watched !== undefined) {
    params.push(patch.watched);
    watchedAssignment = `watched = $${params.length}`;
  }

  if (patch.rating !== undefined) {
    params.push(patch.rating);
    sets.push(`rating = $${params.length}`);
  }
  if (patch.score !== undefined) {
    params.push(patch.score);
    sets.push(`score = $${params.length}`);
  }

  // Apply watched: forceWatched wins over explicit value.
  if (forceWatched) {
    sets.push('watched = true');
  } else if (watchedAssignment !== null) {
    sets.push(watchedAssignment);
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
