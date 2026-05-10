import type { FastifyInstance } from 'fastify';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';

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
}
