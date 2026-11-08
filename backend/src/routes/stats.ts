/**
 * The listening dashboard (docs/mondrop-stats.md §5) and the web player's way to report what it played.
 * Permissions (D4): everybody sees their own numbers; only the admin sees other users / everybody.
 */
import type { FastifyInstance } from 'fastify';
import { recordPlayEvents } from '../services/playEvents';
import { getListeningStats, getRecentPlays, isDay } from '../services/listeningStats';
import { describeActor, logActivity, songLabel, type Actor } from '../services/activityLog';
import { getUserSongs } from '../services/userSongs';
import { logError } from '../utils/logger';
import { FAMILY_USERS, isFamilyUser, requireUser } from '../utils/requestUser';

const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 3660;

/** Calendar day (UTC date of the shifted instant). `shiftHours` covers devices east of UTC: their "today" may be ours + 1. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface StatsQuery {
  scope?: string;
  user?: string;
  device?: string;
  from?: string;
  to?: string;
  limit?: string;
}

export function registerStatsRoutes(app: FastifyInstance): void {
  // The web player reports its sessions like the phone does (origin "web", device "web").
  app.post('/api/plays', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    try {
      const out = await recordPlayEvents(user.id, 'web', req.body);
      if (!out.ok) return reply.code(out.status).send({ error: out.error });
      if (out.result.accepted > 0) {
        const actor: Actor = { user: user.id, device: 'web', channel: 'web' };
        logActivity('device', 'plays', `${describeActor(actor)} ha inviato ${out.result.accepted} ascolti (${out.counted} contati)`, actor, {
          accepted: out.result.accepted, counted: out.counted, duplicates: out.result.duplicates, rejected: out.result.rejected.length,
        });
      }
      return out.result;
    } catch (err) {
      logError('POST /api/plays failed', { err: String(err) });
      return reply.code(500).send({ error: 'plays failed' });
    }
  });

  app.get<{ Querystring: StatsQuery }>('/api/stats/listening', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query;

    const now = Date.now();
    const to = q.to ?? dayOf(now + 14 * 3_600_000);
    // `to` is checked before the default `from` is derived from it: an unparseable day must be a 400, not a RangeError
    if (!isDay(to)) return reply.code(400).send({ error: 'invalid_period' });
    const from = q.from ?? dayOf(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS);
    if (!isDay(from) || from > to || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS > MAX_SPAN_DAYS) {
      return reply.code(400).send({ error: 'invalid_period' });
    }

    // Who: admin may look at everybody or one user; anybody else only at themselves.
    let userIds: string[] | null = [user.id];
    if (q.user !== undefined && q.user !== '' && q.user !== user.id) {
      if (!user.isAdmin) return reply.code(403).send({ error: 'forbidden' });
      if (!isFamilyUser(q.user)) return reply.code(400).send({ error: 'invalid_user' });
      userIds = [q.user];
    } else if (q.scope === 'all') {
      if (!user.isAdmin) return reply.code(403).send({ error: 'forbidden' });
      userIds = null;
    }
    const device = typeof q.device === 'string' && q.device.trim() ? q.device.trim().slice(0, 100) : null;

    try {
      const [stats, songs] = await Promise.all([
        getListeningStats({ userIds, device, from, to }),
        // the names of the songs the viewer may see (admin: everybody's)
        getUserSongs(user.id, user.isAdmin),
      ]);
      const { playedSongKeys, ...rest } = stats;
      const played = new Set(playedSongKeys);
      const artistNames = new Map<string, string>();
      for (const s of songs.values()) {
        const k = s.artist.trim().toLowerCase();
        if (k && !artistNames.has(k)) artistNames.set(k, s.artist);
      }
      return {
        ...rest,
        scope: userIds === null ? 'all' : userIds.length === 1 && userIds[0] === user.id ? 'me' : 'user',
        users: userIds ?? [...FAMILY_USERS],
        topSongs: rest.topSongs.map((t) => {
          const s = songs.get(t.songKey);
          return { ...t, title: s?.title ?? songLabel(null, t.songKey), artist: s?.artist ?? '' };
        }),
        topArtists: rest.topArtists.map((a) => ({ ...a, artist: artistNames.get(a.artist) ?? a.artist })),
        neverPlayed: [...songs.keys()].filter((k) => !played.has(k)).length,
        librarySongs: songs.size,
      };
    } catch (err) {
      logError('GET /api/stats/listening failed', { err: String(err) });
      return reply.code(500).send({ error: 'stats failed' });
    }
  });

  app.get<{ Querystring: StatsQuery }>('/api/stats/listening/recent', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query;
    let userIds: string[] | null = [user.id];
    if (q.user !== undefined && q.user !== '' && q.user !== user.id) {
      if (!user.isAdmin) return reply.code(403).send({ error: 'forbidden' });
      if (!isFamilyUser(q.user)) return reply.code(400).send({ error: 'invalid_user' });
      userIds = [q.user];
    } else if (q.scope === 'all') {
      if (!user.isAdmin) return reply.code(403).send({ error: 'forbidden' });
      userIds = null;
    }
    const device = typeof q.device === 'string' && q.device.trim() ? q.device.trim().slice(0, 100) : null;
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    try {
      const [plays, songs] = await Promise.all([getRecentPlays({ userIds, device }, limit), getUserSongs(user.id, user.isAdmin)]);
      return {
        plays: plays.map((p) => {
          const s = songs.get(p.songKey);
          return { ...p, title: s?.title ?? songLabel(null, p.songKey), artist: s?.artist ?? '' };
        }),
      };
    } catch (err) {
      logError('GET /api/stats/listening/recent failed', { err: String(err) });
      return reply.code(500).send({ error: 'recent plays failed' });
    }
  });
}
