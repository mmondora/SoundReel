import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({
  getEntry: vi.fn(),
  updateEntry: vi.fn(),
  appendActionLog: vi.fn(),
  createActionLog: vi.fn((action: string, details: unknown) => ({ action, details, timestamp: 't' })),
}));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }));
vi.mock('./spootyRequests', () => ({ listDueSpootyRequests: vi.fn(), patchSpootyRequest: vi.fn() }));
vi.mock('./spootyClient', async (orig) => ({
  ...(await orig<typeof import('./spootyClient')>()),
  listSpootyPlaylists: vi.fn(),
  listSpootyTracks: vi.fn(),
}));
vi.mock('./linkIngest', async (orig) => ({
  ...(await orig<typeof import('./linkIngest')>()),
  ensureAtSpooty: vi.fn(),
  persistCovers: vi.fn(),
}));
vi.mock('./songMeta', async (orig) => ({
  ...(await orig<typeof import('./songMeta')>()),
  patchSongUserMeta: vi.fn(),
}));

import { nextDelayMs, pollSpootyRequests, shortSpootyError } from './spootyWatcher';
import { getEntry, updateEntry, appendActionLog } from '../utils/db';
import { listDueSpootyRequests, patchSpootyRequest } from './spootyRequests';
import { listSpootyPlaylists, listSpootyTracks } from './spootyClient';
import { ensureAtSpooty } from './linkIngest';
import { patchSongUserMeta } from './songMeta';

const ID = '22kBlINGUYm2rc1Wd7RPfw';
const CANON = `https://open.spotify.com/track/${ID}`;
const NOW = Date.parse('2026-11-07T20:00:00Z');

const request = (over: Record<string, unknown> = {}) => ({
  id: 5, entryId: 'e1', ownerUser: 'mike', spotifyUrl: CANON, kind: 'track', spootyPlaylistId: 38, chatId: 7,
  status: 'tracking', attempts: 0, lastError: null, nextCheckAt: new Date(NOW), createdAt: new Date(NOW - 10_000), ...over,
});
const playlist = { id: 38, name: "Say it Ain't So", spotifyUrl: CANON, error: null, active: false, isTrack: true, coverUrl: 'https://i.scdn.co/c' };
const track = (status: number, error: string | null = null) => ({
  id: 609, artist: 'PENNY', name: "Say it Ain't So", spotifyUrl: CANON, youtubeUrl: null, status, error, coverUrl: 'https://i.scdn.co/c',
});
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e1', caption: null, thumbnailUrl: null, status: 'processing',
  results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null }, ...over,
});

const notify = vi.fn().mockResolvedValue(undefined);
const run = () => pollSpootyRequests({ notify, now: () => NOW });

beforeEach(() => {
  vi.resetAllMocks();
  notify.mockResolvedValue(undefined);
  vi.mocked(getEntry).mockResolvedValue(entry() as never);
  vi.mocked(listSpootyPlaylists).mockResolvedValue([playlist]);
});

describe('helpers', () => {
  it('polls fast while young and slows down', () => {
    expect(nextDelayMs(0)).toBe(5_000);
    expect(nextDelayMs(59_000)).toBe(5_000);
    expect(nextDelayMs(2 * 60_000)).toBe(15_000);
    expect(nextDelayMs(10 * 60_000)).toBe(60_000);
    expect(nextDelayMs(2 * 3600_000)).toBe(5 * 60_000);
  });

  it('shortens the raw Spooty error', () => {
    expect(shortSpootyError('Error: yt-dlp exited with code 1: unable to download video data: HTTP Error 403:')).toBe(
      'unable to download video data: HTTP Error 403:',
    );
    expect(shortSpootyError(null)).toBe('');
    expect(shortSpootyError('x'.repeat(300))).toHaveLength(158);
  });
});

