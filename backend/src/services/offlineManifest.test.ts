import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getPlaylist: vi.fn(),
  getUserSongs: vi.fn(),
  findLibraryMatch: vi.fn(),
  findMediaServerMatch: vi.fn(),
  getSongPlayStats: vi.fn(),
  resolveDetail: vi.fn(),
  getEntry: vi.fn(),
  enqueueSongDownload: vi.fn(),
  getSongFile: vi.fn(),
  getSongFiles: vi.fn(),
  markReady: vi.fn(),
  resetToQueued: vi.fn(),
  setVideoOverride: vi.fn(),
  listOpenSpootyEntryIds: vi.fn(),
  wakeSongDownloader: vi.fn(),
  postToSpooty: vi.fn(),
}));
vi.mock('../utils/db', () => ({ getEntry: m.getEntry, query: vi.fn() }));
vi.mock('./playlists', () => ({ getPlaylist: m.getPlaylist }));
vi.mock('./userSongs', () => ({ getUserSongs: m.getUserSongs }));
vi.mock('./listeningStats', () => ({ getSongPlayStats: m.getSongPlayStats }));
vi.mock('./playlistResolver', () => ({ resolveDetail: m.resolveDetail }));
vi.mock('./fileResolver', () => ({ findLibraryMatch: m.findLibraryMatch, findMediaServerMatch: m.findMediaServerMatch }));
vi.mock('./songFiles', async (orig) => ({
  ...(await orig<typeof import('./songFiles')>()),
  enqueueSongDownload: m.enqueueSongDownload,
  getSongFile: m.getSongFile,
  getSongFiles: m.getSongFiles,
  markReady: m.markReady,
  resetToQueued: m.resetToQueued,
  setVideoOverride: m.setVideoOverride,
}));
vi.mock('./spootyRequests', () => ({ listOpenSpootyEntryIds: m.listOpenSpootyEntryIds }));
vi.mock('./songDownloader', () => ({ wakeSongDownloader: m.wakeSongDownloader }));
vi.mock('./spootyClient', () => ({ postToSpooty: m.postToSpooty }));
vi.mock('./localMedia', () => ({ rebuildLocalPaths: vi.fn() }));

import {
  buildPlaylistOfflineManifest,
  buildTracks,
  enqueueSongToSpooty,
  getTrack,
  isYoutubeVideoUrl,
  preparePlaylist,
  requestSongDownload,
  ORDER_MONDROP,
  ORDER_WEB,
  resolveSongServing,
  setSongSource,
  songFilePath,
} from './offlineManifest';
import { PRIORITY_PLAY, PRIORITY_SYNC } from './songFiles';

const KEY = 'bishop briggs::white flag';
let lib: string;

const song = (over: Record<string, unknown> = {}) => ({
  songKey: KEY, title: 'White Flag', artist: 'Bishop Briggs', album: 'Church of Scars', youtubeUrl: null, spotifyUrl: null,
  mentions: [{ entryId: 'e1' }], meta: { coverUrl: 'https://c/x.jpg' }, inLibrary: false, ...over,
}) as never;

const row = (over: Record<string, unknown> = {}) => ({
  songKey: KEY, status: 'queued', source: null, relPath: null, bytes: null, mtimeMs: null, durationS: null, mediaUrl: null,
  publishedAt: null, error: null, attempts: 0, priority: 0, artist: 'Bishop Briggs', title: 'White Flag', album: null,
  coverUrl: null, updatedAt: new Date(), nextAttemptAt: new Date(), ...over,
}) as never;

const writeSong = async (rel = 'SoundReel/Bishop Briggs - White Flag.mp3', content = '0123456789'): Promise<void> => {
  await mkdir(path.dirname(path.join(lib, rel)), { recursive: true });
  await writeFile(path.join(lib, rel), content);
};

