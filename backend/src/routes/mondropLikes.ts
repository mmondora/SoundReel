/**
 * The likes of the songs for the app (ADR-0028, contract docs/mondrop-likes.md): the set of ONE person and an idempotent PUT and DELETE of one like.
 * Auth is the Mondrop key like every `/api/mondrop/*` route (Traefik: PathPrefix `/api/mondrop` bypasses Authelia, the key is the credential); the user is the one
 * of the key and NOTHING else (a key made by `/mondrop/connect` is bound to its person; the body, the query and the path never choose whose like it is).
 *
 * A like never fails because of its playlist: the first like of a person makes his playlist «Mi piace» (`likedPlaylist.ts`), and if that cannot be done it is a
 * warning in the log and the like stands.
 */
import type { FastifyInstance } from 'fastify';
import { logError, logWarning } from '../utils/logger';
import { PgAutoPlaylistStore } from '../services/autoPlaylistStore';
import { ensureLikedPlaylist } from '../services/likedPlaylist';
import { invalidateDynamicPlaylists } from '../services/playlistResolver';
import { likeTime, listLikes, normalizeSongKey, putLike, removeLike } from '../services/songLikes';
import { requireMondrop } from './mondrop';

const invalidKey = { error: 'invalid_song_key' } as const;
const failed = { error: 'likes_failed' } as const;

/** What the optional body of a PUT says about WHEN: anything that is not an object with a text `at` says nothing (`likeTime` ignores every value that is not a date written as text: a list's own `at` method too). */
const atOf = (body: unknown): unknown => (body && typeof body === 'object' ? (body as { at?: unknown }).at : undefined);

export function registerMondropLikesRoutes(app: FastifyInstance): void {
  app.get('/api/mondrop/likes', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    try {
      const likes = await listLikes(auth.userId);
      reply.header('Cache-Control', 'no-store');
      return { user: auth.userId, total: likes.length, likes };
    } catch (err) {
      logError('GET /api/mondrop/likes failed', { err: String(err) });
      return reply.code(500).send(failed);
    }
  });

  app.put<{ Params: { songKey: string }; Body: unknown }>('/api/mondrop/songs/:songKey/like', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const songKey = normalizeSongKey(req.params.songKey);
    if (!songKey) return reply.code(400).send(invalidKey);
    const now = new Date();
    try {
      const put = await putLike(auth.userId, songKey, likeTime(atOf(req.body), now));
      if (put.created) {
        // the first like of a person makes his playlist (and every like after it finds it); a failure here must not take the like away
        try {
          await ensureLikedPlaylist(new PgAutoPlaylistStore(), { owner: auth.userId, at: now });
        } catch (err) {
          logWarning('the playlist «Mi piace» could not be made (the like stands, the next like tries again)', { user: auth.userId, err: String(err) });
        }
        invalidateDynamicPlaylists();
      }
      return { songKey, liked: true, likedAt: put.likedAt.toISOString() };
    } catch (err) {
      logError('PUT /api/mondrop/songs/:songKey/like failed', { err: String(err) });
      return reply.code(500).send(failed);
    }
  });

  app.delete<{ Params: { songKey: string } }>('/api/mondrop/songs/:songKey/like', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const songKey = normalizeSongKey(req.params.songKey);
    if (!songKey) return reply.code(400).send(invalidKey);
    try {
      if (await removeLike(auth.userId, songKey)) invalidateDynamicPlaylists();
      return { songKey, liked: false };
    } catch (err) {
      logError('DELETE /api/mondrop/songs/:songKey/like failed', { err: String(err) });
      return reply.code(500).send(failed);
    }
  });
}
