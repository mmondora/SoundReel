import type { FastifyInstance } from 'fastify';
import { pool } from '../utils/db';
import {
  listEntries,
  listEntrySummaries,
  getJournalStats,
  getEntry,
  getEntryForUser,
  updateEntry,
  deleteEntry,
  deleteAllEntries,
  appendActionLog,
  createActionLog,
  shareEntry,
  unshareEntry,
  listEntryShares,
} from '../utils/db';
import { addToPlaylist } from '../services/spotify';
import { enrichWithOpenAI } from '../services/openaiEnrich';
import { listEntryMediaUrls, preferLocalMediaUrls } from '../services/localMedia';
import { logError } from '../utils/logger';
import type { Entry } from '../types';
import { resolveUser, isFamilyUser, FAMILY_USERS } from '../utils/requestUser';

export function registerEntriesRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string; offset?: string; view?: string } }>('/api/entries', async (req) => {
    const user = resolveUser(req);
    const visibility = { userId: user.id, isAdmin: user.isAdmin };
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const view = req.query.view === 'summary' ? 'summary' : 'full';

    if (view === 'summary') {
      const { items, total } = await listEntrySummaries(limit, offset, visibility);
      return { entries: items, total, limit, offset };
    }

    const entries = await listEntries(limit, visibility);
    return Promise.all(entries.map((e) => preferLocalMediaUrls(e)));
  });

  app.get('/api/stats', async (req) => {
    const user = resolveUser(req);
    const stats = await getJournalStats({ userId: user.id, isAdmin: user.isAdmin });
    return { stats };
  });

  app.get<{ Params: { id: string } }>('/api/entries/:id', async (req, reply) => {
    const user = resolveUser(req);
    const entry = await getEntryForUser(req.params.id, user.id, user.isAdmin);
    if (!entry) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    return preferLocalMediaUrls(entry);
  });

  app.get<{ Params: { id: string } }>('/api/entries/:id/media', async (req, reply) => {
    const user = resolveUser(req);
    const entry = await getEntryForUser(req.params.id, user.id, user.isAdmin);
    if (!entry) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    const media = await listEntryMediaUrls(req.params.id);
    return media ?? {
      entryId: req.params.id,
      videoUrl: null,
      audioUrl: null,
      thumbnailUrl: null,
      frames: [],
      slides: [],
    };
  });

  app.get<{ Params: { id: string } }>('/api/entries/:id/shares', async (req, reply) => {
    const user = resolveUser(req);
    const entry = await getEntry(req.params.id);
    if (!entry || entry.ownerUser !== user.id) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    const sharedWith = await listEntryShares(entry.id);
    return { entryId: entry.id, sharedWith, family: FAMILY_USERS.filter((id) => id !== user.id) };
  });

  app.post<{ Params: { id: string }; Body: { with?: string[] } }>(
    '/api/entries/:id/share',
    async (req, reply) => {
      const user = resolveUser(req);
      if (!user.authenticated) {
        reply.code(401).send({ error: 'authentication required' });
        return;
      }
      const entry = await getEntry(req.params.id);
      if (!entry || entry.ownerUser !== user.id) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      const raw = Array.isArray(req.body?.with) ? req.body.with : [];
      const targets = raw
        .filter((u): u is string => typeof u === 'string')
        .map((u) => u.trim().toLowerCase())
        .filter((u) => isFamilyUser(u) && u !== user.id);
      const sharedWith = await shareEntry(entry.id, targets, user.id);
      await appendActionLog(entry.id, createActionLog('entry_shared', { with: targets, by: user.id }));
      return { entryId: entry.id, sharedWith };
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { with?: string } }>(
    '/api/entries/:id/share',
    async (req, reply) => {
      const user = resolveUser(req);
      if (!user.authenticated) {
        reply.code(401).send({ error: 'authentication required' });
        return;
      }
      const entry = await getEntry(req.params.id);
      if (!entry || entry.ownerUser !== user.id) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      const target = typeof req.query.with === 'string' ? req.query.with.trim().toLowerCase() : '';
      if (!target) {
        reply.code(400).send({ error: 'with is required' });
        return;
      }
      const sharedWith = await unshareEntry(entry.id, target);
      await appendActionLog(entry.id, createActionLog('entry_unshared', { with: target, by: user.id }));
      return { entryId: entry.id, sharedWith };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/entries/:id', async (req, reply) => {
    const user = resolveUser(req);
    const entry = await getEntry(req.params.id);
    if (!entry) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    // Only owner (or admin for anonymous) may delete.
    const canDelete =
      entry.ownerUser === user.id ||
      (user.isAdmin && entry.ownerUser === 'anonymous');
    if (!canDelete) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    await deleteEntry(req.params.id);
    return { success: true };
  });

  app.delete('/api/entries', async (req, reply) => {
    const user = resolveUser(req);
    if (!user.isAdmin) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    const deleted = await deleteAllEntries();
    return { success: true, deleted };
  });

  interface EnrichBody { entryId?: string; }

  app.post<{ Body: EnrichBody }>('/api/entries/enrich', async (req, reply) => {
    const user = resolveUser(req);
    const { entryId } = req.body;
    if (!entryId || typeof entryId !== 'string') {
      return reply.code(400).send({ error: 'entryId is required' });
    }

    const entry = await getEntryForUser(entryId, user.id, user.isAdmin);
    if (!entry) {
      return reply.code(404).send({ error: 'Not found' });
    }

    try {
      const enrichment = await enrichWithOpenAI(entry.results, entry.caption);
      await updateEntry(entryId, { 'results.enrichments': enrichment });
      await appendActionLog(entryId, createActionLog('manual_enrich', {
        category: enrichment.category,
        items: enrichment.items.length,
        hasVerdict: !!enrichment.verdict,
      }));
      return reply.send({ success: true, enrichment });
    } catch (err) {
      logError('manual enrich error', { entryId, err: String(err) });
      await appendActionLog(entryId, createActionLog('manual_enrich_failed', { error: String(err) }));
      return reply.code(500).send({ success: false, error: 'Enrichment failed' });
    }
  });

  // SSE stream — broadcasts on Postgres NOTIFY
  app.get('/api/entries/stream', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    const client = await pool.connect();
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch {}
    }, 25_000);

    const onNotification = (msg: { channel: string; payload?: string }): void => {
      if (msg.channel !== 'entry_changed') return;
      reply.raw.write(`event: entry_changed\ndata: ${msg.payload || '{}'}\n\n`);
    };

    try {
      client.on('notification', onNotification);
      await client.query('LISTEN entry_changed');
      reply.raw.write('event: ready\ndata: {}\n\n');

      await new Promise<void>((resolve) => {
        req.raw.on('close', () => resolve());
      });
    } finally {
      clearInterval(heartbeat);
      try { await client.query('UNLISTEN entry_changed'); } catch {}
      client.removeListener('notification', onNotification);
      client.release();
      try { reply.raw.end(); } catch {}
    }
  });

  interface AddSongToSpotifyBody {
    songIndex: number;
    spotifyUri: string;
    spotifyUrl: string;
    name: string;
    artist: string;
  }

  app.post<{ Params: { entryId: string }; Body: AddSongToSpotifyBody }>(
    '/api/entries/:entryId/songs/spotify',
    async (req, reply) => {
      const user = resolveUser(req);
      const { entryId } = req.params;
      const { songIndex, spotifyUri, spotifyUrl } = req.body;

      const entry = await getEntryForUser(entryId, user.id, user.isAdmin);
      if (!entry) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }

      const songs = entry.results.songs;
      if (songIndex < 0 || songIndex >= songs.length) {
        reply.code(409).send({ error: 'song_index_mismatch' });
        return;
      }

      const added = await addToPlaylist(spotifyUri);
      if (!added) {
        reply.code(400).send({ error: 'add_failed' });
        return;
      }

      const updatedSongs = songs.map((s, i) =>
        i === songIndex
          ? { ...s, spotifyUri, spotifyUrl, addedToPlaylist: true }
          : s
      );

      const updatedResults: Entry['results'] = { ...entry.results, songs: updatedSongs };
      await updateEntry(entryId, { results: updatedResults });

      const updated = await getEntry(entryId);
      reply.send(updated);
    }
  );
}