beforeEach(async () => {
  vi.clearAllMocks();
  lib = await mkdtemp(path.join(tmpdir(), 'manifest-lib-'));
  process.env.MUSIC_LIBRARY_PATH = lib;
  m.getPlaylist.mockResolvedValue({ id: 'p1', name: 'Auto', songKeys: [KEY] });
  m.getUserSongs.mockResolvedValue(new Map([[KEY, song()]]));
  m.getSongFiles.mockResolvedValue(new Map());
  m.getSongFile.mockResolvedValue(null);
  m.findLibraryMatch.mockResolvedValue(null);
  m.findMediaServerMatch.mockResolvedValue(null);
  m.getSongPlayStats.mockResolvedValue(new Map());
  m.resolveDetail.mockImplementation(async (p: unknown) => p); // a static playlist is what is stored
  m.listOpenSpootyEntryIds.mockResolvedValue(new Set());
  m.getEntry.mockResolvedValue(null);
  m.enqueueSongDownload.mockResolvedValue(row());
  m.markReady.mockResolvedValue(row({ status: 'ready' }));
});
afterEach(async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  await rm(lib, { recursive: true, force: true });
});

const manifestTrack = async (opts?: { lyrics?: boolean }) => (await buildPlaylistOfflineManifest('p1', 'mike', false, opts))!.tracks[0];

describe('manifest: listening numbers and dynamic playlists (docs/mondrop-stats.md §3–§4)', () => {
  it('every track carries the user\'s own counted plays (all devices) and last play; a song never played is 0 / null', async () => {
    m.getUserSongs.mockResolvedValue(new Map([[KEY, song()], ['a::b', song({ songKey: 'a::b', title: 'B', artist: 'A' })]]));
    m.getPlaylist.mockResolvedValue({ id: 'p1', name: 'Auto', songKeys: [KEY, 'a::b'] });
    m.getSongPlayStats.mockResolvedValue(new Map([[KEY, { plays: 12, lastPlayedAt: '2026-11-05T21:03:11Z' }]]));
    const tracks = (await buildPlaylistOfflineManifest('p1', 'mike'))!.tracks;
    expect(tracks.map((t) => [t.songKey, t.plays, t.lastPlayedAt])).toEqual([[KEY, 12, '2026-11-05T21:03:11Z'], ['a::b', 0, null]]);
    expect(m.getSongPlayStats).toHaveBeenCalledWith('mike', [KEY, 'a::b']); // the viewer's numbers, one query
  });

  it('a failure reading the numbers never breaks the manifest', async () => {
    m.getSongPlayStats.mockRejectedValue(new Error('db down'));
    expect(await manifestTrack()).toMatchObject({ songKey: KEY, plays: 0, lastPlayedAt: null });
  });

  it('GET one song carries the same numbers', async () => {
    m.getSongPlayStats.mockResolvedValue(new Map([[KEY, { plays: 3, lastPlayedAt: '2026-11-01T07:30:00Z' }]]));
    expect(await getTrack(KEY, 'mike')).toMatchObject({ plays: 3, lastPlayedAt: '2026-11-01T07:30:00Z' });
  });

  it('a static playlist is just its songs: no dynamic / generatedAt keys', async () => {
    const manifest = (await buildPlaylistOfflineManifest('p1', 'mike'))!;
    expect('dynamic' in manifest).toBe(false);
    expect('generatedAt' in manifest).toBe(false);
  });

  it('a dynamic playlist holds the songs its rule selects NOW, flagged and dated; the stored list is ignored', async () => {
    m.getPlaylist.mockResolvedValue({ id: 'd1', name: 'Notte', kind: 'dynamic', songKeys: ['stale::song'] });
    m.resolveDetail.mockResolvedValue({ id: 'd1', name: 'Notte', kind: 'dynamic', songKeys: [KEY], songCount: 1, generatedAt: '2026-11-08T22:00:00.000Z' });
    const manifest = (await buildPlaylistOfflineManifest('d1', 'mike'))!;
    expect(m.resolveDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), { userId: 'mike', isAdmin: false });
    expect(manifest).toMatchObject({ playlistId: 'd1', dynamic: true, generatedAt: '2026-11-08T22:00:00.000Z' });
    expect(manifest.tracks.map((t) => t.songKey)).toEqual([KEY]);
  });

  it('syncing a dynamic playlist prepares what the rule selects now, not what was stored', async () => {
    m.getPlaylist.mockResolvedValue({ id: 'd1', name: 'Notte', kind: 'dynamic', songKeys: ['stale::song'] });
    m.resolveDetail.mockResolvedValue({ id: 'd1', name: 'Notte', kind: 'dynamic', songKeys: [KEY], songCount: 1, generatedAt: '2026-11-08T22:00:00.000Z' });
    await preparePlaylist('d1', 'mike');
    expect(m.enqueueSongDownload).toHaveBeenCalledTimes(1);
    expect(m.enqueueSongDownload).toHaveBeenCalledWith(expect.objectContaining({ songKey: KEY, priority: PRIORITY_SYNC }));
  });
});

