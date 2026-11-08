import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  claimNextDownloads: vi.fn(),
  deferJob: vi.fn(),
  markAttemptFailed: vi.fn(),
  markReady: vi.fn(),
  releaseStaleDownloads: vi.fn(),
  findLibraryMatch: vi.fn(),
  findMediaServerMatch: vi.fn(),
  adoptMediaServerFile: vi.fn(),
  requestYtAudio: vi.fn(),
  invalidateLibraryTracks: vi.fn(),
  patchSongUserMeta: vi.fn(),
  requestMediaPublish: vi.fn(),
  retireMediaServerCopies: vi.fn(),
  logActivity: vi.fn(),
}));
vi.mock('./songFiles', () => ({
  claimNextDownloads: m.claimNextDownloads,
  deferJob: m.deferJob,
  markAttemptFailed: m.markAttemptFailed,
  markReady: m.markReady,
  releaseStaleDownloads: m.releaseStaleDownloads,
}));
vi.mock('./fileResolver', async (orig) => ({
  ...(await orig<typeof import('./fileResolver')>()),
  findLibraryMatch: m.findLibraryMatch,
  findMediaServerMatch: m.findMediaServerMatch,
  adoptMediaServerFile: m.adoptMediaServerFile,
}));
vi.mock('./ytAudioClient', () => ({
  requestYtAudio: m.requestYtAudio,
  stagingDir: () => process.env.STAGING_DIR ?? '/nonexistent/_staging',
}));
vi.mock('./libraryCache', () => ({ invalidateLibraryTracks: m.invalidateLibraryTracks }));
vi.mock('./mediaPublish', () => ({ requestMediaPublish: m.requestMediaPublish }));
vi.mock('./retireCopies', () => ({ retireMediaServerCopies: m.retireMediaServerCopies }));
vi.mock('./activityLog', async (orig) => ({ ...(await orig<typeof import('./activityLog')>()), logActivity: m.logActivity }));
vi.mock('./songMeta', () => ({ patchSongUserMeta: m.patchSongUserMeta }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { failurePlan, processDownload, startSongDownloader, sweepLeftovers, VOLUME_WAIT_MS, wakeSongDownloader } from './songDownloader';
import { MIN_MP3_BYTES } from './musicStore';
import { MediaVolumeMissingError } from './fileResolver';

let lib: string;
let staging: string;

const job = (over: Record<string, unknown> = {}) =>
  ({
    songKey: 'bishop briggs::white flag', artist: 'Bishop Briggs', title: 'White Flag', album: 'Church of Scars', coverUrl: 'c',
    expectedDurationS: 230, videoUrlOverride: null, relPath: null, attempts: 0, ...over,
  }) as never;

const stagedMp3 = async (name = 'sf-1.mp3'): Promise<string> => {
  const p = path.join(staging, name);
  const b = Buffer.alloc(MIN_MP3_BYTES + 10, 0x41);
  b.write('ID3', 0, 'latin1');
  await writeFile(p, b);
  return p;
};

beforeEach(async () => {
  vi.clearAllMocks();
  lib = await mkdtemp(path.join(tmpdir(), 'dl-lib-'));
  staging = await mkdtemp(path.join(tmpdir(), 'dl-stage-'));
  process.env.MUSIC_LIBRARY_PATH = lib;
  delete process.env.MUSIC_STORE_DIR;
  m.findLibraryMatch.mockResolvedValue(null);
  m.findMediaServerMatch.mockResolvedValue(null);
  m.markReady.mockResolvedValue({});
  m.markAttemptFailed.mockResolvedValue(undefined);
  m.patchSongUserMeta.mockResolvedValue({});
  m.releaseStaleDownloads.mockResolvedValue(0);
  m.claimNextDownloads.mockResolvedValue([]);
  m.adoptMediaServerFile.mockResolvedValue(null);
  m.retireMediaServerCopies.mockResolvedValue({ retired: 0, kept: 0 });
});
afterEach(async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  delete process.env.STAGING_DIR;
  await rm(lib, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
});

describe('failurePlan', () => {
  it('gives up on songs that need a person: no source, age gate, unavailable', () => {
    expect(failurePlan('no_source', 'x', 1)).toEqual({ error: expect.stringContaining('link YouTube'), terminal: 'no_source' });
    expect(failurePlan('age_restricted', 'x', 1)).toMatchObject({ terminal: 'no_source', error: expect.stringContaining("età") });
    expect(failurePlan('unavailable', 'x', 1)).toMatchObject({ terminal: 'no_source' });
    expect(failurePlan('bad_request', 'x', 1)).toMatchObject({ terminal: 'failed' });
  });

  it('retries transient errors with a growing delay, then fails for good', () => {
    expect(failurePlan('error', 'boom', 1)).toEqual({ error: 'boom', retryInMs: 30_000 });
    expect(failurePlan('transport', 'boom', 2)).toMatchObject({ retryInMs: 2 * 60_000 });
    expect(failurePlan('ffmpeg', 'boom', 3)).toMatchObject({ retryInMs: 10 * 60_000 });
    expect(failurePlan('error', 'boom', 4)).toMatchObject({ retryInMs: 60 * 60_000 });
    expect(failurePlan('error', 'boom', 5)).toEqual({ error: 'boom', terminal: 'failed' });
  });

  it('backs off much longer when YouTube is blocking us', () => {
    expect(failurePlan('blocked', 'HTTP 403', 1)).toMatchObject({ retryInMs: 5 * 60_000 });
    expect(failurePlan('blocked', 'HTTP 403', 3)).toMatchObject({ retryInMs: 60 * 60_000 });
    expect(failurePlan('blocked', 'HTTP 403', 4)).toMatchObject({ terminal: 'failed' });
  });
});

describe('processDownload', () => {
  it('REUSES a library file that appeared meanwhile: nothing is downloaded', async () => {
    m.findLibraryMatch.mockResolvedValue({ relPath: 'Church of Scars/Bishop Briggs - White Flag.mp3', facts: { bytes: 5, mtimeMs: 7 } });
    expect(await processDownload(job())).toBe('ready');
    expect(m.requestYtAudio).not.toHaveBeenCalled();
    expect(m.markReady).toHaveBeenCalledWith(
      'bishop briggs::white flag',
      { source: 'library', relPath: 'Church of Scars/Bishop Briggs - White Flag.mp3', bytes: 5, mtimeMs: 7, match: 'name' },
      expect.objectContaining({ artist: 'Bishop Briggs', title: 'White Flag' }),
    );
    expect(m.invalidateLibraryTracks).toHaveBeenCalled();
    expect(m.patchSongUserMeta).toHaveBeenCalledWith('bishop briggs::white flag', { downloaded: true });
  });

  it('ADOPTS the media server\'s file when the song is there: nothing is copied, nothing is downloaded (ADR-0010)', async () => {
    const hit = { relPath: 'Music/Rock/White Flag.mp3', durationS: 230 };
    m.findMediaServerMatch.mockResolvedValue(hit);
    m.adoptMediaServerFile.mockResolvedValue({
      bytes: 5_100_000, mtimeMs: 1_781_000_000_000, durationS: 230, original: { relPath: 'Music/Rock/White Flag.mp3', url: 'http://box/Music/Rock/White Flag.mp3' },
    });
    expect(await processDownload(job())).toBe('ready');
    expect(m.adoptMediaServerFile).toHaveBeenCalledWith(hit);
    expect(m.requestYtAudio).not.toHaveBeenCalled();
    expect(m.requestMediaPublish).not.toHaveBeenCalled(); // it is on the box already: no push needed
    expect(await readdir(lib)).toEqual([]); // not a byte written to the disk
    expect(m.markReady).toHaveBeenCalledWith(
      'bishop briggs::white flag',
      // no local file; the box's file is the song, published at once
      { source: 'mediaserver', relPath: null, bytes: 5_100_000, mtimeMs: 1_781_000_000_000, match: 'index', durationS: 230, original: { relPath: 'Music/Rock/White Flag.mp3', url: 'http://box/Music/Rock/White Flag.mp3' } },
      expect.anything(),
    );
    expect(m.logActivity).toHaveBeenCalledWith('download', 'done', expect.stringContaining('già sul media server'), expect.anything(), expect.objectContaining({ source: 'mediaserver' }));
  });

  it('goes to YouTube when the box no longer has the file (vanished since the last scan) or adopting blows up', async () => {
    m.findMediaServerMatch.mockResolvedValue({ relPath: 'Music/Rock/White Flag.mp3', durationS: null });
    m.requestYtAudio.mockResolvedValue({ ok: false, code: 'no_source', error: 'nessun video adatto trovato' });
    m.adoptMediaServerFile.mockResolvedValue(null);
    expect(await processDownload(job())).toBe('no_source');
    m.adoptMediaServerFile.mockRejectedValue(new Error('boom'));
    expect(await processDownload(job())).toBe('no_source');
    expect(m.requestYtAudio).toHaveBeenCalledTimes(2);
  });

  it('a song that is on the box WAITS when the box\'s USB drive is unplugged: deferred without an attempt, no YouTube duplicate', async () => {
    m.findMediaServerMatch.mockResolvedValue({ relPath: 'Music/Rock/White Flag.mp3', durationS: null });
    m.adoptMediaServerFile.mockRejectedValue(new MediaVolumeMissingError());
    expect(await processDownload(job())).toBe('retry');
    expect(m.deferJob).toHaveBeenCalledWith('bishop briggs::white flag', VOLUME_WAIT_MS, expect.stringContaining('chiavetta'));
    expect(m.requestYtAudio).not.toHaveBeenCalled();
    expect(m.markAttemptFailed).not.toHaveBeenCalled(); // not a failure: nothing counts towards "failed"
    expect(m.markReady).not.toHaveBeenCalled();
  });

  it('a person-chosen video skips every reuse path and downloads exactly that', async () => {
    m.findLibraryMatch.mockResolvedValue({ relPath: 'x.mp3', facts: { bytes: 1, mtimeMs: 1 } });
    m.requestYtAudio.mockResolvedValue({ ok: true, path: await stagedMp3(), bytes: 1, durationS: 231, videoId: 'syhBqULC99I', videoTitle: null, channel: null, score: 99, tagged: true });
    expect(await processDownload(job({ videoUrlOverride: 'https://youtu.be/syhBqULC99I' }))).toBe('ready');
    expect(m.findLibraryMatch).not.toHaveBeenCalled();
    expect(m.requestYtAudio).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: 'https://youtu.be/syhBqULC99I' }));
    expect(m.markReady).toHaveBeenCalledWith('bishop briggs::white flag', expect.objectContaining({ source: 'ytdlp', match: 'override', videoId: 'syhBqULC99I' }), expect.anything());
  });

  it('downloads from YouTube into <library>/SoundReel and records it', async () => {
    m.requestYtAudio.mockResolvedValue({ ok: true, path: await stagedMp3(), bytes: MIN_MP3_BYTES + 10, durationS: 231, videoId: 'RWzZeA2GMsk', videoTitle: 't', channel: 'c', score: 15.2, tagged: true });

    expect(await processDownload(job({ expectedDurationS: 230 }))).toBe('ready');

    expect(await readdir(path.join(lib, 'SoundReel'))).toEqual(['Bishop Briggs - White Flag.mp3']);
    expect(await readdir(staging)).toEqual([]);
    expect(m.requestYtAudio).toHaveBeenCalledWith({
      songKey: 'bishop briggs::white flag', artist: 'Bishop Briggs', title: 'White Flag', album: 'Church of Scars', coverUrl: 'c', expectedDurationS: 230, videoUrl: null,
    });
    expect(m.markReady).toHaveBeenCalledWith(
      'bishop briggs::white flag',
      expect.objectContaining({ source: 'ytdlp', relPath: 'SoundReel/Bishop Briggs - White Flag.mp3', bytes: MIN_MP3_BYTES + 10, match: 'search', videoId: 'RWzZeA2GMsk', durationS: 231 }),
      expect.anything(),
    );
    expect(m.invalidateLibraryTracks).toHaveBeenCalled();
    // the web "puts it on the media server": the finished download asks for a push of the store to the box
    expect(m.requestMediaPublish).toHaveBeenCalledTimes(1);
    expect(m.logActivity).toHaveBeenCalledWith('download', 'done', expect.stringContaining('scaricata da YouTube'), expect.anything(), expect.objectContaining({ source: 'ytdlp' }));
  });

  it('a library hit is not pushed on demand (the nightly mirror carries it)', async () => {
    m.findLibraryMatch.mockResolvedValue({ relPath: 'A/B.mp3', facts: { bytes: 5, mtimeMs: 7 } });
    await processDownload(job());
    expect(m.requestMediaPublish).not.toHaveBeenCalled();
  });

  it('replaces the song’s own earlier file instead of piling up copies', async () => {
    await mkdir(path.join(lib, 'SoundReel'), { recursive: true });
    await writeFile(path.join(lib, 'SoundReel', 'Bishop Briggs - White Flag.mp3'), 'old');
    m.requestYtAudio.mockResolvedValue({ ok: true, path: await stagedMp3(), bytes: 1, durationS: null, videoId: 'x', videoTitle: null, channel: null, score: 1, tagged: false });
    expect(await processDownload(job({ relPath: 'SoundReel/Bishop Briggs - White Flag.mp3' }))).toBe('ready');
    expect(await readdir(path.join(lib, 'SoundReel'))).toEqual(['Bishop Briggs - White Flag.mp3']);
  });

  it.each([
    ['no_source', 'no_source'],
    ['age_restricted', 'no_source'],
    ['blocked', 'retry'],
    ['transport', 'retry'],
  ] as const)('a %s answer from YouTube ends as %s and is recorded', async (code, outcome) => {
    m.requestYtAudio.mockResolvedValue({ ok: false, code, error: 'x' });
    expect(await processDownload(job())).toBe(outcome);
    expect(m.markAttemptFailed).toHaveBeenCalledTimes(1);
    expect(m.markAttemptFailed.mock.calls[0][0]).toBe('bishop briggs::white flag');
    expect(m.markReady).not.toHaveBeenCalled();
  });

  it('fails for good on the fifth transient failure', async () => {
    m.requestYtAudio.mockResolvedValue({ ok: false, code: 'error', error: 'boom' });
    expect(await processDownload(job({ attempts: 4 }))).toBe('failed');
    expect(m.markAttemptFailed).toHaveBeenCalledWith('bishop briggs::white flag', { error: 'boom', terminal: 'failed' });
  });

  it('only the END of a failing song reaches the activity trail (retries would drown it)', async () => {
    m.requestYtAudio.mockResolvedValue({ ok: false, code: 'error', error: 'boom' });
    await processDownload(job({ attempts: 0 }));
    expect(m.logActivity).not.toHaveBeenCalled();
    await processDownload(job({ attempts: 4, requestedBy: 'mike' }));
    expect(m.logActivity).toHaveBeenCalledWith('download', 'failed', expect.stringContaining('boom'), expect.anything(), expect.objectContaining({ songKey: 'bishop briggs::white flag', terminal: 'failed', requestedBy: 'mike' }));
  });

  it('refuses a file that is not an MP3 (and does not leave it in staging)', async () => {
    const bad = path.join(staging, 'sf-bad.mp3');
    await writeFile(bad, 'tiny');
    m.requestYtAudio.mockResolvedValue({ ok: true, path: bad, bytes: 4, durationS: null, videoId: 'x', videoTitle: null, channel: null, score: 1, tagged: false });
    expect(await processDownload(job())).toBe('retry');
    expect(m.markReady).not.toHaveBeenCalled();
    expect(await readdir(staging)).toEqual([]);
    expect(m.markAttemptFailed.mock.calls[0][1]).toMatchObject({ error: expect.stringContaining('download non valido') });
  });

  it('never throws: an unexpected error becomes a retry', async () => {
    m.findLibraryMatch.mockRejectedValue(new Error('disk gone'));
    expect(await processDownload(job())).toBe('retry');
    expect(m.markAttemptFailed).toHaveBeenCalledWith('bishop briggs::white flag', { error: 'disk gone', retryInMs: 30_000 });
    // …even when recording the failure fails too
    m.markAttemptFailed.mockRejectedValue(new Error('db down'));
    expect(await processDownload(job())).toBe('retry');
  });

  it('a failure to set the downloaded flag does not undo a finished download', async () => {
    m.findLibraryMatch.mockResolvedValue({ relPath: 'a.mp3', facts: { bytes: 1, mtimeMs: 1 } });
    m.patchSongUserMeta.mockRejectedValue(new Error('meta down'));
    expect(await processDownload(job())).toBe('ready');
  });
});

