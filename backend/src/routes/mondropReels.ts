/**
 * The reels of Mondrop (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md §4, contract docs/mondrop-reels.md): the posts SoundReel has analysed for the
 * person, decomposed and explained by the server, without the address of any post. Michele, 12 November: «un tab con le altre categorie sul reel … ma non il link al reel
 * ma la sua scomposizione e spiegazione».
 *
 * Auth is the Mondrop key like every `/api/mondrop/*` route (Traefik: PathPrefix `/api/mondrop` bypasses Authelia, the key is the credential); the person is the one of the
 * key and NOTHING else (the query, a header and the path never choose whose reels they are). Reads only: nothing is written, queued or recorded. A reel the person cannot read
 * is simply «not found», never «forbidden».
 */
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { logError } from '../utils/logger';
import { getReel, getReelImage, listReels, parseReelsQuery, realReelsDeps, type ReelsDeps } from '../services/mondropReels';
import { isReelId } from '../services/reelBreakdownData';
import { requireMondrop } from './mondrop';

const notFound = { error: 'not_found' } as const;
const failed = { error: 'reels_failed' } as const;

export function registerMondropReelsRoutes(app: FastifyInstance, deps: ReelsDeps = realReelsDeps): void {
  app.get<{ Querystring: Record<string, unknown> }>('/api/mondrop/reels', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    const parsed = parseReelsQuery(req.query);
    if (!parsed.ok) return reply.code(400).send({ error: `invalid_${parsed.field}` });
    try {
      const page = await listReels(auth.userId, parsed.query, deps);
      reply.header('Cache-Control', 'no-store');
      return page;
    } catch (err) {
      logError('GET /api/mondrop/reels failed', { err: String(err) });
      return reply.code(500).send(failed);
    }
  });

  app.get<{ Params: { id: string } }>('/api/mondrop/reels/:id', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    if (!isReelId(req.params.id)) return reply.code(404).send(notFound);
    try {
      const detail = await getReel(auth.userId, req.params.id, deps);
      if (!detail) return reply.code(404).send(notFound);
      reply.header('Cache-Control', 'no-store');
      return detail;
    } catch (err) {
      logError('GET /api/mondrop/reels/:id failed', { id: req.params.id, err: String(err) });
      return reply.code(500).send(failed);
    }
  });

  app.get<{ Params: { id: string } }>('/api/mondrop/reels/:id/image', async (req, reply) => {
    const auth = await requireMondrop(req, reply);
    if (!auth) return;
    if (!isReelId(req.params.id)) return reply.code(404).send(notFound);
    try {
      const image = await getReelImage(auth.userId, req.params.id, deps);
      if (!image) return reply.code(404).send(notFound);
      reply
        .header('Content-Type', 'image/jpeg')
        .header('Content-Length', image.size)
        .header('Cache-Control', 'private, max-age=86400');
      // an async handler that streams must RETURN the reply, or the body goes out empty
      return reply.send(createReadStream(image.absPath));
    } catch (err) {
      logError('GET /api/mondrop/reels/:id/image failed', { id: req.params.id, err: String(err) });
      return reply.code(500).send(failed);
    }
  });
}