describe('manifest: album, genres and year on every track (ADR-0013: choosing what to play)', () => {
  const dated = (over: Record<string, unknown> = {}) =>
    song({ meta: { coverUrl: 'https://c/x.jpg', album: 'Church of Scars (Deluxe)', genres: ['Pop', 'Alternativa'], releaseYear: 2018 }, ...over });

  it('carries the provider\'s album, the canonical genres (sorted, synonyms merged) and the release year', async () => {
    m.getUserSongs.mockResolvedValue(new Map([[KEY, dated()]]));
    expect(await manifestTrack()).toMatchObject({ album: 'Church of Scars (Deluxe)', genres: ['Alternative', 'Pop'], year: 2018 });
  });

  it('falls back to the mention\'s album; unknown genres and year are empty / null, never missing', async () => {
    const track = await manifestTrack(); // song(): mention album only, meta without genres or year
    expect(track.album).toBe('Church of Scars');
    expect(track.genres).toEqual([]);
    expect(track.year).toBeNull();
    expect(Object.keys(track)).toEqual(expect.arrayContaining(['album', 'genres', 'year']));
  });

  it('a song with no metadata at all and no album is still a valid track', async () => {
    m.getUserSongs.mockResolvedValue(new Map([[KEY, song({ album: null, meta: null })]]));
    expect(await manifestTrack()).toMatchObject({ album: null, genres: [], year: null });
  });

  it('GET one song carries them too, and so does the placeholder of an unknown key', async () => {
    m.getUserSongs.mockResolvedValue(new Map([[KEY, dated()]]));
    expect(await getTrack(KEY, 'mike')).toMatchObject({ album: 'Church of Scars (Deluxe)', genres: ['Alternative', 'Pop'], year: 2018 });
    m.getPlaylist.mockResolvedValue({ id: 'p1', name: 'Auto', songKeys: ['ghost::song'] });
    expect((await buildPlaylistOfflineManifest('p1', 'mike'))!.tracks[0]).toMatchObject({ album: null, genres: [], year: null });
  });

  describe('buildTracks (one page of the library)', () => {
    const other = song({ songKey: 'a::b', title: 'B', artist: 'A', album: null, meta: null });

    it('builds the tracks of the songs given, in that order, with the user\'s plays and no lyrics', async () => {
      m.getSongPlayStats.mockResolvedValue(new Map([['a::b', { plays: 7, lastPlayedAt: '2026-11-05T21:03:11Z' }]]));
      const tracks = await buildTracks([other, dated()], 'mike');
      expect(tracks.map((t) => t.songKey)).toEqual(['a::b', KEY]);
      expect(tracks[0]).toMatchObject({ plays: 7, state: 'missing' });
      expect(tracks[1]).toMatchObject({ year: 2018, lyrics: null });
      expect(m.getSongFiles).toHaveBeenCalledWith(['a::b', KEY]);
      expect(m.getSongPlayStats).toHaveBeenCalledWith('mike', ['a::b', KEY]);
    });

    it('reads state only: nothing is queued or written', async () => {
      await buildTracks([dated()], 'mike');
      expect(m.enqueueSongDownload).not.toHaveBeenCalled();
      expect(m.markReady).not.toHaveBeenCalled();
      expect(m.wakeSongDownloader).not.toHaveBeenCalled();
    });

    it('shows a song that is ready from the library as ready', async () => {
      await writeSong();
      m.findLibraryMatch.mockResolvedValue({ relPath: 'SoundReel/Bishop Briggs - White Flag.mp3', facts: { bytes: 10, mtimeMs: 5 } });
      expect((await buildTracks([dated()], 'mike'))[0]).toMatchObject({ state: 'ready', bytes: 10, downloadPath: songFilePath(KEY) });
    });

    it('no songs, no work', async () => {
      expect(await buildTracks([], 'mike')).toEqual([]);
      expect(m.getSongFiles).not.toHaveBeenCalled();
      expect(m.getSongPlayStats).not.toHaveBeenCalled();
    });
  });
});

