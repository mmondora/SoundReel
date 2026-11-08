import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({
  findEntryByUrl: vi.fn(),
  createEntry: vi.fn().mockResolvedValue('entry-share-1'),
  updateEntry: vi.fn(),
  appendActionLog: vi.fn(),
  createActionLog: vi.fn((action: string, details: unknown) => ({ action, details, timestamp: 't' })),
  getApiKeysConfig: vi.fn().mockResolvedValue({ keys: ['sr_test_key_1234567890ab'] }),
  updateApiKeysConfig: vi.fn(),
  getEntry: vi.fn(),
  addEntryShares: vi.fn(),
  query: vi.fn(),
  pool: { query: vi.fn() },
}));

vi.mock('../utils/jobQueue', () => ({
  enqueueJob: vi.fn().mockResolvedValue(1),
}));

vi.mock('../services/debugLogger', () => ({
  Logger: class {
    info() {}
    error() {}
  },
}));

import { registerShareRoute } from './share';
import { apiKeyId } from '../utils/apiKeyAuth';
import { createEntry, findEntryByUrl, getApiKeysConfig, updateEntry } from '../utils/db';
import { enqueueJob } from '../utils/jobQueue';

function buildApp() {
  const app = Fastify();
  registerShareRoute(app);
  return app;
}

describe('POST /api/share', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApiKeysConfig).mockResolvedValue({ keys: ['sr_test_key_1234567890ab'] });
    vi.mocked(findEntryByUrl).mockResolvedValue(null as never);
    vi.mocked(createEntry).mockResolvedValue('entry-share-1');
  });

  it('rejects without API key', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/share',
      payload: { url: 'https://instagram.com/reel/x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates stub with tags from comment and enqueues job', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/share',
      headers: { 'x-soundreel-key': 'sr_test_key_1234567890ab' },
      payload: {
        url: 'https://www.instagram.com/reel/abc/',
        comment: '#tesla vacanze',
        channel: 'ios',
        user: 'Mike',
        sharedAt: '2026-11-07T12:30:00+01:00',
        device: { name: 'iPhone di Michele', timeZone: 'Europe/Rome' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, entryId: 'entry-share-1', status: 'queued' });
    expect(res.json().tags).toEqual(expect.arrayContaining(['#tesla', 'vacanze']));
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        inputChannel: 'ios',
        inputUser: 'mike',
        results: expect.objectContaining({
          tags: expect.arrayContaining(['#tesla', 'vacanze']),
        }),
        actionLog: expect.arrayContaining([
          expect.objectContaining({
            action: 'url_received',
            details: expect.objectContaining({
              user: 'mike',
              sharedAt: '2026-11-07T12:30:00+01:00',
              shareChannel: 'ios',
            }),
          }),
        ]),
      }),
    );
    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: 'entry-share-1',
        inputUser: 'mike',
        notify: false,
        chatId: 0,
      }),
    );
  });

  it('key bound to a user overrides body.user', async () => {
    const key = 'sr_test_key_1234567890ab';
    vi.mocked(getApiKeysConfig).mockResolvedValue({
      keys: [key],
      meta: { [apiKeyId(key)]: { user: 'sara', device: 'iPhone di Sara', createdAt: '2026-11-07T00:00:00.000Z' } },
    });
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/share',
      headers: { 'x-soundreel-key': key },
      payload: { url: 'https://www.instagram.com/reel/bound/', user: 'mike' },
    });
    expect(res.statusCode).toBe(200);
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ inputUser: 'sara', ownerUser: 'sara' }),
    );
  });

  it('merges tags into existing entry', async () => {
    vi.mocked(findEntryByUrl).mockResolvedValue({
      id: 'existing',
      results: { songs: [], films: [], notes: [], links: [], tags: ['#old'], summary: null },
    } as never);
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/share',
      headers: { 'x-soundreel-key': 'sr_test_key_1234567890ab' },
      payload: { url: 'https://www.instagram.com/reel/dup/', tags: ['#nuovo'] },
    });
    expect(res.statusCode).toBe(200);
    expect(createEntry).not.toHaveBeenCalled();
    expect(updateEntry).toHaveBeenCalledWith(
      'existing',
      expect.objectContaining({
        results: expect.objectContaining({
          tags: expect.arrayContaining(['#old', '#nuovo']),
        }),
      }),
    );
  });
});
