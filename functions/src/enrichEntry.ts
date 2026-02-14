import { onRequest } from 'firebase-functions/v2/https';
import { enrichWithOpenAI } from './services/openaiEnrich';
import { getEntry, updateEntry, appendActionLog } from './utils/firestore';
import { createActionLog } from './utils/logger';
import { Logger } from './services/debugLogger';

interface EnrichRequest {
  entryId: string;
}

export const enrichEntry = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: true
  },
  async (req, res) => {
    const log = new Logger('enrichEntry');

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    const { entryId } = req.body as EnrichRequest;

    if (!entryId) {
      res.status(400).json({ error: 'entryId richiesto' });
      return;
    }

    try {
      log.setEntryId(entryId);
      log.startTimer();
      log.info('Inizio enrichment', { entryId });

      const entry = await getEntry(entryId);
      if (!entry) {
        res.status(404).json({ error: 'Entry non trovata' });
        return;
      }

      const enrichments = await enrichWithOpenAI(entry.results, entry.caption);

      log.info('Enrichment completato', {
        entryId,
        enrichmentItems: enrichments.length,
        totalLinks: enrichments.reduce((sum, item) => sum + item.links.length, 0)
      });

      await updateEntry(entryId, {
        'results.enrichments': enrichments
      });

      await appendActionLog(entryId, createActionLog('enriched', {
        provider: 'openai',
        items: enrichments.length,
        links: enrichments.reduce((sum, item) => sum + item.links.length, 0)
      }));

      res.json({
        success: true,
        enrichments
      });
    } catch (error) {
      log.error('Errore durante enrichment', error instanceof Error ? error : new Error(String(error)));
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Errore interno'
      });
    }
  }
);