describe('manifest: what a track looks like in each state', () => {
  it('ready from a recorded file: live size/version, legacy status, download path, replica only when verified and unchanged', async () => {
    await writeSong();
    m.getSongFiles.mockResolvedValue(new Map([[KEY, row({
      status: 'ready', source: 'ytdlp', relPath: 'SoundReel/Bishop Briggs - White Flag.mp3', bytes: 10, durationS: 231,
      mediaUrl: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/x.mp3', publishedAt: new Date(),
    })]]));
    const t = await manifestTrack();
    expect(t).toMatchObject({
      songKey: KEY, status: 'ready', state: 'ready', source: 'ytdlp', bytes: 10, durationS: 231, error: null,
      downloadPath: '/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/file',
      mediaUrl: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/x.mp3', coverUrl: 'https://c/x.jpg', canEnqueueSpooty: false,
    });
    expect(t.version).toMatch(/^10-\d+$/);
    expect(songFilePath(KEY)).toBe(t.downloadPath);
  });

  it('never advertises a replica that is not the file we have now (or was not verified)', async () => {
    await writeSong();
    const base = { status: 'ready', source: 'ytdlp', relPath: 'SoundReel/Bishop Briggs - White Flag.mp3', mediaUrl: 'http://x/y.mp3' };
    m.getSongFiles.mockResolvedValue(new Map([[KEY, row({ ...base, bytes: 999, publishedAt: new Date() })]])); // size differs
    expect((await manifestTrack()).mediaUrl).toBeNull();
    m.getSongFiles.mockResolvedValue(new Map([[KEY, row({ ...base, bytes: 10, publishedAt: null })]])); // never verified
    expect((await manifestTrack()).mediaUrl).toBeNull();
  });

  it('ready from the library with no row yet, and the GET does not write anything', async () => {
    await writeSong('Church of Scars/Bishop Briggs - White Flag.mp3');
    m.findLibraryMatch.mockResolvedValue({ relPath: 'Church of Scars/Bishop Briggs - White Flag.mp3', facts: { bytes: 10, mtimeMs: 5 } });
    const t = await manifestTrack();
    expect(t).toMatchObject({ state: 'ready', status: 'ready', source: 'library', bytes: 10, version: '10-5', mediaUrl: null });
    expect(m.markReady).not.toHaveBeenCalled();
    expect(m.enqueueSongDownload).not.toHaveBeenCalled();
  });

  it.each([
    ['queued', 'preparing', null],
    ['downloading', 'preparing', null],
    ['failed', 'failed', 'HTTP 403'],
    ['no_source', 'no_source', 'serve un link YouTube'],
  ])('a %s job is %s (legacy status stays "missing")', async (status, state, error) => {
    m.getSongFiles.mockResolvedValue(new Map([[KEY, row({ status, error })]]));
    const t = await manifestTrack();
    expect(t).toMatchObject({ state, status: 'missing', error, downloadPath: null, mediaUrl: null, version: null, bytes: null });
  });

  it('a song Spooty is still downloading is "preparing", not "missing" (no duplicate YouTube copy)', async () => {
    m.listOpenSpootyEntryIds.mockResolvedValue(new Set(['e1']));
    expect(await manifestTrack()).toMatchObject({ state: 'preparing', source: 'none' });
  });

  it('nothing known is missing; a file that vanished says so; unknown keys get a placeholder', async () => {
    expect(await manifestTrack()).toMatchObject({ state: 'missing', status: 'missing', error: null });
    m.getSongFiles.mockResolvedValue(new Map([[KEY, row({ status: 'ready', relPath: 'SoundReel/gone.mp3', bytes: 3, source: 'ytdlp' })]]));
    expect(await manifestTrack()).toMatchObject({ state: 'missing', error: 'file non più presente' });
    m.getPlaylist.mockResolvedValue({ id: 'p1', name: 'Auto', songKeys: ['ghost::song'] });
    expect((await manifestTrack())).toMatchObject({ songKey: 'ghost::song', title: 'ghost::song', state: 'missing' });
  });

  it('counts: missingCount is everything not ready (older apps), plus preparing and failed', async () => {
    await writeSong();
    const keys = ['a::ready', 'b::prep', 'c::failed', 'd::nosrc', 'e::none'];
    m.getPlaylist.mockResolvedValue({ id: 'p1', name: 'Auto', songKeys: keys });
    m.getUserSongs.mockResolvedValue(new Map(keys.map((k) => [k, song({ songKey: k, title: k, artist: 'x', mentions: [{ entryId: `e-${k}` }] })])));
    m.getSongFiles.mockResolvedValue(new Map([
      ['a::ready', row({ songKey: 'a::ready', status: 'ready', source: 'ytdlp', relPath: 'SoundReel/Bishop Briggs - White Flag.mp3', bytes: 10 })],
      ['b::prep', row({ songKey: 'b::prep', status: 'queued' })],
      ['c::failed', row({ songKey: 'c::failed', status: 'failed', error: 'x' })],
      ['d::nosrc', row({ songKey: 'd::nosrc', status: 'no_source', error: 'y' })],
    ]));
    const man = (await buildPlaylistOfflineManifest('p1', 'mike'))!;
    expect(man).toMatchObject({ readyCount: 1, missingCount: 4, preparingCount: 1, failedCount: 2 });
  });

  it('null for a playlist the user cannot see', async () => {
    m.getPlaylist.mockResolvedValue(null);
    expect(await buildPlaylistOfflineManifest('nope', 'mike')).toBeNull();
    expect(await preparePlaylist('nope', 'mike')).toBeNull();
  });
});

