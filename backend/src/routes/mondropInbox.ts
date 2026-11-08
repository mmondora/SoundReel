/**
 * The Mondrop inbox (ADR-0015, contract docs/mondrop-inbox.md): the notifications of the key's owner, the entries
 * shared with him, and the phones to ring. Auth is the Mondrop key like every `/api/mondrop/*` route; each route
 * touches ONLY the rows of the user the key belongs to, so another user's id is simply "not found".
 * Traefik: PathPrefix `/api/mondrop` bypasses Authelia (the key is the credential).
 */
import type { FastifyInstance } from 'fastify';
import { logError } from '../utils/logger';
import { requireMondrop } from './mondrop';
import {
  clampLimit,
  deleteItem,
  listInbox,
  listReceived,
  markAllRead,
  markRead,
  markReceivedSeen,
  toWire,
  unreadCount,
} from '../services/inbox';
import { isDeviceToken, type PushEnvironment } from '../services/apnsClient';
import { registerPushDevice, unregisterPushDevice } from '../services/pushDevices';

const notFound = { error: 'not_found' } as const;

/** An id in a path is whatever the client typed: anything that cannot be one of ours is plainly not found. */
const plausibleId = (id: string): boolean => id.length > 0 && id.length <= 100;

function parseSince(raw: unknown): { ok: true; since: Date | null } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true, since: null };
  if (typeof raw !== 'string') return { ok: false };
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? { ok: false } : { ok: true, since: new Date(ms) };
}

function parseLimit(raw: unknown): { ok: true; limit: number } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true, limit: clampLimit(undefined) };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1) return { ok: false };
  return { ok: true, limit: clampLimit(raw) };
}

export function registerMondropInboxRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { since?: unknown; limit?: unknown } }>('/api/mondrop/inbox', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const since = parseSince(req.query.since);
    if (!since.ok) return reply.code(400).send({ error: 'invalid_query', field: 'since' });
    const limit = parseLimit(req.query.limit);
    if (!limit.ok) return reply.code(400).send({ error: 'invalid_query', field: 'limit' });
    try {
      // The instant is taken BEFORE reading: the next `since` can never skip a row written while this answer was built.
      const now = new Date();
      const page = await listInbox(auth.userId, { since: since.since, limit: limit.limit }, now);
      const received = await listReceived(auth.userId, limit.limit);
      return {
        notifications: page.notifications.map(toWire),
        received,
        removedIds: page.removedIds,
        unread: await unreadCount(auth.userId, now),
        serverTime: now.toISOString(),
      };
    } catch (err) {
      logError('GET /api/mondrop/inbox failed', { err: String(err) });
      return reply.code(500).send({ error: 'inbox failed' });
    }
  });

  // Registered before the `:id` routes: `read-all` is not an id.
  app.post('/api/mondrop/inbox/read-all', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    try {
      return { ok: true, marked: await markAllRead(auth.userId) };
    } catch (err) {
      logError('POST /api/mondrop/inbox/read-all failed', { err: String(err) });
      return reply.code(500).send({ error: 'read-all failed' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/mondrop/inbox/:id/read', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    if (!plausibleId(req.params.id)) return reply.code(404).send(notFound);
    try {
      return (await markRead(auth.userId, req.params.id)) ? { ok: true } : reply.code(404).send(notFound);
    } catch (err) {
      logError('POST /api/mondrop/inbox/:id/read failed', { err: String(err) });
      return reply.code(500).send({ error: 'read failed' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/mondrop/inbox/:id', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    if (!plausibleId(req.params.id)) return reply.code(404).send(notFound);
    try {
      return (await deleteItem(auth.userId, req.params.id)) ? { ok: true } : reply.code(404).send(notFound);
    } catch (err) {
      logError('DELETE /api/mondrop/inbox/:id failed', { err: String(err) });
      return reply.code(500).send({ error: 'delete failed' });
    }
  });

  app.post<{ Params: { entryId: string } }>('/api/mondrop/received/:entryId/seen', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    if (!plausibleId(req.params.entryId)) return reply.code(404).send(notFound);
    try {
      return (await markReceivedSeen(auth.userId, req.params.entryId)) ? { ok: true } : reply.code(404).send(notFound);
    } catch (err) {
      logError('POST /api/mondrop/received/:entryId/seen failed', { err: String(err) });
      return reply.code(500).send({ error: 'seen failed' });
    }
  });

  // The phone's APNs token. Stored always; used only when the APNs key exists (ADR-0015).
  app.post<{ Body: { token?: unknown; environment?: unknown } | undefined }>('/api/mondrop/push/devices', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const token = req.body?.token;
    const environment = req.body?.environment;
    if (!isDeviceToken(token)) return reply.code(400).send({ error: 'invalid_body', field: 'token' });
    if (environment !== 'development' && environment !== 'production') {
      return reply.code(400).send({ error: 'invalid_body', field: 'environment' });
    }
    try {
      await registerPushDevice({ token: token.toLowerCase(), userId: auth.userId, environment: environment as PushEnvironment, device: auth.device });
      return { ok: true };
    } catch (err) {
      logError('POST /api/mondrop/push/devices failed', { err: String(err) });
      return reply.code(500).send({ error: 'register failed' });
    }
  });

  app.delete<{ Body: { token?: unknown } | undefined; Querystring: { token?: unknown } }>('/api/mondrop/push/devices', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const token = req.body?.token ?? req.query.token;
    if (!isDeviceToken(token)) return reply.code(400).send({ error: 'invalid_body', field: 'token' });
    try {
      // Asking to forget a token that is not his (or not there) is not an error: the result is the same.
      await unregisterPushDevice(auth.userId, token.toLowerCase());
      return { ok: true };
    } catch (err) {
      logError('DELETE /api/mondrop/push/devices failed', { err: String(err) });
      return reply.code(500).send({ error: 'unregister failed' });
    }
  });
}
