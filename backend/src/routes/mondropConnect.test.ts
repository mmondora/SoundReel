import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const state = vi.hoisted(() => ({
  cfg: { keys: [] as string[], meta: {} as Record<string, unknown> },
}));

vi.mock('../utils/db', () => ({
  getApiKeysConfig: vi.fn(async () => ({ keys: [...state.cfg.keys], meta: { ...state.cfg.meta } })),
  updateApiKeysConfig: vi.fn(async (u: { keys?: string[]; meta?: Record<string, unknown> }) => {
    state.cfg = { ...state.cfg, ...u } as typeof state.cfg;
  }),
}));

vi.mock('../services/debugLogger', () => ({
  Logger: class {
    info() {}
    error() {}
  },
}));

import { registerMondropConnectRoutes } from './mondropConnect';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { updateApiKeysConfig } from '../utils/db';

const HOST = 'soundreel.casamon.dev';
const FORM = 'application/x-www-form-urlencoded';

function buildApp() {
  const app = Fastify();
  registerMondropConnectRoutes(app);
  return app;
}

/** Pull the issued key out of the `mondrop://auth?...` link (`&` is HTML-escaped in the page). */
function issuedKey(html: string): string | null {
  return /mondrop:\/\/auth\?key=(sr_[A-Za-z0-9_-]+)&amp;user=/.exec(html)?.[1] ?? null;
}

beforeEach(() => {
  state.cfg = { keys: [], meta: {} };
  vi.clearAllMocks();
});

describe('GET /mondrop/connect', () => {
  it('401 without Remote-User', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/mondrop/connect', headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it('403 for an Authelia user outside the family', async () => {
    const res = await buildApp().inject({
      method: 'GET',
      url: '/mondrop/connect',
      headers: { host: HOST, 'remote-user': 'francesco' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('renders the confirm page with the device pre-filled', async () => {
    const res = await buildApp().inject({
      method: 'GET',
      url: `/mondrop/connect?device=${encodeURIComponent('iPhone di Michele')}`,
      headers: { host: HOST, 'remote-user': 'mike' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Michele');
    expect(res.body).toContain('value="iPhone di Michele"');
    expect(state.cfg.keys).toEqual([]); // GET has no side effects
  });

  it('escapes the device label (no HTML injection, no scripts at all)', async () => {
    const res = await buildApp().inject({
      method: 'GET',
      url: `/mondrop/connect?device=${encodeURIComponent('"><script>alert(1)</script>')}`,
      headers: { host: HOST, 'remote-user': 'mike' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script');
    expect(res.body).toContain('&lt;script&gt;');
  });
});

describe('POST /mondrop/connect', () => {
  const post = (headers: Record<string, string>, payload = 'device=iPhone+di+Michele') =>
    buildApp().inject({
      method: 'POST',
      url: '/mondrop/connect',
      headers: { host: HOST, 'content-type': FORM, ...headers },
      payload,
    });

  it('401 without Remote-User and issues nothing', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(401);
    expect(updateApiKeysConfig).not.toHaveBeenCalled();
  });

  it('403 on cross-site requests (CSRF) and issues nothing', async () => {
    const crossSite = await post({ 'remote-user': 'mike', 'sec-fetch-site': 'cross-site' });
    expect(crossSite.statusCode).toBe(403);
    const foreignOrigin = await post({ 'remote-user': 'mike', origin: 'https://evil.example' });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(updateApiKeysConfig).not.toHaveBeenCalled();
  });

  it('issues a key bound to the Authelia user and hands it to the app', async () => {
    const res = await post({ 'remote-user': 'mike', origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');

    const key = issuedKey(res.body);
    expect(key).not.toBeNull();
    expect(res.body).toContain('user=mike&amp;device=iPhone%20di%20Michele');
    expect(res.body).toContain('http-equiv="refresh"');
    expect(state.cfg.keys).toEqual([key]);
    await expect(authenticateApiKey(key as string)).resolves.toEqual({
      owner: { user: 'mike', device: 'iPhone di Michele' },
    });
  });

  it('takes the identity from Remote-User, never from the body', async () => {
    const res = await post({ 'remote-user': 'mike' }, 'device=iPhone&user=sara');
    const key = issuedKey(res.body) as string;
    await expect(authenticateApiKey(key)).resolves.toEqual({ owner: { user: 'mike', device: 'iPhone' } });
  });

  it('renewing the same device revokes the previous key', async () => {
    const first = issuedKey((await post({ 'remote-user': 'mike' })).body) as string;
    const second = await post({ 'remote-user': 'mike' });
    const secondKey = issuedKey(second.body) as string;
    expect(secondKey).not.toBe(first);
    expect(second.body).toContain('revocata');
    expect(state.cfg.keys).toEqual([secondKey]);
    await expect(authenticateApiKey(first)).resolves.toBeNull();
  });
});
