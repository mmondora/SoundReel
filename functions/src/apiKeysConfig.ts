import { onRequest } from 'firebase-functions/v2/https';
import * as crypto from 'crypto';
import { getApiKeysConfig, updateApiKeysConfig } from './utils/firestore';

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

export const getApiKeys = onRequest(
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
      const config = await getApiKeysConfig();
      res.json({
        keys: config.keys.map((key) => ({
          masked: maskKey(key),
          createdLength: key.length
        })),
        count: config.keys.length
      });
    } catch (error) {
      console.error('Errore getApiKeys:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);

export const updateApiKeys = onRequest(
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
      const { action, key } = req.body as { action: 'generate' | 'revoke'; key?: string };

      if (action === 'generate') {
        const newKey = crypto.randomBytes(32).toString('hex');
        const config = await getApiKeysConfig();
        config.keys.push(newKey);
        await updateApiKeysConfig({ keys: config.keys });
        res.json({ success: true, key: newKey });
        return;
      }

      if (action === 'revoke' && key) {
        const config = await getApiKeysConfig();
        const idx = config.keys.findIndex((k) => k === key || maskKey(k) === key);
        if (idx === -1) {
          res.status(404).json({ error: 'Key non trovata' });
          return;
        }
        config.keys.splice(idx, 1);
        await updateApiKeysConfig({ keys: config.keys });
        res.json({ success: true, remaining: config.keys.length });
        return;
      }

      res.status(400).json({ error: 'Azione non valida. Usa "generate" o "revoke".' });
    } catch (error) {
      console.error('Errore updateApiKeys:', error);
      res.status(500).json({ error: 'Errore interno' });
    }
  }
);
