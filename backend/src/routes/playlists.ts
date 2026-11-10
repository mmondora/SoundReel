import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  addSongToPlaylist,
  createDynamicPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  listPlaylistShares,
  removeSongFromPlaylist,
  renamePlaylist,
  reorderPlaylistSongs,
  sharePlaylist,
  unsharePlaylist,
  updatePlaylistRule,
} from '../services/playlists';
import { parseRule, PRESETS, ruleSummary } from '../services/dynamicRules';
import { applyPlaylistList, parsePlaylistListQuery } from '../services/playlistList';
import { invalidateDynamicPlaylists, resolveDetail, resolveSummaries } from '../services/playlistResolver';
import { getUserSongs } from '../services/userSongs';
import { logActivity, songLabel, type Actor } from '../services/activityLog';
import { logError } from '../utils/logger';
import { resolveUser, isFamilyUser, FAMILY_USERS, type RequestUser } from '../utils/requestUser';

interface NameBody { name?: string }
interface SongBody { songKey?: string; songKeys?: string[] }
interface CreateBody extends NameBody, SongBody { kind?: string; rule?: unknown }
interface PatchBody extends NameBody { rule?: unknown }
interface ReorderBody { songKeys?: string[] }
interface ShareBody { with?: string[] }

const actorOf = (user: RequestUser): Actor => ({ user: user.id, channel: 'web' });
const who = (user: RequestUser): string => user.id;

/** "White Flag – Bishop Briggs" for the log line; falls back to the key, never throws. */
async function labelFor(songKey: string, user: RequestUser): Promise<string> {
  try {
    return songLabel((await getUserSongs(user.id, user.isAdmin)).get(songKey), songKey);
  } catch {
    return songLabel(null, songKey);
  }
}

/** Songs are put in / taken out / reordered by hand only on static playlists. */
function isDynamicRefusal(err: unknown, reply: FastifyReply): FastifyReply | null {
  return String(err).includes('playlist_is_dynamic') ? reply.code(409).send({ error: 'playlist_is_dynamic' }) : null;
}

