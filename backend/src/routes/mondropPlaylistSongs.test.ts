import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn(), addSongToPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), buildTracks: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), requestSongDownload: vi.fn(),
  setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(), ORDER_MONDROP: ['local', 'media'], resolveEntryMediaAbs: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));

import { registerMondropRoutes } from './mondrop';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { addSongToPlaylist } from '../services/playlists';
import { getTrack } from '../services/offlineManifest';
import { logActivity } from '../services/activityLog';
import { logError } from '../utils/logger';

const KEY = 'bassi maestro::foto di gruppo';
const post = (id: string, body: unknown, headers: Record<string, string> = { 'x-soundreel-key': 'sr_test' }) => {
  const app = Fastify();
  registerMondropRoutes(app);
  return app.inject({ method: 'POST', url: `/api/mondrop/playlists/${id}/songs`, headers, payload: body as never });
};

describe('POST /api/mondrop/playlists/:id/songs (ADR-0018: a song that is only a file goes in a playlist too)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
    vi.mocked(getTrack).mockResolvedValue({ songKey: KEY, title: 'Foto di gruppo', artist: 'Bassi Maestro' } as never);
    vi.mocked(addSongToPlaylist).mockResolvedValue({ id: 'p1', name: 'Rap', kind: 'static', songKeys: ['a::b', KEY] } as never);
  });

  it('needs the API key, and touches nothing without it', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    expect((await post('p1', { songKey: KEY })).statusCode).toBe(401);
    expect(addSongToPlaylist).not.toHaveBeenCalled();
  });

  it('adds the song for THE USER OF THE KEY, who must own the playlist, and says how many songs it has now', async () => {
    const res = await post('p1', { songKey: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, playlist: { id: 'p1', name: 'Rap', songs: 2 }, user: 'mike' });
    expect(addSongToPlaylist).toHaveBeenCalledWith('p1', KEY, 'mike');
    expect(getTrack).toHaveBeenCalledWith(KEY, 'mike', false); // the song he can see: from the journal or a file
  });

  it('writes a line in the activity log, with who and from which device', async () => {
    await post('p1', { songKey: KEY });
    const [category, action, message, actor, data] = vi.mocked(logActivity).mock.calls[0];
    expect([category, action]).toEqual(['playlist', 'add_song']);
    expect(message).toContain('«Foto di gruppo – Bassi Maestro»');
    expect(message).toContain('«Rap»');
    expect(actor).toMatchObject({ user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' });
    expect(data).toMatchObject({ playlistId: 'p1', songKey: KEY, songs: 2 });
  });

  it('refuses a missing, blank, non-text or absurdly long song key with a 400, before looking at anything', async () => {
    for (const body of [{}, { songKey: '' }, { songKey: '   ' }, { songKey: 42 }, { songKey: ['a'] }, { songKey: 'x'.repeat(501) }, undefined]) {
      expect((await post('p1', body)).statusCode).toBe(400);
    }
    expect(getTrack).not.toHaveBeenCalled();
    expect(addSongToPlaylist).not.toHaveBeenCalled();
  });

  it('a song nobody knows (no journal entry, no file) is a 404 and is NOT put in the playlist', async () => {
    vi.mocked(getTrack).mockResolvedValue(null);
    const res = await post('p1', { songKey: 'ghost::song' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'song not found' });
    expect(addSongToPlaylist).not.toHaveBeenCalled();
  });

  it('a playlist that is not his (not found, or only shared with him: read-only) is a 404', async () => {
    vi.mocked(addSongToPlaylist).mockResolvedValue(null);
    const res = await post('somebody-elses', { songKey: KEY });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'playlist not found' });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('a dynamic playlist is a rule, not a list: 409', async () => {
    vi.mocked(addSongToPlaylist).mockRejectedValue(new Error('playlist_is_dynamic'));
    const res = await post('d1', { songKey: KEY });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'playlist_is_dynamic' });
    expect(logError).not.toHaveBeenCalled();
  });

  it('says it failed, not what failed, when something else throws', async () => {
    vi.mocked(addSongToPlaylist).mockRejectedValue(new Error('db down: password=hunter2'));
    const res = await post('p1', { songKey: KEY });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ ok: false, error: 'playlist add song failed' });
  });
});
