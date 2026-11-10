import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ getEntry: vi.fn(), getFeaturesConfig: vi.fn(), pool: {}, query: vi.fn() }));
vi.mock('./inbox', () => ({ createInboxItem: vi.fn() }));
vi.mock('./inboxAnnouncer', () => ({ announceInboxItem: vi.fn() }));
vi.mock('./autoPlaylistStore', () => ({ PgAutoPlaylistStore: class {} }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));
vi.mock('./userSongs', () => ({ getUserSongs: vi.fn() }));

import { getFeaturesConfig } from '../utils/db';
import { createInboxItem } from './inbox';
import { announceInboxItem } from './inboxAnnouncer';
import { logWarning } from '../utils/logger';
import { getUserSongs } from './userSongs';
import { autoPlaylistsEnabled, countGenreSongs, onEntryAnalyzed, realAutoPlaylistDeps } from './autoPlaylistWiring';
import { MemoryAutoPlaylistStore, type AutoPlaylistDeps } from './autoPlaylists';
import type { Entry } from '../types';

const song = (title: string) => ({ title, artist: 'Various', album: null, source: 'ai_analysis', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });
const entry = (id: string): Entry =>
  ({ id, sourceUrl: `https://x/${id}`, ownerUser: 'mike', caption: 'c', createdAt: '2026-11-05T10:00:00.000Z', results: { songs: [song('A'), song('B')], films: [], notes: [], links: [], tags: [], summary: 's' } }) as unknown as Entry;

const deps = (over: Partial<AutoPlaylistDeps> = {}): AutoPlaylistDeps => ({
  store: new MemoryAutoPlaylistStore(),
  getEntry: async (id) => entry(id),
  title: async () => ({ aboutMusic: true, title: 'Le 5 musiche di Natale', kind: 'one_off', existingTheme: null }),
  language: async () => 'it',
  countGenreSongs: async () => 0,
  announce: async () => undefined,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(announceInboxItem).mockResolvedValue(undefined);
  delete process.env.AUTO_PLAYLISTS;
});
afterEach(() => {
  delete process.env.AUTO_PLAYLISTS;
});

describe('the kill switch', () => {
  it('AUTO_PLAYLISTS=0 stops everything, and anything else leaves it on', () => {
    expect(autoPlaylistsEnabled()).toBe(true);
    process.env.AUTO_PLAYLISTS = '1';
    expect(autoPlaylistsEnabled()).toBe(true);
    process.env.AUTO_PLAYLISTS = '0';
    expect(autoPlaylistsEnabled()).toBe(false);
  });

  it('with the switch on «off» nothing is even read', async () => {
    process.env.AUTO_PLAYLISTS = '0';
    const getEntry = vi.fn();
    expect(await onEntryAnalyzed('e1', deps({ getEntry }))).toBeNull();
    expect(getEntry).not.toHaveBeenCalled();
  });
});

describe('when an analysis ends', () => {
  it('makes the playlist', async () => {
    expect(await onEntryAnalyzed('e1', deps())).toMatchObject({ status: 'done', title: 'Le 5 musiche di Natale', created: true });
  });

  it('never throws: a database that fails is a warning and no playlist, the analysis is done anyway', async () => {
    const out = await onEntryAnalyzed('e1', deps({ getEntry: async () => { throw new Error('db down'); } }));
    expect(out).toBeNull();
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('automatic playlist failed'), expect.objectContaining({ entryId: 'e1', error: 'db down' }));
  });

  it('one at a time: two analyses that end together do not run together, and a failure of the first does not stop the second', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = deps({ getEntry: (id) => new Promise((resolve, reject) => { order.push(`start ${id}`); releaseFirst = () => { order.push(`fail ${id}`); reject(new Error('x')); }; resolve; }) as never });
    const second = deps({ getEntry: async (id) => { order.push(`start ${id}`); return entry(id); } });
    const a = onEntryAnalyzed('e1', first);
    const b = onEntryAnalyzed('e2', second);
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start e1']);           // e2 waits
    releaseFirst();
    expect(await a).toBeNull();
    expect(await b).toMatchObject({ status: 'done' });
    expect(order).toEqual(['start e1', 'fail e1', 'start e2']);
  });
});

