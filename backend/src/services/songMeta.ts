import { query } from '../utils/db';
import type { SongMetaRecord, SongUserMeta } from '../types';

export function songKey(artist: string, title: string): string {
  const a = artist.trim().toLowerCase().replace(/\s+/g, ' ');
  const t = title.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${a}::${t}`;
}

interface SongMetaRow {
  song_key: string;
  deezer_id: number | null;
  itunes_id: number | null;
  genres: string[];
  album: string | null;
  cover_url: string | null;
  preview_url: string | null;
  deezer_url: string | null;
  itunes_url: string | null;
  enriched_at: Date | null;
  listened: boolean;
  favorite: boolean;
  downloaded: boolean;
  rating: 'like' | 'dislike' | null;
  score: number | null;
}

function rowToRecord(row: SongMetaRow): SongMetaRecord {
  return {
    songKey: row.song_key,
    deezerId: row.deezer_id,
    itunesId: row.itunes_id,
    genres: row.genres,
    album: row.album,
    coverUrl: row.cover_url,
    previewUrl: row.preview_url,
    deezerUrl: row.deezer_url,
    itunesUrl: row.itunes_url,
    enrichedAt: row.enriched_at ? row.enriched_at.toISOString() : null,
    listened: row.listened,
    favorite: row.favorite,
    downloaded: row.downloaded,
    rating: row.rating,
    score: row.score,
  };
}

const SELECT_COLS =
  'song_key, deezer_id, itunes_id, genres, album, cover_url, preview_url, deezer_url, itunes_url, enriched_at, ' +
  'listened, favorite, downloaded, rating, score';

export async function upsertSongEnrichment(input: {
  songKey: string;
  deezerId: number | null;
  itunesId: number | null;
  genres: string[];
  album: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
  deezerUrl: string | null;
  itunesUrl: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO song_meta (song_key, deezer_id, itunes_id, genres, album, cover_url, preview_url, deezer_url, itunes_url, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (song_key) DO UPDATE SET
       deezer_id = EXCLUDED.deezer_id,
       itunes_id = EXCLUDED.itunes_id,
       genres = EXCLUDED.genres,
       album = EXCLUDED.album,
       cover_url = EXCLUDED.cover_url,
       preview_url = EXCLUDED.preview_url,
       deezer_url = EXCLUDED.deezer_url,
       itunes_url = EXCLUDED.itunes_url,
       enriched_at = now(),
       updated_at = now()`,
    [
      input.songKey,
      input.deezerId,
      input.itunesId,
      input.genres,
      input.album,
      input.coverUrl,
      input.previewUrl,
      input.deezerUrl,
      input.itunesUrl,
    ]
  );
}

export type SongUserMetaPatch = Partial<SongUserMeta>;

export async function patchSongUserMeta(key: string, patch: SongUserMetaPatch): Promise<SongMetaRecord> {
  // Ensure the row exists, then apply only provided fields.
  await query(`INSERT INTO song_meta (song_key) VALUES ($1) ON CONFLICT (song_key) DO NOTHING`, [key]);

  const sets: string[] = [];
  const params: unknown[] = [key];

  // Determine if rating/score force listened to true.
  const forceListened =
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

  // Apply listened: forceListened wins over explicit value.
  // Only push to params if we actually use the parameterized form.
  if (forceListened) {
    sets.push('listened = true');
  } else if (patch.listened !== undefined) {
    params.push(patch.listened);
    sets.push(`listened = $${params.length}`);
  }

  if (patch.favorite !== undefined) {
    params.push(patch.favorite);
    sets.push(`favorite = $${params.length}`);
  }

  if (patch.downloaded !== undefined) {
    params.push(patch.downloaded);
    sets.push(`downloaded = $${params.length}`);
  }

  sets.push('updated_at = now()');

  const rows = await query<SongMetaRow>(
    `UPDATE song_meta SET ${sets.join(', ')} WHERE song_key = $1 RETURNING ${SELECT_COLS}`,
    params
  );
  return rowToRecord(rows[0]);
}

export async function listSongMeta(): Promise<Map<string, SongMetaRecord>> {
  const rows = await query<SongMetaRow>(`SELECT ${SELECT_COLS} FROM song_meta`);
  return new Map(rows.map((r) => [r.song_key, rowToRecord(r)]));
}

/**
 * Single-row lookup, mirrors getFilmMeta's per-request hot-path use (e.g. TTL
 * staleness checks before firing an enrichment refresh) — cheaper than
 * `listSongMeta()` (which loads every song).
 */
export async function getSongMeta(key: string): Promise<SongMetaRecord | null> {
  const rows = await query<SongMetaRow>(`SELECT ${SELECT_COLS} FROM song_meta WHERE song_key = $1`, [key]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}
