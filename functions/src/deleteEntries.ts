import { onRequest } from 'firebase-functions/v2/https';
import { db } from './utils/firestore';
import { logInfo, logError } from './utils/logger';

export const deleteEntry = onRequest(
  {
    region: 'europe-west1',
    cors: true
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    const { entryId } = req.body as { entryId: string };

    if (!entryId) {
      res.status(400).json({ error: 'entryId richiesto' });
      return;
    }

    try {
      logInfo('Eliminazione entry', { entryId });

      await db.collection('entries').doc(entryId).delete();

      logInfo('Entry eliminata', { entryId });

      res.json({ success: true, entryId });
    } catch (error) {
      logError('Errore eliminazione entry', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Errore interno'
      });
    }
  }
);

export const deleteAllEntries = onRequest(
  {
    region: 'europe-west1',
    cors: true
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    try {
      logInfo('Eliminazione tutte le entry');

      const snapshot = await db.collection('entries').get();

      if (snapshot.empty) {
        res.json({ success: true, deleted: 0 });
        return;
      }

      const batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();

      logInfo('Tutte le entry eliminate', { count: snapshot.size });

      res.json({ success: true, deleted: snapshot.size });
    } catch (error) {
      logError('Errore eliminazione entry', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Errore interno'
      });
    }
  }
);
