import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({
  query: vi.fn(), pool: { query: vi.fn() },
  countEntries: vi.fn(), countsByPlatform: vi.fn(), countsByStatus: vi.fn(), listEntries: vi.fn(),
}));
vi.mock('../services/songFiles', () => ({ countPublished: vi.fn(), countSongFilesByStatus: vi.fn() }));
vi.mock('../services/mediaIndex', () => ({ countMediaIndex: vi.fn() }));
vi.mock('../services/mediaServer', () => ({ getMediaServerStatus: vi.fn(), MEDIA_STORE: 'x', reconcilePublished: vi.fn(), refreshMediaIndex: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarning: vi.fn() }));
vi.mock('../services/usageCounters', () => ({ readUsage: vi.fn() }));

import { registerAdminRoutes } from './admin';
import { readUsage } from '../services/usageCounters';

const REPORT = { days: 14, since: '2026-10-26', total: 3, byDevice: { 'mobile-web': 3 }, byDeviceAndGroup: {}, byUser: {}, byNetwork: {}, byDay: [] };

function buildApp() {
  const app = Fastify();
  registerAdminRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readUsage).mockResolvedValue(REPORT as never);
});

describe('GET /api/admin/usage', () => {
  it('is for admins: the aggregated report', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/admin/usage?days=7', headers: { 'remote-user': 'mike', 'remote-groups': 'admins,family' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(REPORT);
    expect(readUsage).toHaveBeenCalledWith('7');
  });

  it('a family member who is not an admin is refused', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/admin/usage', headers: { 'remote-user': 'sara', 'remote-groups': 'family' } });
    expect(res.statusCode).toBe(403);
    expect(readUsage).not.toHaveBeenCalled();
  });

  it('no identity at all is refused by the /api/admin hook', async () => {
    const res = await buildApp().inject({ method: 'GET', url: '/api/admin/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('a failure is a plain 500', async () => {
    vi.mocked(readUsage).mockRejectedValue(new Error('relation "usage_counters" does not exist'));
    const res = await buildApp().inject({ method: 'GET', url: '/api/admin/usage', headers: { 'remote-user': 'mike', 'remote-groups': 'admins' } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('usage_counters');
  });
});
