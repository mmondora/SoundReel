import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  countSongFilesByStatus: vi.fn(),
  countPublished: vi.fn(),
  countMediaIndex: vi.fn(),
  getMediaServerStatus: vi.fn(),
  refreshMediaIndex: vi.fn(),
  reconcilePublished: vi.fn(),
}));
vi.mock('../utils/db', () => ({
  countEntries: vi.fn(), countsByPlatform: vi.fn(), countsByStatus: vi.fn(), ageBuckets: vi.fn(), allEntryIds: vi.fn(),
  findEntriesByFilter: vi.fn(), deleteEntriesByIds: vi.fn(), getRetentionConfig: vi.fn(), updateRetentionConfig: vi.fn(),
}));
vi.mock('../services/songFiles', () => ({ countSongFilesByStatus: m.countSongFilesByStatus, countPublished: m.countPublished }));
vi.mock('../services/mediaIndex', () => ({ countMediaIndex: m.countMediaIndex }));
vi.mock('../services/mediaServer', () => ({
  MEDIA_STORE: 'fritz',
  getMediaServerStatus: m.getMediaServerStatus,
  refreshMediaIndex: m.refreshMediaIndex,
  reconcilePublished: m.reconcilePublished,
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { registerAdminRoutes } from './admin';

const app = () => {
  const a = Fastify();
  registerAdminRoutes(a);
  return a;
};
const AUTH = { 'remote-user': 'mike' }; // set by Authelia/Traefik on every proxied request
const status = { enabled: true, reachable: true, lastIndexAt: 't', lastIndexCount: 3448, lastIndexError: null, lastReconcileAt: 't', lastReconcile: { verified: 1, dropped: 0, pending: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  m.getMediaServerStatus.mockReturnValue(status);
});

describe('admin: MP3 archive status', () => {
  it('is behind the existing admin guard (no Authelia user, no answer)', async () => {
    expect((await app().inject({ method: 'GET', url: '/api/admin/store' })).statusCode).toBe(401);
    expect((await app().inject({ method: 'POST', url: '/api/admin/store/refresh' })).statusCode).toBe(401);
    expect(m.refreshMediaIndex).not.toHaveBeenCalled();
  });

  it('reports songs per state, published replicas, the media index and the media server', async () => {
    m.countSongFilesByStatus.mockResolvedValue({ ready: 120, queued: 3, failed: 1 });
    m.countPublished.mockResolvedValue(100);
    m.countMediaIndex.mockResolvedValue(3448);
    const res = await app().inject({ method: 'GET', url: '/api/admin/store', headers: AUTH });
    expect(res.json()).toEqual({ songFiles: { ready: 120, queued: 3, failed: 1 }, published: 100, mediaIndex: 3448, mediaServer: status });
    expect(m.countMediaIndex).toHaveBeenCalledWith('fritz');
  });

  it('500 when a count fails', async () => {
    m.countSongFilesByStatus.mockRejectedValue(new Error('db down'));
    m.countPublished.mockResolvedValue(0);
    m.countMediaIndex.mockResolvedValue(0);
    expect((await app().inject({ method: 'GET', url: '/api/admin/store', headers: AUTH })).statusCode).toBe(500);
  });

  it('refresh re-reads the catalogue and verifies replicas now; a dead box is a 502, not a crash', async () => {
    m.refreshMediaIndex.mockResolvedValue(3448);
    m.reconcilePublished.mockResolvedValue({ verified: 2, dropped: 0, pending: 1 });
    const ok = await app().inject({ method: 'POST', url: '/api/admin/store/refresh', headers: AUTH });
    expect(ok.json()).toMatchObject({ indexed: 3448, reconciled: { verified: 2, dropped: 0, pending: 1 } });
    m.refreshMediaIndex.mockRejectedValue(new Error('media server: HTTP 503'));
    const bad = await app().inject({ method: 'POST', url: '/api/admin/store/refresh', headers: AUTH });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toContain('HTTP 503');
  });
});
