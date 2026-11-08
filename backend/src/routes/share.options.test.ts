import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('../utils/db', () => ({
  createActionLog: vi.fn((action: string, details: unknown) => ({ action, details, timestamp: 't' })),
  getApiKeysConfig: vi.fn(),
  updateApiKeysConfig: vi.fn(),
  getEntry: vi.fn(),
  addEntryShares: vi.fn(),
  query: vi.fn(),
  pool: { query: vi.fn() },
}));
vi.mock('../services/linkIngest', () => ({ ingestLink: vi.fn() }));
vi.mock('../services/debugLogger', () => ({ Logger: class { info() {} error() {} } }));
vi.mock('../services/shareFlow', async (orig) => ({
  ...(await orig<typeof import('../services/shareFlow')>()),
  registerShare: vi.fn(),
  recordShareError: vi.fn(),
}));

import { registerShareRoute } from './share';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { getEntry } from '../utils/db';
import { ingestLink } from '../services/linkIngest';
import { recordShareError, registerShare } from '../services/shareFlow';

const KEY = 'sr_test_key_1234567890ab';
const STORED = { id: 'entry-1', sourceUrl: 'https://open.spotify.com/track/abc', results: { songs: [] } };

function buildApp() {
  const app = Fastify();
  registerShareRoute(app);
  return app;
}

const post = (payload: Record<string, unknown>) =>
  buildApp().inject({ method: 'POST', url: '/api/share', headers: { 'x-soundreel-key': KEY }, payload: { url: 'https://open.spotify.com/track/abc', ...payload } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateApiKey).mockResolvedValue({ owner: null });
  vi.mocked(ingestLink).mockResolvedValue({ kind: 'spotify', platform: 'spotify', entryId: 'entry-1', existing: false, enqueued: true, tags: [], spotify: { title: 'White Flag', artist: 'Bishop Briggs' } } as never);
  vi.mocked(getEntry).mockResolvedValue(STORED as never);
  vi.mocked(registerShare).mockResolvedValue({ playlist: null, sharedWith: [] });
});

describe('POST /api/share: playlist, family and the inbox (docs/mondrop-inbox.md)', () => {
  it('an app that knows nothing of the new fields gets them anyway, empty', async () => {
    const res = await post({ user: 'mike' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, entryId: 'entry-1', playlist: null, sharedWith: [], rejected: [] });
  });

  it('hands the playlist and the family to the share flow, for the sender, with the stored entry', async () => {
    vi.mocked(registerShare).mockResolvedValue({ playlist: { id: 'p1', name: 'Road trip', added: 1 }, sharedWith: ['archi', 'sara'] });
    const res = await post({ user: 'Mike', playlistId: ' p1 ', shareWith: ['archi', 'sara'], comment: '#tesla vacanze' });
    expect(registerShare).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(registerShare).mock.calls[0][0];
    expect(arg).toMatchObject({
      sender: 'mike',
      kind: 'spotify',
      entry: STORED,
      comment: '#tesla vacanze',
      options: { playlistId: 'p1', recipients: ['archi', 'sara'], rejected: [] },
    });
    expect(res.json()).toMatchObject({ playlist: { id: 'p1', name: 'Road trip', added: 1 }, sharedWith: ['archi', 'sara'], rejected: [] });
  });

  it('reports who cannot be shared with: the sender himself and strangers', async () => {
    vi.mocked(registerShare).mockResolvedValue({ playlist: null, sharedWith: ['sara'] });
    const res = await post({ user: 'mike', shareWith: ['mike', 'sara', 'mario'] });
    expect(res.json().rejected).toEqual([{ user: 'mike', reason: 'self' }, { user: 'mario', reason: 'unknown_user' }]);
    expect(res.json().sharedWith).toEqual(['sara']);
  });

  it('the user of the key wins over the one in the body, for the inbox too', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'sara', device: 'iPhone di Sara' } });
    await post({ user: 'mike', shareWith: ['sara', 'archi'] });
    const arg = vi.mocked(registerShare).mock.calls[0][0];
    expect(arg.sender).toBe('sara');
    expect(arg.options.recipients).toEqual(['archi']);
    expect(arg.options.rejected).toEqual([{ user: 'sara', reason: 'self' }]);
  });

  it('a key with no user cannot share with anybody', async () => {
    const res = await post({ shareWith: ['archi'] });
    expect(vi.mocked(registerShare).mock.calls[0][0].sender).toBe('anonymous');
    expect(res.json().rejected).toEqual([{ user: 'archi', reason: 'sender_unknown' }]);
  });

  it('a generic link is registered as generic: it completes when its analysis ends', async () => {
    vi.mocked(ingestLink).mockResolvedValue({ kind: 'generic', platform: 'instagram', entryId: 'entry-1', existing: false, enqueued: true, tags: [] } as never);
    const res = await post({ url: 'https://www.instagram.com/reel/abc/', user: 'mike', playlistId: 'p1' });
    expect(vi.mocked(registerShare).mock.calls[0][0].kind).toBe('generic');
    expect(res.json().status).toBe('queued');
  });

  it('still answers when the entry cannot be read back (the link is saved anyway)', async () => {
    vi.mocked(getEntry).mockResolvedValue(null);
    const res = await post({ user: 'mike', shareWith: ['archi'] });
    expect(res.statusCode).toBe(200);
    expect(registerShare).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ success: true, playlist: null, sharedWith: [] });
  });

  it('a failure in the share flow is an error the sheet can retry: the same link again is safe', async () => {
    vi.mocked(registerShare).mockRejectedValue(new Error('db down'));
    const res = await post({ user: 'mike' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ success: false, error: 'db down' });
  });

  it('a Shazam page that cannot be read: error for the sheet AND an error that stays in the inbox, with the options to retry', async () => {
    vi.mocked(ingestLink).mockResolvedValue({
      kind: 'shazam', platform: 'shazam', entryId: 'entry-3', existing: false, enqueued: true, tags: [],
      shazam: { ref: { kind: 'track', id: '1', url: 'https://www.shazam.com/track/1' }, error: 'page not found', title: null, artist: null },
    } as never);
    const res = await post({ url: 'https://www.shazam.com/track/1', user: 'mike', playlistId: 'p1', shareWith: ['sara'], comment: '#x' });
    expect(res.json()).toMatchObject({ success: false, status: 'error', error: 'Shazam: page not found', playlist: null, sharedWith: [], rejected: [] });
    expect(recordShareError).toHaveBeenCalledWith({
      userId: 'mike',
      entry: { id: 'entry-3', sourceUrl: 'https://www.shazam.com/track/1' },
      reason: 'shazam_unreadable',
      options: { playlistId: 'p1', shareWith: ['sara'], comment: '#x' },
    });
    expect(registerShare).not.toHaveBeenCalled();
  });
});
