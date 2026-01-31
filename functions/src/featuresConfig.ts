import { onRequest } from 'firebase-functions/v2/https';
import { getFeaturesConfig, updateFeaturesConfig, FeaturesConfig } from './utils/firestore';

export const getFeatures = onRequest(
  {
    region: 'europe-west1',
    cors: true
  },
  async (req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    try {
      const config = await getFeaturesConfig();
      res.json(config);
    } catch (error) {
      console.error('Errore getFeatures:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);

export const updateFeatures = onRequest(
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
      const updates: Partial<FeaturesConfig> = req.body;

      // Validate that only allowed fields are being updated
      const allowedFields = ['cobaltEnabled', 'allowDuplicateUrls'];
      const filteredUpdates: Partial<FeaturesConfig> = {};

      for (const key of allowedFields) {
        if (key in updates) {
          (filteredUpdates as Record<string, unknown>)[key] = updates[key as keyof FeaturesConfig];
        }
      }

      if (Object.keys(filteredUpdates).length === 0) {
        res.status(400).json({ error: 'Nessun campo valido da aggiornare' });
        return;
      }

      await updateFeaturesConfig(filteredUpdates);
      const newConfig = await getFeaturesConfig();
      res.json({ success: true, config: newConfig });
    } catch (error) {
      console.error('Errore updateFeatures:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);
