/**
 * The front page of the site, in sections (docs/web-home.md, spec 2026-11-10-web-look-and-feel-rethink-design.md §3.2 L1):
 *
 *   GET /api/home   { sections: [resume, songs, playlists, films] } ready to draw: the server decides what is in each (rule P),
 *                   the site draws them in the order and visibility of the user's configuration (GET /api/me/prefs, `home.sections`)
 *
 * SECURITY: the viewer is the Authelia `Remote-User` header and NOTHING else (never the query, never another header): what the Home shows
 * is what that person can read, own and shared (an admin also the anonymous ones), exactly like the lists of the site. So this path MUST
 * stay behind the `auth-family` Traefik middleware, with the other web routes: never move it under `/api/mondrop` or `/api/share` (those
 * routers bypass Authelia, `Remote-User` would become client-controlled and anyone could read the Home of anybody).
 */
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../utils/requestUser';
import { logError } from '../utils/logger';
import { buildWebHome } from '../services/webHome';
import { realWebHomeDeps } from '../services/webHomeData';

export function registerWebHomeRoute(app: FastifyInstance): void {
  app.get('/api/home', async (req, reply) => {
    // never cached: the same tab asks again after a post arrived
    reply.header('Cache-Control', 'no-store');
    const user = resolveUser(req);
    try {
      // a new set of sources for every request: nothing of one person's Home is kept for the next
      return await buildWebHome({ userId: user.id, isAdmin: user.isAdmin }, realWebHomeDeps());
    } catch (err) {
      logError('GET /api/home failed', err);
      return reply.code(500).send({ error: 'home failed' });
    }
  });
}
