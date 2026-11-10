/**
 * The configuration of the site, per user (ADR-0026, docs/ui-prefs.md):
 *
 *   GET    /api/me/prefs   the COMPLETE configuration (what the user chose over the defaults); no user → the defaults
 *   PUT    /api/me/prefs   a partial document, checked against a closed schema, merged; answers the complete one
 *   DELETE /api/me/prefs   back to the defaults
 *
 * SECURITY: the user is the Authelia `Remote-User` header and NOTHING else (never the body, never the query): a configuration is
 * read and written only by its owner. So this path MUST stay behind the `auth-family` Traefik middleware, next to `/api/me`: never
 * move it under `/api/mondrop` or `/api/share` (those routers bypass Authelia, `Remote-User` would become client-controlled and anyone
 * could write the configuration of anybody; see routes/mondropConnect.ts).
 */
import type { FastifyInstance } from 'fastify';
import { requireUser, remoteUserFromRequest } from '../utils/requestUser';
import { logError, logWarning } from '../utils/logger';
import { defaultUiPrefs, getUiPrefs, parseUiPrefsPatch, resetUiPrefs, saveUiPrefs } from '../services/uiPrefs';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function registerUiPrefsRoutes(app: FastifyInstance): void {
  app.get('/api/me/prefs', async (req, reply) => {
    // never cached: the same tab may be read again after another device saved
    reply.header('Cache-Control', 'no-store');
    const user = remoteUserFromRequest(req);
    if (!user) return { prefs: defaultUiPrefs() };
    try {
      return { prefs: await getUiPrefs(user) };
    } catch (err) {
      // a page that cannot read its configuration still has to open: Studio, the Player at the bottom
      logWarning('GET /api/me/prefs failed (the defaults were answered)', { user, error: message(err) });
      return { prefs: defaultUiPrefs() };
    }
  });

  app.put('/api/me/prefs', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = parseUiPrefsPatch(req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    try {
      return { prefs: await saveUiPrefs(user.id, parsed.patch) };
    } catch (err) {
      logError(`PUT /api/me/prefs failed for ${user.id}`, err);
      return reply.code(500).send({ error: 'prefs_unavailable' });
    }
  });

  app.delete('/api/me/prefs', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = requireUser(req, reply);
    if (!user) return;
    try {
      return { prefs: await resetUiPrefs(user.id) };
    } catch (err) {
      logError(`DELETE /api/me/prefs failed for ${user.id}`, err);
      return reply.code(500).send({ error: 'prefs_unavailable' });
    }
  });
}
