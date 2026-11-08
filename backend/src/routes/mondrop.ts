/**
 * Mondrop mobile API — auth via X-SoundReel-Key (same as /api/share).
 * Traefik: PathPrefix `/api/mondrop` bypass Authelia (see geekom-hub routers).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { normalizeFamilyUser, ANONYMOUS_USER } from '../utils/requestUser';
import { classifyNetwork } from '../utils/network';
import { listPlaylists, getPlaylist } from '../services/playlists';
import { resolveDetail, resolveSummaries } from '../services/playlistResolver';
import {
  buildPlaylistOfflineManifest,
  enqueueSongToSpooty,
  getTrack,
  preparePlaylist,
  requestSongDownload,
  resolveEntryMediaAbs,
  ORDER_MONDROP,
  resolveSongServing,
  setSongSource,
} from '../services/offlineManifest';
import { logError } from '../utils/logger';
import { describeActor, formatBytes, logActivity, shouldLogOnce, songLabel, type Actor } from '../services/activityLog';
import { serveSong } from '../services/songStream';
import { recordPlayEvents } from '../services/playEvents';
import { recordDeviceEvents } from '../services/deviceEvents';

interface MondropCaller {
  userId: string;
  /** Label of the device the key was issued for ("iPhone di Michele"); '' for legacy keys without one. */
  device: string;
}

const callerActor = (c: MondropCaller): Actor => ({ user: c.userId, device: c.device || null, channel: 'mondrop' });

