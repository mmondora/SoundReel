import type { FastifyInstance } from 'fastify';
import { getEntry, appendActionLog, createActionLog } from '../utils/db';
import { extractSongsFromUrl } from '../services/musicListExtractor';
import { resolveSongs } from '../services/songResolver';
import type { ResolvedSong } from '../services/songResolver';
import { logInfo, logError } from '../utils/logger';

interface ProcessBody { entryId?: string; }
interface ProcessReply { detected: boolean; songs: ResolvedSong[]; spooty: number; }

export function registerMusicListRoute(app: FastifyInstance): void {
  app.post<{ Body: ProcessBody }>('/api/music-list/process', async (req, reply) => {
    const { entryId } = req.body;
    if (!entryId || typeof entryId !== 'string') {
      return reply.code(400).send({ error: 'entryId is required' });
    }

    try {
      const entry = await getEntry(entryId);
      if (!entry) {
        return reply.code(404).send({ error: 'Entry not found' });
      }

      logInfo('music-list process start', { entryId, url: entry.sourceUrl });

      const extracted = await extractSongsFromUrl(entry.sourceUrl);
      if (!extracted.length) {
        await appendActionLog(entryId, createActionLog('music_list_process', {
          detected: false, songsFound: 0,
        }));
        return reply.send({ detected: false, songs: [], spooty: 0 });
      }

      const resolved = await resolveSongs(extracted);
      const spooty = resolved.filter((s) => s.sentToSpooty).length;

      await appendActionLog(entryId, createActionLog('music_list_process', {
        detected: true,
        songsFound: extracted.length,
        songsResolved: resolved.length,
        sentToSpooty: spooty,
      }));

      logInfo('music-list process done', { entryId, songsFound: extracted.length, spooty });
      const result: ProcessReply = { detected: true, songs: resolved, spooty };
      return reply.send(result);
    } catch (err) {
      logError('music-list process error', { entryId, err: String(err) });
      return reply.code(500).send({ error: 'Processing failed' });
    }
  });
}
