import { onRequest } from 'firebase-functions/v2/https';
import { getInstagramConfig, updateInstagramConfig, InstagramConfig } from './utils/firestore';

function maskValue(value: string | null): string | null {
  if (!value || value.length <= 4) return value;
  return '•'.repeat(value.length - 4) + value.slice(-4);
}

export const getInstagramCookies = onRequest(
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
      const config = await getInstagramConfig();
      res.json({
        sessionId: maskValue(config.sessionId),
        csrfToken: maskValue(config.csrfToken),
        dsUserId: config.dsUserId,
        enabled: config.enabled,
        hasCredentials: !!(config.sessionId && config.csrfToken && config.dsUserId)
      });
    } catch (error) {
      console.error('Errore getInstagramCookies:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);

export const updateInstagramCookies = onRequest(
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
      const updates: Partial<InstagramConfig> = {};

      if ('sessionId' in body && typeof body.sessionId === 'string') {
        updates.sessionId = body.sessionId.trim() || null;
      }
      if ('csrfToken' in body && typeof body.csrfToken === 'string') {
        updates.csrfToken = body.csrfToken.trim() || null;
      }
      if ('dsUserId' in body && typeof body.dsUserId === 'string') {
        updates.dsUserId = body.dsUserId.trim() || null;
      }
      if ('enabled' in body && typeof body.enabled === 'boolean') {
        updates.enabled = body.enabled;
      }

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'Nessun campo valido da aggiornare' });
        return;
      }

      await updateInstagramConfig(updates);
      const newConfig = await getInstagramConfig();
      res.json({
        success: true,
        config: {
          sessionId: maskValue(newConfig.sessionId),
          csrfToken: maskValue(newConfig.csrfToken),
          dsUserId: newConfig.dsUserId,
          enabled: newConfig.enabled,
          hasCredentials: !!(newConfig.sessionId && newConfig.csrfToken && newConfig.dsUserId)
        }
      });
    } catch (error) {
      console.error('Errore updateInstagramCookies:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);