describe('worker loop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('requeues what a dead process left in "downloading", then claims no more than the free slots', async () => {
    let release: () => void = () => undefined;
    m.claimNextDownloads
      .mockResolvedValueOnce([job({ songKey: 'a::1' }), job({ songKey: 'b::2' })])
      .mockResolvedValue([]);
    m.findLibraryMatch.mockImplementation(() => new Promise((resolve) => { release = () => resolve(null); }));
    m.requestYtAudio.mockResolvedValue({ ok: false, code: 'no_source', error: 'x' });

    const stop = startSongDownloader({ concurrency: 2, pollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(m.releaseStaleDownloads).toHaveBeenCalledWith(0);
    expect(m.claimNextDownloads).toHaveBeenCalledWith(2);

    // both slots are busy: the next poll must not claim anything
    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.claimNextDownloads).toHaveBeenCalledTimes(1);

    stop();
    release();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('retires the 2.7.0 copies shortly after the start and then every few hours', async () => {
    const stop = startSongDownloader({ concurrency: 1, pollMs: 60_000 });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(m.retireMediaServerCopies).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(m.retireMediaServerCopies).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(m.retireMediaServerCopies).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000);
    expect(m.retireMediaServerCopies).toHaveBeenCalledTimes(2); // stopped
  });

  it('wake() starts the queue at once instead of waiting for the poll', async () => {
    const stop = startSongDownloader({ concurrency: 2, pollMs: 60_000 });
    await vi.advanceTimersByTimeAsync(10);
    const before = m.claimNextDownloads.mock.calls.length;
    wakeSongDownloader();
    await vi.advanceTimersByTimeAsync(10);
    expect(m.claimNextDownloads.mock.calls.length).toBe(before + 1);
    stop();
    wakeSongDownloader();
    await vi.advanceTimersByTimeAsync(10);
    expect(m.claimNextDownloads.mock.calls.length).toBe(before + 1); // stopped: no more claims
  });

  it('stays off when disabled or when there is no library to write into', () => {
    process.env.SONG_DOWNLOADER_ENABLED = '0';
    startSongDownloader();
    delete process.env.SONG_DOWNLOADER_ENABLED;
    delete process.env.MUSIC_LIBRARY_PATH;
    startSongDownloader();
    expect(m.releaseStaleDownloads).not.toHaveBeenCalled();
  });
});