describe('lyrics', () => {
  it('are skipped on request and cached across polls (a client waiting for songs polls every few seconds)', async () => {
    m.getEntry.mockResolvedValue({ results: { transcript: 'la la la '.repeat(10) } });
    expect((await manifestTrack({ lyrics: false })).lyrics).toBeNull();
    expect(m.getEntry).not.toHaveBeenCalled();

    // fresh entry id: not cached by earlier tests
    m.getUserSongs.mockResolvedValue(new Map([[KEY, song({ mentions: [{ entryId: 'lyrics-entry-1' }] })]]));
    const first = await manifestTrack();
    const second = await manifestTrack();
    expect(first.lyrics).toContain('la la la');
    expect(second.lyrics).toBe(first.lyrics);
    expect(m.getEntry).toHaveBeenCalledTimes(1);
  });
});

describe('prepare: what gets queued', () => {
  it('queues a missing song for sync with a metadata snapshot and wakes the worker', async () => {
    await preparePlaylist('p1', 'mike');
    expect(m.enqueueSongDownload).toHaveBeenCalledWith({
      songKey: KEY, artist: 'Bishop Briggs', title: 'White Flag', album: 'Church of Scars', coverUrl: 'https://c/x.jpg',
      requestedBy: 'mike', priority: PRIORITY_SYNC, retry: false,
    });
    expect(m.wakeSongDownloader).toHaveBeenCalled();
  });

  it('a song already in the library is recorded (so its replica can be published) and never queued', async () => {
    m.findLibraryMatch.mockResolvedValue({ relPath: 'Church of Scars/Bishop Briggs - White Flag.mp3', facts: { bytes: 10, mtimeMs: 5 } });
    await preparePlaylist('p1', 'mike');
    expect(m.markReady).toHaveBeenCalledWith(
      KEY,
      { source: 'library', relPath: 'Church of Scars/Bishop Briggs - White Flag.mp3', bytes: 10, mtimeMs: 5, match: 'name' },
      expect.objectContaining({ artist: 'Bishop Briggs', title: 'White Flag' }),
    );
    expect(m.enqueueSongDownload).not.toHaveBeenCalled();
  });

  it('a ready recorded file is left alone', async () => {
    await writeSong();
    m.getSongFiles.mockResolvedValue(new Map([[KEY, row({ status: 'ready', source: 'ytdlp', relPath: 'SoundReel/Bishop Briggs - White Flag.mp3', bytes: 10 })]]));
    await preparePlaylist('p1', 'mike');
    expect(m.markReady).not.toHaveBeenCalled();
    expect(m.enqueueSongDownload).not.toHaveBeenCalled();
  });

  it('failed songs are retried only when asked to', async () => {
    m.getSongFiles.mockResolvedValue(new Map([[KEY, row({ status: 'failed', error: 'x' })]]));
    await preparePlaylist('p1', 'mike');
    expect(m.enqueueSongDownload.mock.calls[0][0]).toMatchObject({ retry: false });
    await preparePlaylist('p1', 'mike', false, { retryFailed: true });
    expect(m.enqueueSongDownload.mock.calls[1][0]).toMatchObject({ retry: true });
  });

  it('does not start a YouTube download for a song Spooty is delivering (but would if it were not)', async () => {
    m.listOpenSpootyEntryIds.mockResolvedValue(new Set(['e1']));
    await preparePlaylist('p1', 'mike');
    expect(m.enqueueSongDownload).not.toHaveBeenCalled();
    m.listOpenSpootyEntryIds.mockResolvedValue(new Set());
    await preparePlaylist('p1', 'mike');
    expect(m.enqueueSongDownload).toHaveBeenCalledTimes(1);
  });

  it('a file deleted behind our back becomes a job again', async () => {
    m.getSongFiles.mockResolvedValue(new Map([[KEY, row({ status: 'ready', source: 'ytdlp', relPath: 'SoundReel/gone.mp3', bytes: 3 })]]));
    await preparePlaylist('p1', 'mike');
    expect(m.resetToQueued).toHaveBeenCalledWith(KEY);
    expect(m.enqueueSongDownload).toHaveBeenCalledTimes(1);
  });
});

