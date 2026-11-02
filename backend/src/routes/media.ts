import type { FastifyInstance } from 'fastify';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { listEntries } from '../utils/db';
import { listEntryMediaUrls } from '../services/localMedia';
import { logError } from '../utils/logger';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';

const ENTRY_ID_RE = /^[A-Za-z0-9_-]+$/;
const FILENAME_RE = /^[A-Za-z0-9_.-]+$/;

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
};

export function registerMediaRoute(app: FastifyInstance): void {
  app.get<{ Params: { entryId: string; filename: string } }>(
    '/media/:entryId/:filename',
    async (req, reply) => {
      const { entryId, filename } = req.params;

      if (!ENTRY_ID_RE.test(entryId) || !FILENAME_RE.test(filename)) {
        reply.code(400).send({ error: 'invalid path' });
        return;
      }

      const absRoot = path.resolve(MEDIA_ROOT);
      const candidate = path.resolve(absRoot, entryId, filename);

      if (!candidate.startsWith(absRoot + path.sep)) {
        reply.code(403).send({ error: 'forbidden' });
        return;
      }

      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) {
          reply.code(404).send({ error: 'not found' });
          return;
        }
        const ext = path.extname(filename).toLowerCase();
        const mime = MIME_MAP[ext] || 'application/octet-stream';

        reply.type(mime);
        reply.header('Cache-Control', 'public, max-age=86400');
        reply.header('Content-Length', String(stat.size));
        return reply.send(createReadStream(candidate));
      } catch {
        reply.code(404).send({ error: 'not found' });
      }
    },
  );

  /**
   * Offline library: recent entries that still have at least one local media file.
   * Scans MEDIA_ROOT ∩ recent entries (not a full FS walk of 1400+ dirs on every request).
   */
  app.get<{ Querystring: { limit?: string } }>('/api/library', async (req, reply) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60)));
      const entries = await listEntries(Math.min(500, limit * 4));
      const items: Array<{
        entryId: string;
        sourceUrl: string;
        sourcePlatform: string;
        createdAt: string;
        caption: string | null;
        summary: string | null;
        videoUrl: string | null;
        audioUrl: string | null;
        thumbnailUrl: string | null;
        frameCount: number;
        slideCount: number;
      }> = [];

      for (const entry of entries) {
        if (items.length >= limit) break;
        const media = await listEntryMediaUrls(entry.id);
        if (!media) continue;
        if (!media.videoUrl && !media.audioUrl && !media.thumbnailUrl && media.frames.length === 0 && media.slides.length === 0) {
          continue;
        }
        items.push({
          entryId: entry.id,
          sourceUrl: entry.sourceUrl,
          sourcePlatform: entry.sourcePlatform,
          createdAt: entry.createdAt,
          caption: entry.caption,
          summary: entry.results.summary ?? null,
          videoUrl: media.videoUrl,
          audioUrl: media.audioUrl,
          thumbnailUrl: media.thumbnailUrl,
          frameCount: media.frames.length,
          slideCount: media.slides.length,
        });
      }

      return { items };
    } catch (err) {
      logError('GET /api/library failed', { err: String(err) });
      return reply.code(500).send({ error: 'library failed' });
    }
  });
}
