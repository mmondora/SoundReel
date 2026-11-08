import type { FastifyInstance } from 'fastify';
import { FAMILY_USERS, FAMILY_DISPLAY, resolveUser, ANONYMOUS_USER } from '../utils/requestUser';

export function registerMeRoute(app: FastifyInstance): void {
  app.get('/api/me', async (req) => {
    const user = resolveUser(req);
    return {
      user: user.id,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      authenticated: user.authenticated,
      family: [
        ...FAMILY_USERS.map((id) => ({ id, displayName: FAMILY_DISPLAY[id] })),
        { id: ANONYMOUS_USER, displayName: 'Anonymous' },
      ],
    };
  });
}
