import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ getEntry: vi.fn(), getFeaturesConfig: vi.fn(), pool: {}, query: vi.fn() }));
vi.mock('./inbox', () => ({ createInboxItem: vi.fn() }));
vi.mock('./inboxAnnouncer', () => ({ announceInboxItem: vi.fn() }));
vi.mock('./autoPlaylistStore', () => ({ PgAutoPlaylistStore: class PgStub {} }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));
vi.mock('./userSongs', () => ({ getUserSongs: vi.fn() }));

import { query } from '../utils/db';
import { createInboxItem } from './inbox';
import { announceInboxItem } from './inboxAnnouncer';
import { countGenreSongs } from './autoPlaylistWiring';
import { GENRE_SWEEP_EVERY_MS, GENRE_SWEEP_FIRST_RUN_MS } from './genrePlaylistSweep';
import { listLibraryOwners, realGenreSweepDeps, startGenrePlaylistSweep, sweepGenrePlaylistsOnce } from './genrePlaylistSweepWiring';
import { MemoryAutoPlaylistStore } from './autoPlaylists';

const queryMock = vi.mocked(query);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AUTO_PLAYLISTS;
  vi.mocked(announceInboxItem).mockResolvedValue(undefined);
  vi.mocked(createInboxItem).mockResolvedValue({ id: 'i1' } as never);
});
afterEach(() => {
  delete process.env.AUTO_PLAYLISTS;
  vi.useRealTimers();
});

describe('the owners', () => {
  it('are the users who have entries: distinct, never «anonymous», never an empty name', async () => {
    queryMock.mockResolvedValue([{ owner_user: 'mike' }, { owner_user: 'sara' }] as never);
    expect(await listLibraryOwners()).toEqual(['mike', 'sara']);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/SELECT DISTINCT owner_user FROM entries/);
    expect(sql).toMatch(/owner_user <> 'anonymous'/);
    expect(sql).toMatch(/owner_user <> ''/);
    expect(sql).toMatch(/owner_user IS NOT NULL/);
  });

  it('nobody has entries: nobody', async () => {
    queryMock.mockResolvedValue([] as never);
    expect(await listLibraryOwners()).toEqual([]);
  });
});

describe('the real dependencies', () => {
  it('count the library with the SAME function the engine uses before it makes the playlist of a post (the same eyes as the rule)', () => {
    expect(realGenreSweepDeps().countGenreSongs).toBe(countGenreSongs);
  });

  it('use the database store, the owners of the entries and the real clock', () => {
    const before = Date.now();
    const deps = realGenreSweepDeps();
    expect(deps.store.constructor.name).toBe('PgStub');
    expect(deps.listOwners).toBe(listLibraryOwners);
    expect(deps.now().getTime()).toBeGreaterThanOrEqual(before);
    expect(deps.now().getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a birth is a message in the Posta, an `auto_playlist` item with no post to open; the push is only the doorbell', async () => {
    await realGenreSweepDeps().announce({ userId: 'mike', title: 'Nuova playlist: Latina da ascoltare', body: '8 brani', entryId: null });
    expect(createInboxItem).toHaveBeenCalledWith({ userId: 'mike', kind: 'auto_playlist', level: 'info', title: 'Nuova playlist: Latina da ascoltare', body: '8 brani', entryId: null });
    expect(announceInboxItem).toHaveBeenCalledTimes(1);
  });

  it('a doorbell that does not ring does not undo the message', async () => {
    vi.mocked(announceInboxItem).mockRejectedValue(new Error('apns off'));
    await expect(realGenreSweepDeps().announce({ userId: 'mike', title: 't', body: 'b', entryId: null })).resolves.toBeUndefined();
    expect(createInboxItem).toHaveBeenCalledTimes(1);
  });
});

describe('one run, and the kill switch', () => {
  it('AUTO_PLAYLISTS=0 switches the sweep off like the engine: nothing is read, nothing is made', async () => {
    process.env.AUTO_PLAYLISTS = '0';
    const listOwners = vi.fn().mockResolvedValue(['mike']);
    const store = new MemoryAutoPlaylistStore();
    expect(await sweepGenrePlaylistsOnce({ store, countGenreSongs: async () => 9, announce: async () => undefined, now: () => new Date(), listOwners })).toBeNull();
    expect(listOwners).not.toHaveBeenCalled();
    expect(store.playlists.size).toBe(0);
  });

  it('switched on (or any other value) it runs for every owner', async () => {
    process.env.AUTO_PLAYLISTS = '1';
    const store = new MemoryAutoPlaylistStore();
    const run = await sweepGenrePlaylistsOnce({ store, countGenreSongs: async () => 9, announce: async () => undefined, now: () => new Date(), listOwners: async () => ['mike'] });
    expect(run).toMatchObject({ owners: 1, failed: 0 });
    expect(run?.created).toBe(21);
    expect(store.playlists.size).toBe(21);
  });
});

describe('the service', () => {
  it('starts on the schedule: the first run after two minutes, then every 24 hours, and the stop function stops it', async () => {
    vi.useFakeTimers();
    queryMock.mockResolvedValue([] as never);                                     // no owners: a run that only asks who has entries
    const stop = startGenrePlaylistSweep();
    await vi.advanceTimersByTimeAsync(GENRE_SWEEP_FIRST_RUN_MS - 1);
    expect(queryMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GENRE_SWEEP_EVERY_MS);
    expect(queryMock).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(GENRE_SWEEP_EVERY_MS * 3);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('a database that is down at the time of the run is a warning, never a crash, and the next day it tries again', async () => {
    vi.useFakeTimers();
    queryMock.mockRejectedValueOnce(new Error('db down')).mockResolvedValue([] as never);
    const stop = startGenrePlaylistSweep();
    await vi.advanceTimersByTimeAsync(GENRE_SWEEP_FIRST_RUN_MS);
    await vi.advanceTimersByTimeAsync(GENRE_SWEEP_EVERY_MS);
    expect(queryMock).toHaveBeenCalledTimes(2);
    stop();
  });

  it('with the switch off the schedule still ticks but reads nothing', async () => {
    vi.useFakeTimers();
    process.env.AUTO_PLAYLISTS = '0';
    const stop = startGenrePlaylistSweep();
    await vi.advanceTimersByTimeAsync(GENRE_SWEEP_FIRST_RUN_MS + GENRE_SWEEP_EVERY_MS);
    expect(queryMock).not.toHaveBeenCalled();
    stop();
  });
});

describe('the server', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

  it('starts the sweep, once, next to the other workers, and says so', () => {
    expect(server).toContain("import { startGenrePlaylistSweep } from './services/genrePlaylistSweepWiring';");
    expect(server.match(/startGenrePlaylistSweep\(\)/g)).toHaveLength(1);
    expect(server).toMatch(/app\.log\.info\('Genre playlist sweep started/);
  });

  it('stops it at the shutdown with the others', () => {
    const shutdown = server.slice(server.indexOf('const shutdown'));
    expect(shutdown).toContain('stopGenrePlaylistSweep()');
    expect(shutdown.indexOf('stopGenrePlaylistSweep()')).toBeLessThan(shutdown.indexOf('await app.close()'));
  });

  it('starts it after the engine is wired (the job queue worker), not before the database is ready', () => {
    expect(server.indexOf('startGenrePlaylistSweep()')).toBeGreaterThan(server.indexOf('startJobQueueWorker()'));
  });
});