async function requireMondrop(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<MondropCaller | null> {
  const auth = await authenticateApiKey(req.headers['x-soundreel-key']);
  if (!auth) {
    reply.code(401).send({ error: 'invalid or missing X-SoundReel-Key' });
    return null;
  }
  // Key issued via /mondrop/connect → its Authelia user wins over client-supplied user hints.
  if (auth.owner) {
    return { userId: normalizeFamilyUser(auth.owner.user) ?? ANONYMOUS_USER, device: auth.owner.device ?? '' };
  }
  const bodyUser =
    typeof (req.body as { user?: string } | undefined)?.user === 'string'
      ? (req.body as { user: string }).user
      : null;
  const qUser = typeof (req.query as { user?: string }).user === 'string'
    ? (req.query as { user: string }).user
    : null;
  const headerUser = typeof req.headers['x-soundreel-user'] === 'string'
    ? req.headers['x-soundreel-user']
    : null;
  const userId =
    normalizeFamilyUser(headerUser) ??
    normalizeFamilyUser(qUser) ??
    normalizeFamilyUser(bodyUser) ??
    ANONYMOUS_USER;
  // Legacy keys carry no device: the app may say which one it is.
  const headerDevice = req.headers['x-soundreel-device'];
  const device = typeof headerDevice === 'string' ? headerDevice.trim().slice(0, 100) : '';
  return { userId, device };
}

async function sendFileRange(
  reply: FastifyReply,
  req: FastifyRequest,
  absPath: string,
  filename: string,
  contentType: string,
  version?: string,
): Promise<FastifyReply> {
  const { size } = await stat(absPath);
  reply
    .header('Accept-Ranges', 'bytes')
    .header('Content-Type', contentType)
    .header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);

  if (version) {
    // The same identity the manifest calls `version`: a client that has it can skip the transfer.
    const etag = `"${version}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag && !req.headers.range) {
      return reply.code(304).send();
    }
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = size - 1;
  if (range && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') {
      start = Math.max(0, size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= size) {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    }
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  const stream = createReadStream(absPath, { start, end });
  return reply.header('Content-Length', end - start + 1).send(stream);
}

export function registerMondropRoutes(app: FastifyInstance): void {
  app.get('/api/mondrop/playlists', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    try {
      const viewer = { userId: auth.userId, isAdmin: false };
      // dynamic playlists come with their rule summary and the count of what the rule selects now (docs/mondrop-stats.md §4)
      const playlists = await resolveSummaries(await listPlaylists(viewer), viewer);
      return { playlists, user: auth.userId };
    } catch (err) {
      logError('GET /api/mondrop/playlists failed', { err: String(err) });
      return reply.code(500).send({ error: 'playlists failed' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/mondrop/playlists/:id', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const viewer = { userId: auth.userId, isAdmin: false };
    const stored = await getPlaylist(req.params.id, viewer);
    if (!stored) return reply.code(404).send({ error: 'playlist not found' });
    return { playlist: await resolveDetail(stored, viewer), user: auth.userId };
  });

  app.get<{ Params: { id: string }; Querystring: { lyrics?: string } }>(
    '/api/mondrop/playlists/:id/offline',
    async (req, reply) => {
      const auth = await requireMondrop(req, reply);
      if (!auth) return;
      try {
        // `?lyrics=0`: a client that is only polling for progress does not need the transcripts.
        const manifest = await buildPlaylistOfflineManifest(req.params.id, auth.userId, false, {
          lyrics: req.query.lyrics !== '0',
        });
        if (!manifest) return reply.code(404).send({ error: 'playlist not found' });
        if (shouldLogOnce(`manifest:${auth.userId}:${auth.device}:${req.params.id}`, 10 * 60_000)) {
          const actor = callerActor(auth);
          logActivity('sync', 'manifest', `${describeActor(actor)} ha letto «${manifest.name}»: ${manifest.readyCount} pronti su ${manifest.tracks.length}`, actor, {
            playlistId: req.params.id, name: manifest.name, total: manifest.tracks.length, ready: manifest.readyCount,
            preparing: manifest.preparingCount, failed: manifest.failedCount,
          });
        }
        return { ...manifest, user: auth.userId };
      } catch (err) {
        logError('GET /api/mondrop/playlists/:id/offline failed', { err: String(err) });
        return reply.code(500).send({ error: 'offline manifesto failed' });
      }
    },
  );

  // Sync step 1: queue every song of the playlist that is not ready (idempotent, answers at once).
  app.post<{ Params: { id: string }; Body: { retryFailed?: boolean } | undefined }>(
    '/api/mondrop/playlists/:id/prepare',
    async (req, reply) => {
      const auth = await requireMondrop(req, reply);
      if (!auth) return;
      try {
        const manifest = await preparePlaylist(req.params.id, auth.userId, false, {
          retryFailed: req.body?.retryFailed === true,
          lyrics: false,
        });
        if (!manifest) return reply.code(404).send({ error: 'playlist not found' });
        const actor = callerActor(auth);
        const retry = req.body?.retryFailed === true ? ' (riprova anche i falliti)' : '';
        logActivity(
          'sync', 'prepare',
          `${describeActor(actor)} ha avviato il sync di «${manifest.name}»${retry}: ${manifest.readyCount} pronti, ${manifest.preparingCount} in preparazione, ${manifest.failedCount} da cercare o in errore, ${manifest.tracks.length} brani`,
          actor,
          { playlistId: req.params.id, name: manifest.name, retryFailed: req.body?.retryFailed === true, total: manifest.tracks.length, ready: manifest.readyCount, preparing: manifest.preparingCount, failed: manifest.failedCount },
        );
        return { ...manifest, user: auth.userId };
      } catch (err) {
        logError('POST /api/mondrop/playlists/:id/prepare failed', { err: String(err) });
        return reply.code(500).send({ error: 'prepare failed' });
      }
    },
  );

  // One song, same object as in the manifest (first play re-checks it while the server prepares the file).
  app.get<{ Params: { songKey: string } }>('/api/mondrop/songs/:songKey', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    try {
      const track = await getTrack(req.params.songKey, auth.userId, false);
      if (!track) return reply.code(404).send({ error: 'song not found' });
      return { ...track, user: auth.userId };
    } catch (err) {
      logError('GET /api/mondrop/songs/:songKey failed', { err: String(err) });
      return reply.code(500).send({ error: 'song state failed' });
    }
  });

  // `priority: "play"` = somebody is waiting for it: it jumps the sync queue.
  app.post<{ Params: { songKey: string }; Body: { priority?: string } | undefined }>(
    '/api/mondrop/songs/:songKey/download',
    async (req, reply) => {
      const auth = await requireMondrop(req, reply);
      if (!auth) return;
      const priority = req.body?.priority === 'play' ? 'play' : 'sync';
      try {
        const track = await requestSongDownload(req.params.songKey, auth.userId, {
          priority,
          // an explicit "download this" retries a failed song; a first play only does so now and then
          retry: priority !== 'play',
        });
        if (!track) return reply.code(404).send({ ok: false, error: 'song not found' });
        const actor = callerActor(auth);
        logActivity(
          'download', 'request',
          `${describeActor(actor)} chiede «${songLabel(track, req.params.songKey)}» (priorità ${priority}) → ${track.state}`,
          actor,
          { songKey: req.params.songKey, priority, state: track.state, source: track.source },
        );
        return { ok: true, state: track.state, track };
      } catch (err) {
        logError('POST /api/mondrop/songs/:songKey/download failed', { err: String(err) });
        return reply.code(500).send({ ok: false, error: 'download request failed' });
      }
    },
  );

  // A person picks the video (wrong version, or nothing found): the song goes back in the queue.
  app.put<{ Params: { songKey: string }; Body: { youtubeUrl?: string } | undefined }>(
    '/api/mondrop/songs/:songKey/source',
    async (req, reply) => {
      const auth = await requireMondrop(req, reply);
      if (!auth) return;
      const url = typeof req.body?.youtubeUrl === 'string' ? req.body.youtubeUrl : '';
      try {
        const result = await setSongSource(req.params.songKey, auth.userId, url);
        if (!result.ok) {
          return reply.code(result.reason === 'song_not_found' ? 404 : 400).send({ ok: false, error: result.reason });
        }
        const actor = callerActor(auth);
        logActivity('download', 'override', `${describeActor(actor)} ha scelto il video YouTube per «${songLabel(null, req.params.songKey)}»`, actor, {
          songKey: req.params.songKey, youtubeUrl: url,
        });
        return { ok: true };
      } catch (err) {
        logError('PUT /api/mondrop/songs/:songKey/source failed', { err: String(err) });
        return reply.code(500).send({ ok: false, error: 'source update failed' });
      }
    },
  );

  // Listening sessions, in batches ("di tanto in tanto"). Idempotent: resending an event is safe.
  app.post('/api/mondrop/plays', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    try {
      const out = await recordPlayEvents(auth.userId, auth.device, req.body);
      if (!out.ok) return reply.code(out.status).send({ error: out.error });
      if (out.result.accepted > 0) {
        const actor = callerActor(auth);
        logActivity('device', 'plays', `${describeActor(actor)} ha inviato ${out.result.accepted} ascolti (${out.counted} contati)`, actor, {
          accepted: out.result.accepted, counted: out.counted, duplicates: out.result.duplicates, rejected: out.result.rejected.length,
        });
      }
      return out.result;
    } catch (err) {
      logError('POST /api/mondrop/plays failed', { err: String(err) });
      return reply.code(500).send({ error: 'plays failed' });
    }
  });

  // What a device did to itself (deleting downloaded songs): durable, with the full list.
  app.post('/api/mondrop/device-events', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    try {
      const out = await recordDeviceEvents(auth.userId, auth.device, req.body);
      if (!out.ok) return reply.code(out.status).send({ error: out.error });
      return out.result;
    } catch (err) {
      logError('POST /api/mondrop/device-events failed', { err: String(err) });
      return reply.code(500).send({ error: 'device events failed' });
    }
  });

  // Where the app is: at home the media server's direct URLs work, outside they do not.
  app.get('/api/mondrop/net', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const { viaCloudflare, network } = classifyNetwork(req.headers);
    return { viaCloudflare, home: network === 'internal' };
  });

  app.post<{ Params: { songKey: string } }>('/api/mondrop/songs/:songKey/spooty', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const songKey = req.params.songKey;
    const result = await enqueueSongToSpooty(songKey, auth.userId, false);
    if (!result.ok) {
      return reply.code(result.reason === 'song_not_found' ? 404 : 400).send(result);
    }
    return { ok: true, songKey };
  });

  app.get<{ Params: { songKey: string } }>('/api/mondrop/songs/:songKey/file', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const songKey = req.params.songKey;
    try {
      // Mondrop downloads to the phone and plays locally (ADR-0010: iOS only, for now): the disk first, the media
      // server's own file (proxied, Range ok) when the song is only there.
      const serving = await resolveSongServing(songKey, auth.userId, false, ORDER_MONDROP);
      if (!serving.ok) return reply.code(404).send({ error: 'file not ready' });
      const { served } = serving;
      const range = req.headers.range;
      const logIt = (!range || /^bytes=0-/.test(range)) && shouldLogOnce(`file:${auth.userId}:${auth.device}:${songKey}`, 30_000);

      const sent = await serveSong(req, reply, served.origins, { filename: served.filename, disposition: 'attachment', version: served.version });
      if (!sent) return reply.code(404).send({ error: 'file not ready' });
      if (logIt && sent.status !== 304) {
        const actor = callerActor(auth);
        const total = Number(/\/(\d+)$/.exec(String(reply.getHeader('content-range') ?? ''))?.[1] ?? reply.getHeader('content-length') ?? 0);
        logActivity('download', 'file', `${describeActor(actor)} scarica «${songLabel(served, songKey)}» (${formatBytes(total)}, dal ${sent.origin === 'media' ? 'media server' : 'disco'})`, actor, {
          songKey, bytes: total, version: served.version, range: range ?? null, origin: sent.origin,
        });
      }
      return sent.reply;
    } catch (err) {
      logError('GET /api/mondrop/songs/:songKey/file failed', { songKey, err: String(err) });
      return reply.code(500).send({ error: 'file stream failed' });
    }
  });

  app.get<{ Params: { entryId: string }; Querystring: { kind?: string } }>(
    '/api/mondrop/entries/:entryId/file',
    async (req, reply) => {
      const auth = await requireMondrop(req, reply);
      if (!auth) return;
      const kind = req.query.kind === 'video' ? 'video' : 'audio';
      try {
        const file = await resolveEntryMediaAbs(req.params.entryId, kind);
        if (!file) {
          // Try the other kind
          const alt = await resolveEntryMediaAbs(
            req.params.entryId,
            kind === 'audio' ? 'video' : 'audio',
          );
          if (!alt) return reply.code(404).send({ error: 'entry media not found' });
          return await sendFileRange(reply, req, alt.absPath, alt.filename, alt.contentType);
        }
        return await sendFileRange(reply, req, file.absPath, file.filename, file.contentType);
      } catch (err) {
        logError('GET /api/mondrop/entries/:entryId/file failed', {
          entryId: req.params.entryId,
          err: String(err),
        });
        return reply.code(500).send({ error: 'entry media stream failed' });
      }
    },
  );
}