describe('sweepLeftovers', () => {
  const old = async (p: string, hours: number): Promise<void> => {
    const t = new Date(Date.now() - hours * 3600_000);
    await utimes(p, t, t);
  };

  it('drops half-copied .part files older than an hour and staging downloads older than a day, nothing else', async () => {
    process.env.STAGING_DIR = staging;
    await mkdir(path.join(lib, 'SoundReel'), { recursive: true });
    const store = path.join(lib, 'SoundReel');
    await writeFile(path.join(store, 'Dead - Copy.mp3.part'), 'x');
    await writeFile(path.join(store, 'Live - Copy.mp3.part'), 'x'); // a copy in progress right now
    await writeFile(path.join(store, 'Real - Song.mp3'), 'x'); // never touched, however old
    await old(path.join(store, 'Dead - Copy.mp3.part'), 2);
    await old(path.join(store, 'Real - Song.mp3'), 500);
    await writeFile(path.join(staging, 'sf-abc.mp3'), 'x');
    await writeFile(path.join(staging, 'sf-new.mp3'), 'x');
    await writeFile(path.join(staging, 'other.txt'), 'x');
    await old(path.join(staging, 'sf-abc.mp3'), 30);
    await old(path.join(staging, 'other.txt'), 30);

    expect(await sweepLeftovers()).toBe(2);
    expect((await readdir(store)).sort()).toEqual(['Live - Copy.mp3.part', 'Real - Song.mp3']);
    expect((await readdir(staging)).sort()).toEqual(['other.txt', 'sf-new.mp3']);
  });
});