describe('first play (priority "play")', () => {
  const failedAgo = (ms: number) => new Map([[KEY, row({ status: 'failed', error: 'x', updatedAt: new Date(Date.now() - ms) })]]);

  it('jumps the queue, returns the track, and wakes the worker', async () => {
    m.getSongFile.mockResolvedValue(row({ status: 'queued' }));
    const track = await requestSongDownload(KEY, 'mike', { priority: 'play' });
    expect(m.enqueueSongDownload).toHaveBeenCalledWith(expect.objectContaining({ priority: PRIORITY_PLAY, requestedBy: 'mike' }));
    expect(m.wakeSongDownloader).toHaveBeenCalled();
    expect(track).toMatchObject({ songKey: KEY, state: 'preparing' });
  });

  it('does not hammer YouTube for a song that failed a minute ago, but tries again after the cooldown', async () => {
    m.getSongFile.mockResolvedValue(failedAgo(60_000).get(KEY));
    await requestSongDownload(KEY, 'mike', { priority: 'play' });
    expect(m.enqueueSongDownload.mock.calls[0][0]).toMatchObject({ retry: false });
    m.getSongFile.mockResolvedValue(failedAgo(11 * 60_000).get(KEY));
    await requestSongDownload(KEY, 'mike', { priority: 'play' });
    expect(m.enqueueSongDownload.mock.calls[1][0]).toMatchObject({ retry: true });
  });

  it('an explicit retry always retries; unknown songs are null', async () => {
    m.getSongFile.mockResolvedValue(failedAgo(1_000).get(KEY));
    await requestSongDownload(KEY, 'mike', { priority: 'sync', retry: true });
    expect(m.enqueueSongDownload.mock.calls[0][0]).toMatchObject({ priority: PRIORITY_SYNC, retry: true });
    expect(await requestSongDownload('ghost::song', 'mike')).toBeNull();
    expect(await getTrack('ghost::song', 'mike')).toBeNull();
  });
});

describe('setSongSource', () => {
  it.each([
    ['https://www.youtube.com/watch?v=syhBqULC99I', true],
    ['https://youtu.be/syhBqULC99I?si=x', true],
    ['https://music.youtube.com/watch?v=syhBqULC99I&list=abc', true],
    ['https://www.youtube.com/shorts/syhBqULC99I', true],
    ['https://evil.example/watch?v=syhBqULC99I', false],
    ['https://youtube.com.evil.example/watch?v=syhBqULC99I', false],
    ['https://www.youtube.com/results?search_query=x', false],
    ['https://www.youtube.com/watch?v=short', false],
    ['javascript:alert(1)', false],
    ['', false],
  ])('isYoutubeVideoUrl(%s) = %s', (url, ok) => expect(isYoutubeVideoUrl(url)).toBe(ok));

  it('forces the video, requeues the song at play priority, wakes the worker', async () => {
    expect(await setSongSource(KEY, 'mike', ' https://youtu.be/syhBqULC99I ')).toEqual({ ok: true });
    expect(m.enqueueSongDownload).toHaveBeenCalledWith(expect.objectContaining({ priority: PRIORITY_PLAY, retry: true }));
    expect(m.setVideoOverride).toHaveBeenCalledWith(KEY, 'https://youtu.be/syhBqULC99I');
    expect(m.wakeSongDownloader).toHaveBeenCalled();
  });

  it('refuses a non-YouTube link before touching anything, and unknown songs', async () => {
    expect(await setSongSource(KEY, 'mike', 'https://evil.example/x')).toEqual({ ok: false, reason: 'bad_url' });
    expect(await setSongSource('ghost::song', 'mike', 'https://youtu.be/syhBqULC99I')).toEqual({ ok: false, reason: 'song_not_found' });
    expect(m.setVideoOverride).not.toHaveBeenCalled();
  });
});

