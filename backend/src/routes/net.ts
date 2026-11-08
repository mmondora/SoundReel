/**
 * `GET /api/net` — is this client on the home network or on the internet? Feeds the web player's
 * "Sorgente: Auto" switch (internal → media server, external → Internet). No personal data in the answer.
 */
import type { FastifyInstance } from 'fastify';
import { classifyNetwork } from '../utils/network';

export function registerNetRoutes(app: FastifyInstance): void {
  app.get('/api/net', async (req, reply) => {
    // never cached: the same browser tab can move between Wi-Fi and mobile data
    reply.header('Cache-Control', 'no-store');
    return { network: classifyNetwork(req.headers).network };
  });
}