describe('pollSpootyRequests', () => {
  it('does nothing when nothing is due', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([]);
    await expect(run()).resolves.toEqual({ checked: 0, finalized: 0 });
    expect(listSpootyPlaylists).not.toHaveBeenCalled();
  });

  it('still downloading: syncs metadata onto the entry and schedules the next check', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request()] as never);
    vi.mocked(listSpootyTracks).mockResolvedValue([track(3)]);
    await expect(run()).resolves.toEqual({ checked: 1, finalized: 0 });
    expect(updateEntry).toHaveBeenCalledWith('e1', expect.objectContaining({
      caption: 'PENNY – Say it Ain\'t So',
      thumbnailUrl: 'https://i.scdn.co/c',
      results: expect.objectContaining({ songs: [expect.objectContaining({ title: "Say it Ain't So", artist: 'PENNY', source: 'spotify_link' })] }),
    }));
    expect(patchSpootyRequest).toHaveBeenCalledWith(5, { lastError: null, nextCheckInMs: 5_000 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('completed (status 4): entry completed, downloaded flag set, Telegram told', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request()] as never);
    vi.mocked(listSpootyTracks).mockResolvedValue([track(4)]);
    await expect(run()).resolves.toEqual({ checked: 1, finalized: 1 });
    expect(updateEntry).toHaveBeenCalledWith('e1', { status: 'completed' });
    expect(patchSongUserMeta).toHaveBeenCalledWith("penny::say it ain't so", { downloaded: true });
    expect(patchSpootyRequest).toHaveBeenCalledWith(5, { status: 'completed', lastError: null });
    expect(vi.mocked(appendActionLog).mock.calls.at(-1)?.[1]).toMatchObject({ action: 'spooty_finished', details: expect.objectContaining({ completed: 1, failed: 0 }) });
    expect(notify).toHaveBeenCalledWith(7, expect.stringContaining('Pronto'));
    expect(notify.mock.calls[0][1]).toContain('/?entry=e1');
  });

  it('the real 403: entry in error, reason kept, user told how to retry', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request()] as never);
    vi.mocked(listSpootyTracks).mockResolvedValue([track(5, 'Error: yt-dlp exited with code 1: unable to download video data: HTTP Error 403: Forbidden')]);
    await expect(run()).resolves.toEqual({ checked: 1, finalized: 1 });
    expect(updateEntry).toHaveBeenCalledWith('e1', { status: 'error' });
    expect(patchSongUserMeta).not.toHaveBeenCalled();
    expect(patchSpootyRequest).toHaveBeenCalledWith(5, expect.objectContaining({ status: 'failed', lastError: expect.stringContaining('HTTP Error 403') }));
    const html = notify.mock.calls[0][1] as string;
    expect(html).toContain('non scaricato');
    expect(html).toContain('HTTP Error 403');
    expect(html).toContain('Rimanda il link');
  });

  it('no chat (share/web origin): finalizes silently', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request({ chatId: null })] as never);
    vi.mocked(listSpootyTracks).mockResolvedValue([track(4)]);
    await run();
    expect(notify).not.toHaveBeenCalled();
    expect(updateEntry).toHaveBeenCalledWith('e1', { status: 'completed' });
  });

  it('album with some failures counts as completed and reports both numbers', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request({ kind: 'album', spotifyUrl: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3' })] as never);
    vi.mocked(listSpootyPlaylists).mockResolvedValue([{ ...playlist, name: 'Mezzanine', isTrack: false }]);
    vi.mocked(listSpootyTracks).mockResolvedValue([
      { ...track(4), id: 1, name: 'Angel' }, { ...track(4), id: 2, name: 'Risingson' }, { ...track(5, 'youtubeUrl is null'), id: 3, name: 'Teardrop' },
    ]);
    await run();
    expect(updateEntry).toHaveBeenCalledWith('e1', { status: 'completed' });
    expect(notify.mock.calls[0][1]).toContain('scaricati 2/3');
    expect(notify.mock.calls[0][1]).toContain('1 falliti');
  });

  it('Spooty unreachable: keeps the request, counts the attempt, retries later', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request({ attempts: 2 })] as never);
    vi.mocked(listSpootyPlaylists).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(run()).resolves.toEqual({ checked: 1, finalized: 0 });
    expect(patchSpootyRequest).toHaveBeenCalledWith(5, { attempts: 3, lastError: 'ECONNREFUSED', nextCheckInMs: 5_000 });
    expect(updateEntry).not.toHaveBeenCalled();
  });

  it('gives up after 6 hours without a verdict and says so', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request({ createdAt: new Date(NOW - 7 * 3600_000) })] as never);
    vi.mocked(listSpootyPlaylists).mockRejectedValue(new Error('down'));
    await expect(run()).resolves.toEqual({ checked: 1, finalized: 1 });
    expect(updateEntry).toHaveBeenCalledWith('e1', { status: 'error' });
    expect(patchSpootyRequest).toHaveBeenCalledWith(5, expect.objectContaining({ status: 'failed', lastError: expect.stringContaining('timeout') }));
  });

  it('request queued before Spooty accepted it: adds it now (find-before-add) and records the playlist', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request({ spootyPlaylistId: null, status: 'queued' })] as never);
    vi.mocked(ensureAtSpooty).mockResolvedValue({ accepted: true, playlist, tracks: [track(1)], error: null });
    await run();
    expect(ensureAtSpooty).toHaveBeenCalledWith(expect.objectContaining({ url: CANON }));
    expect(patchSpootyRequest).toHaveBeenCalledWith(5, { spootyPlaylistId: 38, status: 'tracking' });
    expect(vi.mocked(appendActionLog).mock.calls.map((c) => c[1].action)).toContain('spooty_enqueued');
  });

  it('Spooty could not read the link: fails fast with its error', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request()] as never);
    vi.mocked(listSpootyPlaylists).mockResolvedValue([{ ...playlist, error: 'Error: Spotify 404' }]);
    vi.mocked(listSpootyTracks).mockResolvedValue([]);
    await expect(run()).resolves.toEqual({ checked: 1, finalized: 1 });
    expect(patchSpootyRequest).toHaveBeenCalledWith(5, expect.objectContaining({ status: 'failed', lastError: 'Error: Spotify 404' }));
  });

  it('entry deleted meanwhile: closes the request', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request()] as never);
    vi.mocked(getEntry).mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ checked: 1, finalized: 1 });
    expect(patchSpootyRequest).toHaveBeenCalledWith(5, { status: 'failed', lastError: 'entry non trovata' });
  });

  it('one bad request does not stop the others', async () => {
    vi.mocked(listDueSpootyRequests).mockResolvedValue([request({ id: 1, entryId: 'bad' }), request({ id: 2, entryId: 'e1' })] as never);
    vi.mocked(getEntry).mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce(entry() as never);
    vi.mocked(listSpootyTracks).mockResolvedValue([track(4)]);
    await expect(run()).resolves.toEqual({ checked: 2, finalized: 1 });
    expect(patchSpootyRequest).toHaveBeenCalledWith(1, expect.objectContaining({ lastError: 'db blip', nextCheckInMs: 60_000 }));
  });
});