const BOX = 'http://192.168.178.10:49200/AUDIO/DLNA-1-0';
const nightcall = (over: Record<string, unknown> = {}) => row({
  status: 'ready', source: 'mediaserver', relPath: null, bytes: 6109100, mtimeMs: 1_781_000_000_000,
  mediaRelPath: 'Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3', mediaUrl: `${BOX}/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3`, publishedAt: new Date(), ...over,
});

describe('a song that IS a file of the media server (ADR-0010: nothing copied)', () => {
  it('is a ready track: size and version from the box, the box\'s URL, and the documented `existing` source', async () => {
    m.getSongFiles.mockResolvedValue(new Map([[KEY, nightcall()]]));
    expect(await manifestTrack()).toMatchObject({
      status: 'ready', state: 'ready', source: 'existing', bytes: 6109100, version: '6109100-1781000000000', error: null,
      downloadPath: '/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/file',
      mediaUrl: `${BOX}/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3`,
    });
  });

  it('a row with no local file and no media location is NOT ready (it would be a lie)', async () => {
    m.getSongFiles.mockResolvedValue(new Map([[KEY, nightcall({ mediaRelPath: null, mediaUrl: null, publishedAt: null })]]));
    expect((await manifestTrack()).state).not.toBe('ready');
  });
});

describe('resolveSongServing (what the file routes serve, and from where)', () => {
  const origin = (o: { kind: string }) => o.kind;

  it('a local file recorded for the song, with its live version (the library match is the fallback)', async () => {
    await writeSong();
    m.getSongFile.mockResolvedValue(row({ status: 'ready', source: 'ytdlp', relPath: 'SoundReel/Bishop Briggs - White Flag.mp3', bytes: 10 }));
    const res = await resolveSongServing(KEY, 'mike');
    expect(res).toMatchObject({ ok: true, served: { filename: 'Bishop Briggs - White Flag.mp3', origins: [{ kind: 'local', absPath: path.join(lib, 'SoundReel', 'Bishop Briggs - White Flag.mp3') }] } });
    expect(res.ok && res.served.version).toMatch(/^10-\d+$/);
  });

  it('the web asks media first, Mondrop asks the disk first, when a song is in both places', async () => {
    await writeSong();
    m.getSongFile.mockResolvedValue(row({
      status: 'ready', source: 'ytdlp', relPath: 'SoundReel/Bishop Briggs - White Flag.mp3', bytes: 10,
      mediaUrl: `${BOX}/Music/SoundReel/SoundReel/Bishop%20Briggs%20-%20White%20Flag.mp3`, publishedAt: new Date(),
    }));
    const web = await resolveSongServing(KEY, 'mike', false, ORDER_WEB);
    const phone = await resolveSongServing(KEY, 'mike', false, ORDER_MONDROP);
    expect(web.ok && web.served.origins.map(origin)).toEqual(['media', 'local']);
    expect(phone.ok && phone.served.origins.map(origin)).toEqual(['local', 'media']);
    expect(web.ok && web.served.origins[0]).toEqual({ kind: 'media', url: `${BOX}/Music/SoundReel/SoundReel/Bishop%20Briggs%20-%20White%20Flag.mp3` });
    // one origin only (?from=fs / ?from=media)
    const onlyDisk = await resolveSongServing(KEY, 'mike', false, ['local']);
    expect(onlyDisk.ok && onlyDisk.served.origins.map(origin)).toEqual(['local']);
    const onlyBox = await resolveSongServing(KEY, 'mike', false, ['media']);
    expect(onlyBox.ok && onlyBox.served.origins.map(origin)).toEqual(['media']);
  });

  it('a song that is only on the box is served from the box, named after the box\'s file', async () => {
    m.getSongFile.mockResolvedValue(nightcall());
    const res = await resolveSongServing(KEY, 'mike');
    expect(res).toMatchObject({
      ok: true,
      served: { filename: '01 - 2-01 Nightcall.mp3', version: '6109100-1781000000000', origins: [{ kind: 'media', url: `${BOX}/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3` }] },
    });
    // the disk has nothing for it: asking for the disk only finds nothing
    expect(await resolveSongServing(KEY, 'mike', false, ['local'])).toEqual({ ok: false, reason: 'file_not_ready' });
  });

  it('a song that is on the box but nobody asked a download for plays from there: no row, no copy, no database write', async () => {
    m.findMediaServerMatch.mockResolvedValue({ relPath: 'Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3', bytes: 6109100, durationS: null });
    const res = await resolveSongServing(KEY, 'mike');
    expect(res).toMatchObject({ ok: true, served: { filename: '01 - 2-01 Nightcall.mp3', version: '6109100-0', origins: [{ kind: 'media', url: `${BOX}/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3` }] } });
    expect(m.markReady).not.toHaveBeenCalled();
    expect(m.enqueueSongDownload).not.toHaveBeenCalled();
  });

  it('falls back to the library match, and says why when there is nothing (never a path from user input)', async () => {
    await writeSong('Church of Scars/Bishop Briggs - White Flag.mp3');
    m.findLibraryMatch.mockResolvedValue({ relPath: 'Church of Scars/Bishop Briggs - White Flag.mp3', facts: { bytes: 10, mtimeMs: 5 } });
    expect(await resolveSongServing(KEY, 'mike')).toMatchObject({ ok: true, served: { filename: 'Bishop Briggs - White Flag.mp3', version: '10-5' } });
    m.findLibraryMatch.mockResolvedValue(null);
    expect(await resolveSongServing(KEY, 'mike')).toEqual({ ok: false, reason: 'file_not_ready' });
    expect(await resolveSongServing('ghost::song', 'mike')).toEqual({ ok: false, reason: 'song_not_found' });
  });

  it('a recorded path that escapes the library is never served', async () => {
    m.getSongFile.mockResolvedValue(row({ status: 'ready', source: 'ytdlp', relPath: '../../etc/passwd', bytes: 1 }));
    expect(await resolveSongServing(KEY, 'mike')).toEqual({ ok: false, reason: 'file_not_ready' });
  });
});

