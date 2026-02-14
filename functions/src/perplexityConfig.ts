import { onRequest } from 'firebase-functions/v2/https';
import { getPerplexityConfig, updatePerplexityConfig, PerplexityConfig } from './utils/firestore';

function maskValue(value: string | null): string | null {
  if (!value || value.length <= 8) return value ? '••••••••' : null;
  return '•'.repeat(value.length - 4) + value.slice(-4);
}

export const getPerplexity = onRequest(
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
      const config = await getPerplexityConfig();
      res.json({
        apiKey: maskValue(config.apiKey),
        enabled: config.enabled,
        hasKey: !!config.apiKey
      });
    } catch (error) {
      console.error('Errore getPerplexity:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);

export const updatePerplexity = onRequest(
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
      const body = req.body;
      const updates: Partial<PerplexityConfig> = {};

      if ('apiKey' in body && typeof body.apiKey === 'string') {
        updates.apiKey = body.apiKey.trim() || null;
      }
      if ('enabled' in body && typeof body.enabled === 'boolean') {
        updates.enabled = body.enabled;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'Nessun campo valido da aggiornare' });
        return;
      }

      await updatePerplexityConfig(updates);
      const newConfig = await getPerplexityConfig();
      res.json({
        success: true,
        config: {
          apiKey: maskValue(newConfig.apiKey),
          enabled: newConfig.enabled,
          hasKey: !!newConfig.apiKey
        }
      });
    } catch (error) {
      console.error('Errore updatePerplexity:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);
