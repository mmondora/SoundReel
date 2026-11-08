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
  release_year: number | null;
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
    releaseYear: row.release_year ?? null,
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
  'song_key, deezer_id, itunes_id, genres, album, release_year, cover_url, preview_url, deezer_url, itunes_url, enriched_at, ' +
  'listened, favorite, downloaded, rating, score';

export async function upsertSongEnrichment(input: {
  songKey: string;
  deezerId: number | null;
  itunesId: number | null;
  genres: string[];
  album: string | null;
  /** Release year (ADR-0013). A provider with no year never erases one we already have. */
  releaseYear?: number | null;
  coverUrl: string | null;
  previewUrl: string | null;
  deezerUrl: string | null;
  itunesUrl: string | null;
}): Promise<void> {
  // `release_year_checked_at` is set whenever a provider was asked, even if it had no year: the one-off
  // background pass (services/releaseYearBackfill.ts) then never asks about this song again.
  await query(
    `INSERT INTO song_meta (song_key, deezer_id, itunes_id, genres, album, release_year, release_year_checked_at, cover_url, preview_url, deezer_url, itunes_url, enriched_at)
     VALUES ($1, $2, $3, $4, $5, $10, now(), $6, $7, $8, $9, now())
     ON CONFLICT (song_key) DO UPDATE SET
       deezer_id = EXCLUDED.deezer_id,
       itunes_id = EXCLUDED.itunes_id,
       genres = EXCLUDED.genres,
       album = EXCLUDED.album,
       release_year = COALESCE(EXCLUDED.release_year, song_meta.release_year),
       release_year_checked_at = now(),
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
      input.releaseYear ?? null,
    ]
  );
}

/** Songs a provider was already asked about for their release year (even if it had none). */
export async function listReleaseYearChecked(): Promise<Set<string>> {
  const rows = await query<{ song_key: string }>(`SELECT song_key FROM song_meta WHERE release_year_checked_at IS NOT NULL`);
  return new Set(rows.map((r) => r.song_key));
}

/**
 * Records the outcome of a year lookup for ONE song and touches nothing else: no cover, genre or link (a song that is
 * already enriched must not be rewritten just to get a year), no user state. A null year never erases a year we have,
 * but the song is marked as checked either way, so the one-off pass never asks about it twice.
 */
export async function setReleaseYear(key: string, year: number | null): Promise<void> {
  await query(
    `INSERT INTO song_meta (song_key, release_year, release_year_checked_at) VALUES ($1, $2, now())
     ON CONFLICT (song_key) DO UPDATE SET
       release_year = COALESCE(EXCLUDED.release_year, song_meta.release_year),
       release_year_checked_at = now(),
       updated_at = now()`,
    [key, year],
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

/**
 * Persist a cover/album for a song only if we don't have one yet (never clobber
 * Deezer/iTunes enrichment). Used when a song first arrives via a Spotify link.
 */
export async function setSongCoverIfMissing(
  key: string,
  coverUrl: string | null,
  album: string | null,
): Promise<void> {
  if (!coverUrl && !album) return;
  await query(
    `INSERT INTO song_meta (song_key, cover_url, album) VALUES ($1, $2, $3)
     ON CONFLICT (song_key) DO UPDATE SET
       cover_url = COALESCE(song_meta.cover_url, EXCLUDED.cover_url),
       album = COALESCE(song_meta.album, EXCLUDED.album),
       updated_at = now()`,
    [key, coverUrl, album],
  );
}
