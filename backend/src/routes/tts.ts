import type { FastifyInstance } from 'fastify';
import { TtsHttpError } from '../services/ttsClient';
import {
  enqueueTtsJob,
  getReadingProgress,
  getTtsJob,
  putReadingProgress,
  renderTtsSync,
} from '../services/ttsRender';

type RenderBody = {
  text?: string;
  voice?: string;
  speed?: number;
  localOnly?: boolean;
  bookKey?: string;
  chapterId?: string;
  /** If true, return pending job immediately and synthesize in background. */
  async?: boolean;
};

export function registerTtsRoutes(app: FastifyInstance): void {
  app.post<{ Body: RenderBody }>('/api/tts/render', async (req, reply) => {
    const text = req.body?.text;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({ error: 'text required' });
    }

    const payload = {
      text: text.trim(),
      voice: req.body?.voice,
      speed: req.body?.speed,
      localOnly: !!req.body?.localOnly,
      bookKey: req.body?.bookKey,
      chapterId: req.body?.chapterId,
    };

    if (req.body?.async) {
      const job = enqueueTtsJob(payload);
      return reply.code(202).send({ status: 'pending', jobId: job.id });
    }

    try {
      const ready = await renderTtsSync(payload);
      return ready;
    } catch (err) {
      if (err instanceof TtsHttpError) {
        return reply.code(err.status >= 400 && err.status < 600 ? err.status : 502).send({
          status: 'error',
          error: err.message,
          body: (() => {
            try {
              return JSON.parse(err.body);
            } catch {
              return err.body;
            }
          })(),
        });
      }
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (typeof statusCode === 'number') {
        return reply.code(statusCode).send({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return reply.code(500).send({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get<{ Params: { id: string } }>('/api/tts/jobs/:id', async (req, reply) => {
    const job = getTtsJob(req.params.id);
    if (!job) {
      return reply.code(404).send({ error: 'job not found' });
    }
    return job;
  });

  app.get<{ Params: { itemKey: string } }>('/api/reading-progress/:itemKey', async (req, reply) => {
    try {
      const progress = await getReadingProgress(req.params.itemKey);
      if (!progress) {
        return reply.code(404).send({ error: 'not found' });
      }
      return progress;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(statusCode).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put<{
    Params: { itemKey: string };
    Body: { positionSec?: number; durationSec?: number | null };
  }>('/api/reading-progress/:itemKey', async (req, reply) => {
    try {
      if (typeof req.body?.positionSec !== 'number') {
        return reply.code(400).send({ error: 'positionSec required' });
      }
      return await putReadingProgress(req.params.itemKey, {
        positionSec: req.body.positionSec,
        durationSec: req.body.durationSec,
      });
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(statusCode).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
