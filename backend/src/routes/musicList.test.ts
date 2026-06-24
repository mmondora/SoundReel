import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({ getEntry: vi.fn(), appendActionLog: vi.fn(), createActionLog: vi.fn() }));
vi.mock('../services/musicListExtractor', () => ({ extractSongsFromUrl: vi.fn() }));
vi.mock('../services/songResolver', () => ({ resolveSongs: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerMusicListRoute } from './musicList';
import { getEntry, appendActionLog, createActionLog } from '../utils/db';
import { extractSongsFromUrl } from '../services/musicListExtractor';
import { resolveSongs } from '../services/songResolver';

function buildApp() {
  const app = Fastify();
  registerMusicListRoute(app);
  return app;
}

const MOCK_ENTRY = {
  id: 'entry-1', sourceUrl: 'https://example.com/top10',
  caption: 'Top 10 albums', results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
};

describe('POST /api/music-list/process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createActionLog).mockReturnValue({ action: 'test', details: {}, timestamp: '2026-01-01T00:00:00.000Z' });
  });

  it('returns 400 when entryId missing', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/entryId/i);
  });

  it('returns 404 when entry not found', async () => {
    vi.mocked(getEntry).mockResolvedValue(null);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: { entryId: 'missing' } });
    expect(res.statusCode).toBe(404);
  });

  it('returns detected:false when no songs extracted', async () => {
    vi.mocked(getEntry).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(extractSongsFromUrl).mockResolvedValue([]);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ detected: false, songs: [], spooty: 0 });
    expect(resolveSongs).not.toHaveBeenCalled();
  });

  it('returns detected:true with resolved songs', async () => {
    vi.mocked(getEntry).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(extractSongsFromUrl).mockResolvedValue([{ title: 'Abbey Road', artist: 'Beatles' }]);
    vi.mocked(resolveSongs).mockResolvedValue([{
      title: 'Abbey Road', artist: 'Beatles',
      spotifyUrl: 'https://open.spotify.com/track/123', spotifyUri: 'spotify:track:123',
      youtubeUrl: 'https://youtube.com/results?search_query=Abbey+Road+Beatles',
      sentToSpooty: true,
    }]);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.detected).toBe(true);
    expect(body.songs).toHaveLength(1);
    expect(body.spooty).toBe(1);
    expect(appendActionLog).toHaveBeenCalled();
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(getEntry).mockRejectedValue(new Error('DB down'));
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(500);
  });
});
