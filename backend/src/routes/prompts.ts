import type { FastifyInstance } from 'fastify';
import { getPromptsConfig, setPromptsConfig } from '../utils/db';
import { invalidateCache, getDefaultPrompts, type PromptsConfig } from '../services/promptLoader';

interface UpdatePromptRequest {
  promptId?: keyof PromptsConfig;
  template?: string;
  name?: string;
  description?: string;
}

const VALID_PROMPT_IDS: Array<keyof PromptsConfig> = ['contentAnalysis', 'telegramResponse', 'mediaAnalysis', 'enrichment'];

async function mergedPrompts(): Promise<PromptsConfig> {
  const defaults = getDefaultPrompts();
  const stored = (await getPromptsConfig()) as unknown as Partial<PromptsConfig>;
  return {
    contentAnalysis: stored.contentAnalysis || defaults.contentAnalysis,
    telegramResponse: stored.telegramResponse || defaults.telegramResponse,
    enrichment: stored.enrichment || defaults.enrichment,
    mediaAnalysis: stored.mediaAnalysis || defaults.mediaAnalysis,
  };
}

export function registerPromptsRoutes(app: FastifyInstance): void {
  app.get('/api/prompts', async () => {
    const defaults = getDefaultPrompts();
    const stored = (await getPromptsConfig()) as unknown as Partial<PromptsConfig>;
    const isDefault = Object.keys(stored || {}).length === 0;
    return { success: true, prompts: await mergedPrompts(), isDefault, defaults };
  });

  app.post<{ Body: UpdatePromptRequest }>('/api/prompts', async (req, reply) => {
    const { promptId, template, name, description } = req.body ?? {};
    if (!promptId || !VALID_PROMPT_IDS.includes(promptId)) {
      reply.code(400).send({ error: 'promptId non valido', validIds: VALID_PROMPT_IDS });
      return;
    }
    if (!template || typeof template !== 'string') {
      reply.code(400).send({ error: 'template richiesto' });
      return;
    }
    const defaults = getDefaultPrompts();
    const defaultPrompt = defaults[promptId];
    const updatedPrompt = {
      name: name || defaultPrompt.name,
      description: description || defaultPrompt.description,
      template,
      variables: defaultPrompt.variables,
      updatedAt: new Date().toISOString(),
    };
    const current = await mergedPrompts();
    await setPromptsConfig({ ...current, [promptId]: updatedPrompt } as unknown as Record<string, string>);
    invalidateCache();
    return { success: true, promptId, prompt: updatedPrompt };
  });

  app.post<{ Body: { promptId?: keyof PromptsConfig } }>('/api/prompts/reset', async (req, reply) => {
    const { promptId } = req.body ?? {};
    if (!promptId || !VALID_PROMPT_IDS.includes(promptId)) {
      reply.code(400).send({ error: 'promptId non valido', validIds: VALID_PROMPT_IDS });
      return;
    }
    const defaults = getDefaultPrompts();
    const defaultPrompt = { ...defaults[promptId], updatedAt: new Date().toISOString() };
    const current = await mergedPrompts();
    await setPromptsConfig({ ...current, [promptId]: defaultPrompt } as unknown as Record<string, string>);
    invalidateCache();
    return { success: true, promptId, prompt: defaultPrompt };
  });
}
