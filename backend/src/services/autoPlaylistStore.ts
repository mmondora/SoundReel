/**
 * The database side of the automatic playlists (ADR-0023, migration 021). The rules are in `autoPlaylists.ts`; this only reads and writes.
 *
 * The unique indexes of the table (`uq_playlists_theme`, `uq_playlists_source_entry`) are what makes «una sola per tema» and «una per post» true
 * even when two runs overlap: an insert that collides does not fail, it hands back the playlist that is already there.
 */
import { randomUUID } from 'node:crypto';
import { pool, query } from '../utils/db';
import type { AutoPlaylistStore, NewAutoPlaylist, RunRow, ThemeRow } from './autoPlaylists';

export class PgAutoPlaylistStore implements AutoPlaylistStore {
  async getRun(entryId: string, owner: string): Promise<RunRow | null> {
    const rows = await query<{ status: string; playlist_id: string | null; reason: string | null }>(
      `SELECT status, playlist_id, reason FROM auto_playlist_runs WHERE entry_id = $1 AND owner_user = $2`,
      [entryId, owner],
    );
    if (!rows[0]) return null;
    const status = rows[0].status === 'done' || rows[0].status === 'skipped' ? rows[0].status : 'pending';
    return { status, playlistId: rows[0].playlist_id, reason: rows[0].reason };
  }

  async saveRun(entryId: string, owner: string, run: RunRow): Promise<void> {
    await query(
      `INSERT INTO auto_playlist_runs (entry_id, owner_user, status, playlist_id, reason, processed_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (entry_id, owner_user)
       DO UPDATE SET status = EXCLUDED.status, playlist_id = EXCLUDED.playlist_id, reason = EXCLUDED.reason, processed_at = now()`,
      [entryId, owner, run.status, run.playlistId, run.reason],
    );
  }

  async listThemes(owner: string): Promise<ThemeRow[]> {
    const rows = await query<{ theme_key: string; title: string; playlist_id: string | null }>(
      `SELECT theme_key, title, playlist_id FROM auto_playlist_themes WHERE owner_user = $1 ORDER BY created_at DESC`,
      [owner],
    );
    return rows.map((r) => ({ themeKey: r.theme_key, title: r.title, playlistId: r.playlist_id }));
  }

  async createPlaylist(input: NewAutoPlaylist): Promise<{ id: string; created: boolean }> {
    const id = randomUUID();
    // `ON CONFLICT DO NOTHING` covers both partial unique indexes: a second theme, or a second playlist for the same post, inserts nothing
    const inserted = await query<{ id: string }>(
      `INSERT INTO playlists (id, name, owner_user, created_at, updated_at, kind, origin, auto_kind, theme_key, source_entry_id)
       VALUES ($1, $2, $3, $4, $4, 'static', 'auto', $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [id, input.name, input.owner, input.createdAt, input.kind, input.themeKey, input.sourceEntryId],
    );
    let playlistId = inserted[0]?.id ?? null;
    const created = playlistId !== null;
    if (!playlistId) {
      const existing = await query<{ id: string }>(
        input.kind === 'theme'
          ? `SELECT id FROM playlists WHERE owner_user = $1 AND theme_key = $2 LIMIT 1`
          : `SELECT id FROM playlists WHERE owner_user = $1 AND auto_kind = 'one_off' AND source_entry_id = $2 LIMIT 1`,
        [input.owner, input.kind === 'theme' ? input.themeKey : input.sourceEntryId],
      );
      if (!existing[0]) throw new Error('auto playlist: the insert collided and nothing is there');
      playlistId = existing[0].id;
    }
    if (input.kind === 'theme' && input.themeKey) {
      await query(
        `INSERT INTO auto_playlist_themes (owner_user, theme_key, title, playlist_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (owner_user, theme_key) DO NOTHING`,
        [input.owner, input.themeKey, input.name, playlistId],
      );
    }
    return { id: playlistId, created };
  }

  async addSongs(playlistId: string, songKeys: string[], opts: { front: boolean; addedAt: Date }): Promise<number> {
    const keys = [...new Set(songKeys.map((k) => k.trim()).filter(Boolean))];
    if (keys.length === 0) return 0;
    const present = await query<{ song_key: string }>(
      `SELECT song_key FROM playlist_songs WHERE playlist_id = $1 AND song_key = ANY($2::text[])`,
      [playlistId, keys],
    );
    const have = new Set(present.map((r) => r.song_key));
    const fresh = keys.filter((k) => !have.has(k));
    if (fresh.length === 0) return 0;
    const range = await query<{ lowest: number | null; highest: number | null }>(
      `SELECT MIN(position) AS lowest, MAX(position) AS highest FROM playlist_songs WHERE playlist_id = $1`,
      [playlistId],
    );
    const lowest = range[0]?.lowest;
    const highest = range[0]?.highest;
    // in front: lower positions than every song there, in the order of the post; at the end: after the last
    const base = lowest == null || highest == null ? 0 : opts.front ? lowest - fresh.length : highest + 1;
    const result = await pool.query(
      `INSERT INTO playlist_songs (playlist_id, song_key, position, added_at)
       SELECT $1, k.song_key, $3::int + (k.n - 1)::int, $4
         FROM unnest($2::text[]) WITH ORDINALITY AS k(song_key, n)
       ON CONFLICT (playlist_id, song_key) DO NOTHING`,
      [playlistId, fresh, base, opts.addedAt],
    );
    await query(`UPDATE playlists SET updated_at = GREATEST(updated_at, $2) WHERE id = $1`, [playlistId, opts.addedAt]);
    return result.rowCount ?? 0;
  }
}