describe('legacy Spooty enqueue', () => {
  it('reports why it cannot, and sends the link when it can', async () => {
    expect(await enqueueSongToSpooty('ghost::song', 'mike')).toEqual({ ok: false, reason: 'song_not_found' });
    expect(await enqueueSongToSpooty(KEY, 'mike')).toEqual({ ok: false, reason: 'no_spotify_url' });
    m.getUserSongs.mockResolvedValue(new Map([[KEY, song({ spotifyUrl: 'https://open.spotify.com/track/1' })]]));
    m.postToSpooty.mockResolvedValue(true);
    expect(await enqueueSongToSpooty(KEY, 'mike')).toEqual({ ok: true });
    m.postToSpooty.mockResolvedValue(false);
    expect(await enqueueSongToSpooty(KEY, 'mike')).toEqual({ ok: false, reason: 'spooty_failed' });
  });
});

describe('a song that is not in the cached list yet (an entry created seconds ago)', () => {
  it('is looked up once more from the journal before giving up', async () => {
    m.getUserSongs
      .mockResolvedValueOnce(new Map()) // the 15 s cache does not know it
      .mockResolvedValueOnce(new Map([[KEY, song()]])); // the fresh read does
    const track = await getTrack(KEY, 'mike');
    expect(track).toMatchObject({ songKey: KEY });
    expect(m.getUserSongs.mock.calls).toEqual([['mike', false], ['mike', false, 0]]);
  });

  it('a really unknown song costs exactly one extra read and is null', async () => {
    m.getUserSongs.mockResolvedValue(new Map());
    expect(await getTrack('ghost::song', 'mike')).toBeNull();
    expect(m.getUserSongs).toHaveBeenCalledTimes(2);
  });
});
