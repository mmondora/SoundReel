import { randomUUID } from 'node:crypto';
import { pool } from '../utils/db';
import type { PlaylistDetail, PlaylistSummary } from '../types';
import { parseRule, ruleSummary, type DynamicRule } from './dynamicRules';

interface PlaylistRow {
  id: string;
  name: string;
  owner_user?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  song_count?: string | number;
  kind?: string | null;
  rule?: unknown;
  origin?: string | null;
  auto_kind?: string | null;
}

interface PlaylistSongRow {
  song_key: string;
  position: number;
}

export interface PlaylistVisibility {
  userId: string;
  isAdmin?: boolean;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapSummary(row: PlaylistRow): PlaylistSummary & { ownerUser?: string } {
  const dynamic = row.kind === 'dynamic';
  const parsed = dynamic ? parseRule(row.rule) : null;
  return {
    id: row.id,
    name: row.name,
    songCount: Number(row.song_count ?? 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    kind: dynamic ? 'dynamic' : 'static',
    ...(parsed?.ok ? { rule: parsed.rule, ruleSummary: ruleSummary(parsed.rule) } : {}),
    ...(row.owner_user ? { ownerUser: row.owner_user } : {}),
    ...(row.origin === 'auto' ? { origin: 'auto' as const, autoKind: row.auto_kind === 'theme' ? ('theme' as const) : ('one_off' as const) } : {}),
  };
}

function visibilityClause(isAdmin: boolean): string {
  const admin = isAdmin ? ` OR p.owner_user = 'anonymous'` : '';
  return `(
    p.owner_user = $1
    OR EXISTS (
      SELECT 1 FROM playlist_shares s
      WHERE s.playlist_id = p.id AND s.shared_with = $1
    )
    ${admin}
  )`;
}

export async function listPlaylists(visibility?: PlaylistVisibility): Promise<PlaylistSummary[]> {
  if (visibility?.userId) {
    const result = await pool.query<PlaylistRow>(
      `SELECT p.id, p.name, p.owner_user, p.created_at, p.updated_at, p.kind, p.rule, p.origin, p.auto_kind,
              COUNT(ps.song_key)::int AS song_count
         FROM playlists p
         LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
        WHERE ${visibilityClause(!!visibility.isAdmin)}
        GROUP BY p.id
        ORDER BY p.updated_at DESC`,
      [visibility.userId],
    );
    return result.rows.map(mapSummary);
  }
  const result = await pool.query<PlaylistRow>(
    `SELECT p.id, p.name, p.owner_user, p.created_at, p.updated_at, p.kind, p.rule, p.origin, p.auto_kind,
            COUNT(ps.song_key)::int AS song_count
       FROM playlists p
       LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
      GROUP BY p.id
      ORDER BY p.updated_at DESC`,
  );
  return result.rows.map(mapSummary);
}

/**
 * The first `perPlaylist` song keys of each of these playlists, in the playlist's own order: what the Home of Mondrop draws as the
 * mosaic of a cover (ADR-0020). One query for all of them. A dynamic playlist has no stored songs: the caller asks its rule.
 */
export async function firstSongKeys(playlistIds: string[], perPlaylist = 4): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (playlistIds.length === 0) return out;
  const result = await pool.query<{ playlist_id: string; song_key: string }>(
    `SELECT playlist_id, song_key
       FROM (
         SELECT playlist_id, song_key,
                ROW_NUMBER() OVER (PARTITION BY playlist_id ORDER BY position ASC, added_at ASC) AS n
           FROM playlist_songs
          WHERE playlist_id = ANY($1::text[])
       ) ranked
      WHERE n <= $2
      ORDER BY playlist_id, n`,
    [playlistIds, perPlaylist],
  );
  for (const row of result.rows) {
    const list = out.get(row.playlist_id) ?? [];
    list.push(row.song_key);
    out.set(row.playlist_id, list);
  }
  return out;
}

export async function getPlaylist(
  id: string,
  visibility?: PlaylistVisibility,
): Promise<(PlaylistDetail & { ownerUser?: string }) | null> {
  const visSql = visibility?.userId
    ? `AND ${visibilityClause(!!visibility.isAdmin)}`
    : '';
  const params: unknown[] = visibility?.userId ? [visibility.userId, id] : [id];
  const idParam = visibility?.userId ? '$2' : '$1';
  const summary = await pool.query<PlaylistRow>(
    `SELECT p.id, p.name, p.owner_user, p.created_at, p.updated_at, p.kind, p.rule, p.origin, p.auto_kind,
            COUNT(ps.song_key)::int AS song_count
       FROM playlists p
       LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
      WHERE p.id = ${idParam} ${visSql}
      GROUP BY p.id`,
    params,
  );
  if (!summary.rows[0]) return null;

  const songs = await pool.query<PlaylistSongRow>(
    `SELECT song_key, position
       FROM playlist_songs
      WHERE playlist_id = $1
      ORDER BY position ASC, added_at ASC`,
    [id],
  );

  return {
    ...mapSummary(summary.rows[0]),
    songKeys: songs.rows.map((r) => r.song_key),
  };
}

export async function createPlaylist(
  name: string,
  songKeys: string[] = [],
  ownerUser = 'mike',
): Promise<PlaylistDetail & { ownerUser: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name_required');

  const id = randomUUID();
  const owner = ownerUser.trim().toLowerCase() || 'mike';
  await pool.query(
    `INSERT INTO playlists (id, name, owner_user) VALUES ($1, $2, $3)`,
    [id, trimmed, owner],
  );

  const uniqueKeys = [...new Set(songKeys.map((k) => k.trim()).filter(Boolean))];
  for (let i = 0; i < uniqueKeys.length; i++) {
    await pool.query(
      `INSERT INTO playlist_songs (playlist_id, song_key, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (playlist_id, song_key) DO NOTHING`,
      [id, uniqueKeys[i], i],
    );
  }

  if (uniqueKeys.length) {
    await touchPlaylist(id);
  }

  const detail = await getPlaylist(id);
  if (!detail) throw new Error('create_failed');
  return { ...detail, ownerUser: owner };
}

async function assertOwner(id: string, ownerUser: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM playlists WHERE id = $1 AND owner_user = $2`,
    [id, ownerUser],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Songs are added/removed/reordered by hand only on static playlists. */
async function assertStatic(id: string): Promise<void> {
  const r = await pool.query<{ kind: string | null }>(`SELECT kind FROM playlists WHERE id = $1`, [id]);
  if (r.rows[0]?.kind === 'dynamic') throw new Error('playlist_is_dynamic');
}

export async function createDynamicPlaylist(
  name: string,
  rule: DynamicRule,
  ownerUser = 'mike',
): Promise<PlaylistDetail & { ownerUser: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name_required');
  const id = randomUUID();
  const owner = ownerUser.trim().toLowerCase() || 'mike';
  await pool.query(
    `INSERT INTO playlists (id, name, owner_user, kind, rule) VALUES ($1, $2, $3, 'dynamic', $4::jsonb)`,
    [id, trimmed, owner, JSON.stringify(rule)],
  );
  const detail = await getPlaylist(id);
  if (!detail) throw new Error('create_failed');
  return { ...detail, ownerUser: owner };
}

/** Change the rule of a dynamic playlist. null = not found / not yours; 'not_dynamic' = it is a static playlist. */
export async function updatePlaylistRule(
  id: string,
  rule: DynamicRule,
  ownerUser: string,
): Promise<PlaylistDetail | null | 'not_dynamic'> {
  if (!(await assertOwner(id, ownerUser))) return null;
  const result = await pool.query(
    `UPDATE playlists SET rule = $2::jsonb, updated_at = now() WHERE id = $1 AND kind = 'dynamic'`,
    [id, JSON.stringify(rule)],
  );
  if (!result.rowCount) return 'not_dynamic';
  return getPlaylist(id);
}

export async function renamePlaylist(
  id: string,
  name: string,
  ownerUser?: string,
): Promise<PlaylistDetail | null> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name_required');

  if (ownerUser) {
    const ok = await assertOwner(id, ownerUser);
    if (!ok) return null;
  }

  const result = await pool.query(
    `UPDATE playlists SET name = $2, updated_at = now() WHERE id = $1`,
    [id, trimmed],
  );
  if (!result.rowCount) return null;
  return getPlaylist(id);
}

export async function deletePlaylist(id: string, ownerUser?: string): Promise<boolean> {
  if (ownerUser) {
    const result = await pool.query(
      `DELETE FROM playlists WHERE id = $1 AND owner_user = $2`,
      [id, ownerUser],
    );
    return (result.rowCount ?? 0) > 0;
  }
  const result = await pool.query(`DELETE FROM playlists WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

async function touchPlaylist(id: string): Promise<void> {
  await pool.query(`UPDATE playlists SET updated_at = now() WHERE id = $1`, [id]);
}

async function nextPosition(playlistId: string): Promise<number> {
  const result = await pool.query<{ max: number | null }>(
    `SELECT MAX(position) AS max FROM playlist_songs WHERE playlist_id = $1`,
    [playlistId],
  );
  const max = result.rows[0]?.max;
  return max == null ? 0 : max + 1;
}

export async function addSongToPlaylist(
  playlistId: string,
  songKey: string,
  ownerUser?: string,
): Promise<PlaylistDetail | null> {
  const key = songKey.trim();
  if (!key) throw new Error('song_key_required');

  if (ownerUser) {
    const ok = await assertOwner(playlistId, ownerUser);
    if (!ok) return null;
  } else {
    const exists = await pool.query(`SELECT 1 FROM playlists WHERE id = $1`, [playlistId]);
    if (!exists.rowCount) return null;
  }

  await assertStatic(playlistId);
  const position = await nextPosition(playlistId);
  await pool.query(
    `INSERT INTO playlist_songs (playlist_id, song_key, position)
     VALUES ($1, $2, $3)
     ON CONFLICT (playlist_id, song_key) DO NOTHING`,
    [playlistId, key, position],
  );
  await touchPlaylist(playlistId);
  return getPlaylist(playlistId);
}

/**
 * Several songs at once, for the owner of a STATIC playlist (a share that carries a playlist, ADR-0015).
 * Songs already there stay where they are and are not counted. Returns how many were really added, or `null`
 * when the playlist is not this user's (not found, or only shared with him: read-only). Throws
 * `playlist_is_dynamic` for a dynamic one, like every other by-hand edit.
 */
export async function addSongsToPlaylist(
  playlistId: string,
  songKeys: string[],
  ownerUser: string,
): Promise<number | null> {
  const keys = [...new Set(songKeys.map((k) => k.trim()).filter(Boolean))];
  if (!(await assertOwner(playlistId, ownerUser))) return null;
  await assertStatic(playlistId);
  if (keys.length === 0) return 0;
  const start = await nextPosition(playlistId);
  const result = await pool.query(
    `INSERT INTO playlist_songs (playlist_id, song_key, position)
     SELECT $1, t.k, $3::int + (t.ord - 1)::int
       FROM unnest($2::text[]) WITH ORDINALITY AS t(k, ord)
     ON CONFLICT (playlist_id, song_key) DO NOTHING
     RETURNING song_key`,
    [playlistId, keys, start],
  );
  const added = result.rowCount ?? 0;
  if (added > 0) await touchPlaylist(playlistId);
  return added;
}

export async function removeSongFromPlaylist(
  playlistId: string,
  songKey: string,
  ownerUser?: string,
): Promise<PlaylistDetail | null> {
  if (ownerUser) {
    const ok = await assertOwner(playlistId, ownerUser);
    if (!ok) return null;
  } else {
    const exists = await pool.query(`SELECT 1 FROM playlists WHERE id = $1`, [playlistId]);
    if (!exists.rowCount) return null;
  }

  await assertStatic(playlistId);
  await pool.query(
    `DELETE FROM playlist_songs WHERE playlist_id = $1 AND song_key = $2`,
    [playlistId, songKey],
  );
  await touchPlaylist(playlistId);
  return getPlaylist(playlistId);
}

export async function reorderPlaylistSongs(
  playlistId: string,
  songKeys: string[],
  ownerUser?: string,
): Promise<PlaylistDetail | null> {
  if (ownerUser) {
    const ok = await assertOwner(playlistId, ownerUser);
    if (!ok) return null;
  } else {
    const exists = await pool.query(`SELECT 1 FROM playlists WHERE id = $1`, [playlistId]);
    if (!exists.rowCount) return null;
  }

  await assertStatic(playlistId);
  const current = await pool.query<PlaylistSongRow>(
    `SELECT song_key, position FROM playlist_songs WHERE playlist_id = $1`,
    [playlistId],
  );
  const currentSet = new Set(current.rows.map((r) => r.song_key));
  const ordered = songKeys.map((k) => k.trim()).filter((k) => currentSet.has(k));
  const missing = [...currentSet].filter((k) => !ordered.includes(k));
  const finalOrder = [...ordered, ...missing];

  for (let i = 0; i < finalOrder.length; i++) {
    await pool.query(
      `UPDATE playlist_songs SET position = $3 WHERE playlist_id = $1 AND song_key = $2`,
      [playlistId, finalOrder[i], i],
    );
  }
  await touchPlaylist(playlistId);
  return getPlaylist(playlistId);
}

export async function listPlaylistShares(playlistId: string): Promise<string[]> {
  const result = await pool.query<{ shared_with: string }>(
    `SELECT shared_with FROM playlist_shares WHERE playlist_id = $1 ORDER BY shared_with`,
    [playlistId],
  );
  return result.rows.map((r) => r.shared_with);
}

export async function sharePlaylist(
  playlistId: string,
  sharedWith: string[],
  sharedBy: string,
): Promise<string[]> {
  const targets = [...new Set(sharedWith.map((u) => u.trim().toLowerCase()).filter(Boolean))];
  for (const withUser of targets) {
    await pool.query(
      `INSERT INTO playlist_shares (playlist_id, shared_with, shared_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (playlist_id, shared_with) DO NOTHING`,
      [playlistId, withUser, sharedBy],
    );
  }
  return listPlaylistShares(playlistId);
}

export async function unsharePlaylist(playlistId: string, sharedWith: string): Promise<string[]> {
  await pool.query(
    `DELETE FROM playlist_shares WHERE playlist_id = $1 AND shared_with = $2`,
    [playlistId, sharedWith.trim().toLowerCase()],
  );
  return listPlaylistShares(playlistId);
}
