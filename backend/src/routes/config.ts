import type { FastifyInstance } from 'fastify';
import {
  getFeaturesConfig,
  updateFeaturesConfig,
  getInstagramConfig,
  updateInstagramConfig,
  getOpenAIConfig,
  updateOpenAIConfig,
  getApiKeysConfig,
  updateApiKeysConfig,
  FeaturesConfig,
  InstagramConfig,
  OpenAIConfig,
  ApiKeysConfig,
} from '../utils/db';

export function registerConfigRoutes(app: FastifyInstance): void {
  app.get('/api/config/features', async () => getFeaturesConfig());
  app.post<{ Body: Partial<FeaturesConfig> }>('/api/config/features', async (req) => {
    await updateFeaturesConfig(req.body ?? {});
    return await getFeaturesConfig();
  });

  app.get('/api/config/instagram', async () => getInstagramConfig());
  app.post<{ Body: Partial<InstagramConfig> }>('/api/config/instagram', async (req) => {
    await updateInstagramConfig(req.body ?? {});
    return await getInstagramConfig();
  });

  app.get('/api/config/openai', async () => {
    const cfg = await getOpenAIConfig();
    return { ...cfg, apiKey: cfg.apiKey ? '[set]' : null };
  });
  app.post<{ Body: Partial<OpenAIConfig> }>('/api/config/openai', async (req) => {
    await updateOpenAIConfig(req.body ?? {});
    const cfg = await getOpenAIConfig();
    return { ...cfg, apiKey: cfg.apiKey ? '[set]' : null };
  });

  app.get('/api/config/api-keys', async () => getApiKeysConfig());
  app.post<{ Body: Partial<ApiKeysConfig> }>('/api/config/api-keys', async (req) => {
    await updateApiKeysConfig(req.body ?? {});
    return await getApiKeysConfig();
  });
}
