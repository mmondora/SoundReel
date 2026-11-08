import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../services/ttsRender', () => ({
  renderTtsSync: vi.fn(),
  enqueueTtsJob: vi.fn(),
  getTtsJob: vi.fn(),
  getReadingProgress: vi.fn(),
  putReadingProgress: vi.fn(),
}));

vi.mock('../services/ttsClient', () => ({
  TtsHttpError: class TtsHttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body: string,
      readonly headers: Record<string, string> = {},
    ) {
      super(message);
    }
  },
}));

import { registerTtsRoutes } from './tts';
import {
  enqueueTtsJob,
  getReadingProgress,
  getTtsJob,
  putReadingProgress,
  renderTtsSync,
} from '../services/ttsRender';
import { TtsHttpError } from '../services/ttsClient';

function buildApp() {
  const app = Fastify();
  registerTtsRoutes(app);
  return app;
}

describe('TTS routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/tts/render sync ready', async () => {
    vi.mocked(renderTtsSync).mockResolvedValue({
      status: 'ready',
      audioUrl: '/media/tts/abc.mp3',
      durationSec: 2,
      hash: 'abc',
      engine: 'edge-tts',
      servedBy: 'edge-tts',
      voice: 'it-IT-DiegoNeural',
      cached: false,
    });
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/render',
      payload: { text: 'Ciao' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().audioUrl).toBe('/media/tts/abc.mp3');
  });

  it('POST /api/tts/render async returns jobId', async () => {
    vi.mocked(enqueueTtsJob).mockReturnValue({
      id: 'job1',
      status: 'pending',
      createdAt: '2026-11-07T00:00:00Z',
    });
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/render',
      payload: { text: 'Ciao', async: true },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'pending', jobId: 'job1' });
  });

  it('POST /api/tts/render maps TtsHttpError status', async () => {
    vi.mocked(renderTtsSync).mockRejectedValue(
      new TtsHttpError('no local', 503, '{"error":"nessun backend voce locale disponibile"}', {}),
    );
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/render',
      payload: { text: 'segreto', localOnly: true },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('error');
  });

  it('GET /api/tts/jobs/:id 404', async () => {
    vi.mocked(getTtsJob).mockReturnValue(null);
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/tts/jobs/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT/GET reading-progress', async () => {
    vi.mocked(putReadingProgress).mockResolvedValue({
      itemKey: 'demo',
      positionSec: 3,
      durationSec: 10,
      updatedAt: '2026-11-07T00:00:00Z',
    });
    vi.mocked(getReadingProgress).mockResolvedValue({
      itemKey: 'demo',
      positionSec: 3,
      durationSec: 10,
      updatedAt: '2026-11-07T00:00:00Z',
    });
    const app = buildApp();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/reading-progress/demo',
      payload: { positionSec: 3, durationSec: 10 },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/reading-progress/demo' });
    expect(get.statusCode).toBe(200);
    expect(get.json().positionSec).toBe(3);
  });
});
