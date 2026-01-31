import { onRequest } from 'firebase-functions/v2/https';
import { db } from './utils/firestore';
import { logInfo, logError } from './utils/logger';
import { invalidateCache, getDefaultPrompts, type PromptsConfig } from './services/promptLoader';

interface UpdatePromptRequest {
  promptId: 'contentAnalysis' | 'telegramResponse';
  template: string;
  name?: string;
  description?: string;
}

const VALID_PROMPT_IDS: Array<keyof PromptsConfig> = ['contentAnalysis', 'telegramResponse'];

export const updatePrompt = onRequest(
  {
    region: 'europe-west1',
    cors: true
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    const { promptId, template, name, description } = req.body as UpdatePromptRequest;

    if (!promptId || !VALID_PROMPT_IDS.includes(promptId)) {
      res.status(400).json({
        error: 'promptId non valido',
        validIds: VALID_PROMPT_IDS
      });
      return;
    }

    if (!template || typeof template !== 'string') {
      res.status(400).json({ error: 'template richiesto' });
      return;
    }

    try {
      logInfo('Aggiornamento prompt', { promptId });

      const defaults = getDefaultPrompts();
      const defaultPrompt = defaults[promptId];

      const updatedPrompt = {
        name: name || defaultPrompt.name,
        description: description || defaultPrompt.description,
        template,
        variables: defaultPrompt.variables,
        updatedAt: new Date().toISOString()
      };

      await db.collection('config').doc('prompts').set(
        { [promptId]: updatedPrompt },
        { merge: true }
      );

      invalidateCache();

      logInfo('Prompt aggiornato', { promptId });

      res.json({
        success: true,
        promptId,
        prompt: updatedPrompt
      });
    } catch (error) {
      logError('Errore aggiornamento prompt', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Errore interno'
      });
    }
  }
);

export const getPrompts = onRequest(
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
      const doc = await db.collection('config').doc('prompts').get();
      const defaults = getDefaultPrompts();

      if (!doc.exists) {
        res.json({
          success: true,
          prompts: defaults,
          isDefault: true
        });
        return;
      }

      const data = doc.data() as Partial<PromptsConfig>;
      const prompts: PromptsConfig = {
        contentAnalysis: data.contentAnalysis || defaults.contentAnalysis,
        telegramResponse: data.telegramResponse || defaults.telegramResponse
      };

      res.json({
        success: true,
        prompts,
        isDefault: false
      });
    } catch (error) {
      logError('Errore lettura prompt', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Errore interno'
      });
    }
  }
);

export const resetPrompt = onRequest(
  {
    region: 'europe-west1',
    cors: true
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    const { promptId } = req.body as { promptId: keyof PromptsConfig };

    if (!promptId || !VALID_PROMPT_IDS.includes(promptId)) {
      res.status(400).json({
        error: 'promptId non valido',
        validIds: VALID_PROMPT_IDS
      });
      return;
    }

    try {
      logInfo('Reset prompt a default', { promptId });

      const defaults = getDefaultPrompts();
      const defaultPrompt = {
        ...defaults[promptId],
        updatedAt: new Date().toISOString()
      };

      await db.collection('config').doc('prompts').set(
        { [promptId]: defaultPrompt },
        { merge: true }
      );

      invalidateCache();

      res.json({
        success: true,
        promptId,
        prompt: defaultPrompt
      });
    } catch (error) {
      logError('Errore reset prompt', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Errore interno'
      });
    }
  }
);