export function registerPlaylistsRoutes(app: FastifyInstance): void {
  // The list as the person asks for it (ADR-0023): `q`, `filter`, `sort`, `order`, `limit`, `offset`. With none of them: every playlist,
  // as before, plus `total`.
  app.get('/api/playlists', async (req, reply) => {
    const parsed = parsePlaylistListQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      const user = resolveUser(req);
      const playlists = await listPlaylists({ userId: user.id, isAdmin: user.isAdmin });
      const resolved = await resolveSummaries(playlists, { userId: user.id, isAdmin: user.isAdmin });
      const { items, total } = applyPlaylistList(resolved, parsed.query, user.id);
      return reply.send({ playlists: items, total, limit: parsed.query.limit, offset: parsed.query.offset });
    } catch (err) {
      logError('GET /api/playlists failed', { err: String(err) });
      return reply.code(500).send({ error: 'playlists list failed' });
    }
  });

  // Ready-made rules for the "new dynamic playlist" form (night, morning, weekend…).
  app.get('/api/playlists/dynamic/presets', async () => ({ presets: PRESETS.map((p) => ({ ...p, ruleSummary: ruleSummary(p.rule) })) }));

  app.get<{ Params: { id: string } }>('/api/playlists/:id', async (req, reply) => {
    try {
      const user = resolveUser(req);
      const found = await getPlaylist(req.params.id, { userId: user.id, isAdmin: user.isAdmin });
      if (!found) return reply.code(404).send({ error: 'playlist not found' });
      const playlist = await resolveDetail(found, { userId: user.id, isAdmin: user.isAdmin });
      return reply.send({ playlist });
    } catch (err) {
      logError('GET /api/playlists/:id failed', { id: req.params.id, err: String(err) });
      return reply.code(500).send({ error: 'playlist get failed' });
    }
  });

  app.post<{ Body: CreateBody }>('/api/playlists', async (req, reply) => {
    const name = req.body?.name;
    if (typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'name is required' });
    }
    const kind = req.body?.kind ?? 'static';
    if (kind !== 'static' && kind !== 'dynamic') return reply.code(400).send({ error: 'invalid_kind' });
    try {
      const user = resolveUser(req);
      if (kind === 'dynamic') {
        const parsed = parseRule(req.body?.rule);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        const created = await createDynamicPlaylist(name, parsed.rule, user.id);
        logActivity('playlist', 'create', `${who(user)} ha creato la playlist dinamica «${created.name}»: ${ruleSummary(parsed.rule)}`, actorOf(user), {
          playlistId: created.id, name: created.name, kind: 'dynamic', rule: parsed.rule,
        });
        const playlist = await resolveDetail(created, { userId: user.id, isAdmin: user.isAdmin });
        return reply.code(201).send({ playlist });
      }
      const songKeys = Array.isArray(req.body?.songKeys)
        ? req.body.songKeys.filter((k): k is string => typeof k === 'string')
        : [];
      const playlist = await createPlaylist(name, songKeys, user.id);
      logActivity(
        'playlist', 'create',
        `${who(user)} ha creato la playlist «${playlist.name}»${songKeys.length ? ` con ${songKeys.length} brani` : ''}`,
        actorOf(user),
        { playlistId: playlist.id, name: playlist.name, kind: 'static', songs: songKeys.length },
      );
      return reply.code(201).send({ playlist });
    } catch (err) {
      if (String(err).includes('name_required')) {
        return reply.code(400).send({ error: 'name is required' });
      }
      logError('POST /api/playlists failed', { err: String(err) });
      return reply.code(500).send({ error: 'playlist create failed' });
    }
  });

  app.patch<{ Params: { id: string }; Body: PatchBody }>('/api/playlists/:id', async (req, reply) => {
    const name = req.body?.name;
    const hasName = typeof name === 'string' && name.trim().length > 0;
    const hasRule = req.body?.rule !== undefined;
    if (!hasName && !hasRule) {
      return reply.code(400).send({ error: name !== undefined ? 'name is required' : 'name_or_rule_required' });
    }
    try {
      const user = resolveUser(req);
      let current = await getPlaylist(req.params.id, { userId: user.id, isAdmin: user.isAdmin });

      if (hasRule) {
        const parsed = parseRule(req.body.rule);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        const updated = await updatePlaylistRule(req.params.id, parsed.rule, user.id);
        if (updated === null) return reply.code(404).send({ error: 'playlist not found' });
        if (updated === 'not_dynamic') return reply.code(409).send({ error: 'playlist_is_static' });
        invalidateDynamicPlaylists();
        logActivity('playlist', 'rule_update', `${who(user)} ha cambiato la regola di «${updated.name}»: ${ruleSummary(parsed.rule)}`, actorOf(user), {
          playlistId: updated.id, name: updated.name, rule: parsed.rule,
        });
        current = updated;
      }
      if (hasName) {
        const before = current?.name;
        const renamed = await renamePlaylist(req.params.id, name as string, user.id);
        if (!renamed) return reply.code(404).send({ error: 'playlist not found' });
        if (before !== renamed.name) {
          logActivity('playlist', 'rename', `${who(user)} ha rinominato la playlist «${before ?? '?'}» in «${renamed.name}»`, actorOf(user), {
            playlistId: renamed.id, from: before ?? null, to: renamed.name,
          });
        }
        current = renamed;
      }
      if (!current) return reply.code(404).send({ error: 'playlist not found' });
      return reply.send({ playlist: await resolveDetail(current, { userId: user.id, isAdmin: user.isAdmin }) });
    } catch (err) {
      if (String(err).includes('name_required')) return reply.code(400).send({ error: 'name is required' });
      logError('PATCH /api/playlists/:id failed', { id: req.params.id, err: String(err) });
      return reply.code(500).send({ error: 'playlist rename failed' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/playlists/:id', async (req, reply) => {
    try {
      const user = resolveUser(req);
      const before = await getPlaylist(req.params.id, { userId: user.id, isAdmin: user.isAdmin });
      const ok = await deletePlaylist(req.params.id, user.id);
      if (!ok) return reply.code(404).send({ error: 'playlist not found' });
      invalidateDynamicPlaylists();
      logActivity(
        'playlist', 'delete',
        `${who(user)} ha eliminato la playlist «${before?.name ?? req.params.id}»${before && before.kind !== 'dynamic' ? ` (${before.songCount} brani)` : ''}`,
        actorOf(user),
        { playlistId: req.params.id, name: before?.name ?? null, kind: before?.kind ?? 'static', songs: before?.songCount ?? null },
      );
      return reply.send({ ok: true });
    } catch (err) {
      logError('DELETE /api/playlists/:id failed', { id: req.params.id, err: String(err) });
      return reply.code(500).send({ error: 'playlist delete failed' });
    }
  });

  app.post<{ Params: { id: string }; Body: SongBody }>('/api/playlists/:id/songs', async (req, reply) => {
    const songKey = req.body?.songKey;
    if (typeof songKey !== 'string' || !songKey.trim()) {
      return reply.code(400).send({ error: 'songKey is required' });
    }
    try {
      const user = resolveUser(req);
      const playlist = await addSongToPlaylist(req.params.id, songKey, user.id);
      if (!playlist) return reply.code(404).send({ error: 'playlist not found' });
      logActivity('playlist', 'add_song', `${who(user)} ha aggiunto «${await labelFor(songKey, user)}» alla playlist «${playlist.name}»`, actorOf(user), {
        playlistId: playlist.id, name: playlist.name, songKey, songs: playlist.songKeys.length,
      });
      return reply.send({ playlist });
    } catch (err) {
      const refused = isDynamicRefusal(err, reply);
      if (refused) return refused;
      logError('POST /api/playlists/:id/songs failed', { id: req.params.id, err: String(err) });
      return reply.code(500).send({ error: 'playlist add song failed' });
    }
  });

  app.delete<{ Params: { id: string; songKey: string } }>(
    '/api/playlists/:id/songs/:songKey',
    async (req, reply) => {
      try {
        const user = resolveUser(req);
        const playlist = await removeSongFromPlaylist(
          req.params.id,
          req.params.songKey, // the router has already decoded it; decoding again breaks keys that contain '%'
          user.id,
        );
        if (!playlist) return reply.code(404).send({ error: 'playlist not found' });
        logActivity('playlist', 'remove_song', `${who(user)} ha tolto «${await labelFor(req.params.songKey, user)}» dalla playlist «${playlist.name}»`, actorOf(user), {
          playlistId: playlist.id, name: playlist.name, songKey: req.params.songKey, songs: playlist.songKeys.length,
        });
        return reply.send({ playlist });
      } catch (err) {
        const refused = isDynamicRefusal(err, reply);
        if (refused) return refused;
        logError('DELETE /api/playlists/:id/songs/:songKey failed', {
          id: req.params.id,
          err: String(err),
        });
        return reply.code(500).send({ error: 'playlist remove song failed' });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: ReorderBody }>(
    '/api/playlists/:id/songs',
    async (req, reply) => {
      const songKeys = req.body?.songKeys;
      if (!Array.isArray(songKeys) || !songKeys.every((k) => typeof k === 'string')) {
        return reply.code(400).send({ error: 'songKeys array is required' });
      }
      try {
        const user = resolveUser(req);
        const playlist = await reorderPlaylistSongs(req.params.id, songKeys, user.id);
        if (!playlist) return reply.code(404).send({ error: 'playlist not found' });
        logActivity('playlist', 'reorder', `${who(user)} ha riordinato la playlist «${playlist.name}» (${playlist.songKeys.length} brani)`, actorOf(user), {
          playlistId: playlist.id, name: playlist.name, songs: playlist.songKeys.length,
        });
        return reply.send({ playlist });
      } catch (err) {
        const refused = isDynamicRefusal(err, reply);
        if (refused) return refused;
        logError('PUT /api/playlists/:id/songs failed', { id: req.params.id, err: String(err) });
        return reply.code(500).send({ error: 'playlist reorder failed' });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/playlists/:id/shares', async (req, reply) => {
    const user = resolveUser(req);
    const playlist = await getPlaylist(req.params.id, { userId: user.id, isAdmin: user.isAdmin });
    if (!playlist || playlist.ownerUser !== user.id) {
      return reply.code(404).send({ error: 'playlist not found' });
    }
    const sharedWith = await listPlaylistShares(playlist.id);
    return {
      playlistId: playlist.id,
      sharedWith,
      family: FAMILY_USERS.filter((id) => id !== user.id),
    };
  });

  app.post<{ Params: { id: string }; Body: ShareBody }>('/api/playlists/:id/share', async (req, reply) => {
    const user = resolveUser(req);
    if (!user.authenticated) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    const playlist = await getPlaylist(req.params.id);
    if (!playlist || playlist.ownerUser !== user.id) {
      return reply.code(404).send({ error: 'playlist not found' });
    }
    const raw = Array.isArray(req.body?.with) ? req.body.with : [];
    const targets = raw
      .filter((u): u is string => typeof u === 'string')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => isFamilyUser(u) && u !== user.id);
    const sharedWith = await sharePlaylist(playlist.id, targets, user.id);
    if (targets.length > 0) {
      logActivity('playlist', 'share', `${who(user)} ha condiviso «${playlist.name}» con ${targets.join(', ')}`, actorOf(user), {
        playlistId: playlist.id, name: playlist.name, with: targets, sharedWith,
      });
    }
    return { playlistId: playlist.id, sharedWith };
  });

  app.delete<{ Params: { id: string }; Querystring: { with?: string } }>(
    '/api/playlists/:id/share',
    async (req, reply) => {
      const user = resolveUser(req);
      if (!user.authenticated) {
        return reply.code(401).send({ error: 'authentication required' });
      }
      const playlist = await getPlaylist(req.params.id);
      if (!playlist || playlist.ownerUser !== user.id) {
        return reply.code(404).send({ error: 'playlist not found' });
      }
      const target = typeof req.query.with === 'string' ? req.query.with.trim().toLowerCase() : '';
      if (!target) return reply.code(400).send({ error: 'with is required' });
      const sharedWith = await unsharePlaylist(playlist.id, target);
      logActivity('playlist', 'unshare', `${who(user)} ha smesso di condividere «${playlist.name}» con ${target}`, actorOf(user), {
        playlistId: playlist.id, name: playlist.name, with: target, sharedWith,
      });
      return { playlistId: playlist.id, sharedWith };
    },
  );
}
