import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  allowedRoots,
  getFolderStates,
  refreshMusicFolders,
  saveMusicFolders,
  validateFolders,
} from '../services/musicFolders';
import { requireUser } from '../utils/requestUser';
import {
  getMusicFoldersConfig,
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

  // --- Music folders searched next to the library (ADR-0011). Admin only: they decide what the backend reads. ---
  // A root that is not mounted in this container offers nothing to pick from: do not list it (the UI would invite a dead end).
  const mountedRoots = async (extraOnly: boolean) => {
    const all = allowedRoots().filter((r) => !extraOnly || !r.builtIn);
    const present = await Promise.all(all.map((r) => fs.access(r.path).then(() => true, () => false)));
    return all.filter((_, i) => present[i]);
  };

  const musicFoldersPayload = async () => {
    const roots = await mountedRoots(false);
    const states = getFolderStates();
    const configured = await getMusicFoldersConfig();
    const known = new Set(states.map((s) => s.id));
    return {
      roots: roots.map((r) => ({ path: r.path, label: r.label, builtIn: r.builtIn })),
      // the built-in library first, then each configured folder (not scanned yet = "pending")
      folders: [
        ...states,
        ...configured
          .filter((f) => !known.has(f.id))
          .map((f) => ({ ...f, builtIn: false, status: f.enabled ? 'pending' : 'off', files: 0, truncated: false, scannedAt: null })),
      ],
    };
  };

  app.get('/api/config/music-folders', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'forbidden' });
    return musicFoldersPayload();
  });

  app.post<{ Body: { folders?: unknown } | undefined }>('/api/config/music-folders', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'forbidden' });
    const checked = await validateFolders(req.body?.folders);
    if (!checked.ok) return reply.code(400).send({ error: checked.error, index: checked.index });
    await saveMusicFolders(checked.folders);
    return musicFoldersPayload();
  });

  app.post('/api/config/music-folders/rescan', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'forbidden' });
    void refreshMusicFolders();
    return reply.code(202).send({ ok: true });
  });

  // The folder picker: subfolders of an allowed (non built-in) root, nothing else.
  app.get<{ Querystring: { path?: string } }>('/api/config/music-folders/browse', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'forbidden' });
    const roots = await mountedRoots(true);
    const requested = req.query.path?.trim();
    if (!requested) return { path: null, parent: null, dirs: roots.map((r) => ({ name: r.label, path: r.path })) };

    let real: string;
    try {
      real = await fs.realpath(path.resolve(requested));
    } catch {
      return reply.code(400).send({ error: 'folder_missing' });
    }
    const realRoots = await Promise.all(roots.map((r) => fs.realpath(r.path).catch(() => null)));
    const root = realRoots.find((r): r is string => !!r && (real === r || real.startsWith(r + path.sep)));
    if (!root) return reply.code(400).send({ error: 'folder_outside_roots' });
    const entries = await fs.readdir(real, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(real, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: real, parent: real === root ? null : path.dirname(real), dirs };
  });
}