describe('the real wiring', () => {
  it('announces through the inbox: an `info` of kind auto_playlist about that entry, then the doorbell', async () => {
    vi.mocked(createInboxItem).mockResolvedValue({ id: 'i1', userId: 'mike', title: 't', body: 'b', entryId: 'e1' } as never);
    await realAutoPlaylistDeps().announce({ userId: 'mike', entryId: 'e1', title: 'Nuova playlist: X', body: '5 brani' });
    expect(createInboxItem).toHaveBeenCalledWith({ userId: 'mike', kind: 'auto_playlist', level: 'info', title: 'Nuova playlist: X', body: '5 brani', entryId: 'e1' });
    expect(announceInboxItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }));
  });

  it('a doorbell that fails does not fail the message', async () => {
    vi.mocked(createInboxItem).mockResolvedValue({ id: 'i1' } as never);
    vi.mocked(announceInboxItem).mockRejectedValue(new Error('apns off'));
    await expect(realAutoPlaylistDeps().announce({ userId: 'mike', entryId: 'e1', title: 't', body: 'b' })).resolves.toBeUndefined();
  });

  it('writes the title in the language of the interface, Italian when it cannot be read', async () => {
    vi.mocked(getFeaturesConfig).mockResolvedValue({ outputLanguage: 'en' } as never);
    expect(await realAutoPlaylistDeps().language()).toBe('en');
    vi.mocked(getFeaturesConfig).mockResolvedValue({ outputLanguage: 'it' } as never);
    expect(await realAutoPlaylistDeps().language()).toBe('it');
    vi.mocked(getFeaturesConfig).mockRejectedValue(new Error('db'));
    expect(await realAutoPlaylistDeps().language()).toBe('it');
  });
});

describe('countGenreSongs: how many songs of the library carry the genre (the playlist of a genre is born when there are two)', () => {
  const library = (songs: Array<{ key: string; genres?: string[]; meta?: null }>) =>
    new Map(songs.map((x) => [x.key, { songKey: x.key, meta: x.meta === null ? null : { genres: x.genres ?? [] } }])) as unknown as Awaited<ReturnType<typeof getUserSongs>>;

  it('counts the songs whose CANONICAL genre is one of the asked ones: the raw «Soul», «R&B» and «R&B/Soul» are all R&B/Soul', async () => {
    vi.mocked(getUserSongs).mockResolvedValue(library([
      { key: 'a', genres: ['R&B/Soul'] }, { key: 'b', genres: ['Soul'] }, { key: 'c', genres: ['R&B'] }, { key: 'd', genres: ['Rock'] },
    ]));
    expect(await countGenreSongs('mike', ['R&B/Soul'])).toBe(3);
  });

  it('a song with no metadata, or with no genre, has no tag: it is not counted', async () => {
    vi.mocked(getUserSongs).mockResolvedValue(library([{ key: 'a', meta: null }, { key: 'b', genres: [] }, { key: 'c', genres: ['Jazz'] }]));
    expect(await countGenreSongs('mike', ['Jazz'])).toBe(1);
  });

  it('a song counts once even if it has two of the asked genres', async () => {
    vi.mocked(getUserSongs).mockResolvedValue(library([{ key: 'a', genres: ['Rock', 'Hard Rock'] }, { key: 'b', genres: ['Hard rock'] }, { key: 'c', genres: ['Pop'] }]));
    expect(await countGenreSongs('mike', ['Rock', 'Hard Rock'])).toBe(2);
  });

  it('looks at the library of THE OWNER, with no admin eyes (the rule will be read by the same eyes)', async () => {
    vi.mocked(getUserSongs).mockResolvedValue(library([]));
    expect(await countGenreSongs('sara', ['Jazz'])).toBe(0);
    expect(getUserSongs).toHaveBeenCalledWith('sara', false);
  });

  it('the real deps hand the same function to the engine', () => {
    expect(realAutoPlaylistDeps().countGenreSongs).toBe(countGenreSongs);
  });
});
