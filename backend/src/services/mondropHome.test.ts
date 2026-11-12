import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./playlists', () => ({ listPlaylists: vi.fn(), firstSongKeys: vi.fn() }));
vi.mock('./playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveSongKeys: vi.fn() }));
vi.mock('./userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('./offlineManifest', () => ({ buildTracks: vi.fn() }));
vi.mock('./listeningStats', () => ({ getPlayedSongKeys: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { buildHome, displayNameOf, HOME_LIMITS, realHomeDeps, type HomeDeps } from './mondropHome';
import { firstSongKeys, listPlaylists } from './playlists';
import { resolveSongKeys, resolveSummaries } from './playlistResolver';
import { logError } from '../utils/logger';
import type { AggregatedSong, PlaylistSummary } from '../types';
import type { OfflineTrack } from './offlineManifest';

const keyOf = (artist: string, title: string) => `${artist.toLowerCase()}::${title.toLowerCase()}`;

function song(artist: string, title: string, posts: string | string[], extra: Partial<AggregatedSong> = {}): AggregatedSong {
  return {
    songKey: keyOf(artist, title), title, artist, album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: (Array.isArray(posts) ? posts : [posts]).map((createdAt, i) => ({ entryId: `e${i}`, createdAt })),
    meta: null, inLibrary: false, ...extra,
  };
}

type Stored = PlaylistSummary & { ownerUser?: string };
function playlist(id: string, name: string, songCount: number, extra: Partial<Stored> = {}): Stored {
  return { id, name, songCount, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', kind: 'static', ownerUser: 'mike', ...extra };
}

const asTracks = async (songs: AggregatedSong[]): Promise<OfflineTrack[]> =>
  songs.map((s) => ({ songKey: s.songKey, title: s.title, artist: s.artist, mediaUrl: null }) as unknown as OfflineTrack);

function deps(over: Partial<HomeDeps> = {}): HomeDeps {
  return {
    playlists: async () => [],
    coverKeys: async () => new Map(),
    playedKeys: async () => new Set(),
    journal: async () => new Map(),
    tracks: asTracks,
    ...over,
  };
}

const journalOf = (...songs: AggregatedSong[]) => new Map(songs.map((s) => [s.songKey, s]));
const idsOf = (home: Awaited<ReturnType<typeof buildHome>>) => home.sections.map((s) => s.id);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildHome: the sections and their order (ADR-0020, H5/H6)', () => {
  it('sends the playlists, then what is new, each with its own title and kind (no «Ascoltati di recente»: Michele, 12 November)', async () => {
    const a = song('A', 'Heard', '2026-01-01');
    const b = song('B', 'Fresh', '2026-03-01');
    const home = await buildHome('mike', deps({
      playlists: async () => [playlist('p1', 'Road trip', 3)],
      journal: async () => journalOf(a, b),
      playedKeys: async () => new Set([a.songKey]),
    }));
    expect(home.sections.map((s) => [s.id, s.title, s.kind])).toEqual([
      ['playlists', 'Le tue playlist', 'playlists'],
      ['fresh', 'Nuovi dai tuoi reel', 'tracks'],
    ]);
    expect(logError).not.toHaveBeenCalled();             // nothing is built and then failed behind the scenes
  });

  it('echoes the user and greets by the family name', async () => {
    const home = await buildHome('archi', deps());
    expect(home.user).toBe('archi');
    expect(home.displayName).toBe('Archimede');
    expect(home.sections).toEqual([]);   // a new user: nothing to show is an empty list, never an error
  });

  it('knows the three family names and no one else', () => {
    expect(displayNameOf('mike')).toBe('Michele');
    expect(displayNameOf('archi')).toBe('Archimede');
    expect(displayNameOf('sara')).toBe('Sara');
    expect(displayNameOf('anonymous')).toBeNull();
    expect(displayNameOf('')).toBeNull();
  });

  it('leaves out a section with nothing in it, so the app never draws an empty heading', async () => {
    const heard = song('A', 'Heard', '2026-01-01');
    const onlyFresh = await buildHome('mike', deps({ journal: async () => journalOf(heard) }));
    expect(idsOf(onlyFresh)).toEqual(['fresh']);

    const everythingPlayed = await buildHome('mike', deps({
      journal: async () => journalOf(heard), playedKeys: async () => new Set([heard.songKey]),
    }));
    expect(idsOf(everythingPlayed)).toEqual([]);         // what was heard is not offered back as a row of its own any more
  });
});

describe('the playlists section', () => {
  it('shows the most recent first as the service lists them, at most 12, never an empty one', async () => {
    const many = Array.from({ length: 15 }, (_, i) => playlist(`p${i}`, `Lista ${i}`, 5));
    const withEmpty = [playlist('empty', 'Vuota', 0), ...many];
    const home = await buildHome('mike', deps({ playlists: async () => withEmpty }));
    const section = home.sections[0];
    expect(section.kind).toBe('playlists');
    if (section.kind !== 'playlists') return;
    expect(section.playlists).toHaveLength(HOME_LIMITS.playlists);
    expect(section.playlists.map((p) => p.id)).toEqual(many.slice(0, 12).map((p) => p.id));
    expect(section.playlists.find((p) => p.id === 'empty')).toBeUndefined();
  });

  it('says which playlists take songs by hand: only the user\'s own static ones', async () => {
    const home = await buildHome('mike', deps({
      playlists: async () => [
        playlist('own', 'Mia', 2),
        playlist('shared', 'Di Sara', 2, { ownerUser: 'sara' }),
        playlist('rule', 'Più ascoltate', 4, { kind: 'dynamic', ruleSummary: 'Più ascoltate · ultimi 30 giorni' }),
      ],
    }));
    const section = home.sections[0];
    if (section.kind !== 'playlists') throw new Error('playlists expected');
    expect(section.playlists.map((p) => [p.id, p.kind, p.canEdit, p.ruleSummary])).toEqual([
      ['own', 'static', true, null],
      ['shared', 'static', false, null],
      ['rule', 'dynamic', false, 'Più ascoltate · ultimi 30 giorni'],
    ]);
  });

  it('carries at most four cover keys per playlist, and none for one the server has nothing for', async () => {
    const home = await buildHome('mike', deps({
      playlists: async () => [playlist('a', 'A', 9), playlist('b', 'B', 9)],
      coverKeys: async () => new Map([['a', ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']]]),
    }));
    const section = home.sections[0];
    if (section.kind !== 'playlists') throw new Error('playlists expected');
    expect(section.playlists[0].coverKeys).toEqual(['k1', 'k2', 'k3', 'k4']);
    expect(section.playlists[1].coverKeys).toEqual([]);
  });

  it('a failing mosaic costs the mosaic, not the playlists', async () => {
    const home = await buildHome('mike', deps({
      playlists: async () => [playlist('a', 'A', 2)],
      coverKeys: async () => { throw new Error('db down'); },
    }));
    const section = home.sections[0];
    if (section.kind !== 'playlists') throw new Error('playlists expected');
    expect(section.playlists[0].coverKeys).toEqual([]);
    expect(logError).toHaveBeenCalledWith('home: playlist covers failed', expect.anything());
  });

  it('asks for the covers of the playlists it shows, not of every one the user has', async () => {
    const coverKeys = vi.fn(async () => new Map<string, string[]>());
    const many = Array.from({ length: 20 }, (_, i) => playlist(`p${i}`, `L${i}`, 3));
    await buildHome('mike', deps({ playlists: async () => many, coverKeys }));
    expect(coverKeys.mock.calls[0][0]).toHaveLength(HOME_LIMITS.playlists);
  });
});

describe('«Ascoltati di recente» is gone (Michele, 12 November: «gli Ascoltati di recente non mi interessano in homepage»)', () => {
  it('is never a section, whatever the user has heard', async () => {
    const songs = Array.from({ length: 30 }, (_, i) => song('Art', `t${i}`, '2026-01-01'));
    const home = await buildHome('mike', deps({
      playlists: async () => [playlist('p1', 'Road trip', 3)],
      journal: async () => journalOf(...songs),
      playedKeys: async () => new Set(songs.map((s) => s.songKey)),
    }));
    expect(idsOf(home)).not.toContain('recent');
    expect(JSON.stringify(home)).not.toContain('Ascoltati di recente');
  });

  it('is not asked for: the Home reads no list of recent plays, only the set that «Nuovi dai tuoi reel» leaves out', () => {
    expect(Object.keys(HOME_LIMITS).sort()).toEqual(['coverKeys', 'fresh', 'playlists']);
    expect(Object.keys(realHomeDeps).sort()).toEqual(['coverKeys', 'journal', 'playedKeys', 'playlists', 'tracks']);   // and no file-only song: that was for the plays of songs that exist only as a file
  });
});

describe('«Nuovi dai tuoi reel»', () => {
  it('lists the songs of the newest posts first, by the latest post that mentions them', async () => {
    const older = song('A', 'older', '2026-01-01');
    const newest = song('B', 'newest', '2026-06-01');
    const reposted = song('C', 'reposted', ['2025-01-01', '2026-03-01']);   // an old song mentioned again in March
    const home = await buildHome('mike', deps({ journal: async () => journalOf(older, newest, reposted) }));
    const section = home.sections.find((s) => s.id === 'fresh');
    if (section?.kind !== 'tracks') throw new Error('fresh expected');
    expect(section.tracks.map((t) => t.songKey)).toEqual([newest.songKey, reposted.songKey, older.songKey]);
  });

  it('leaves out what this user has already listened to', async () => {
    const heard = song('A', 'heard', '2026-06-01');
    const fresh = song('B', 'fresh', '2026-01-01');
    const home = await buildHome('mike', deps({ journal: async () => journalOf(heard, fresh), playedKeys: async () => new Set([heard.songKey]) }));
    const section = home.sections.find((s) => s.id === 'fresh');
    if (section?.kind !== 'tracks') throw new Error('fresh expected');
    expect(section.tracks.map((t) => t.songKey)).toEqual([fresh.songKey]);
  });

  it('asks the plays of the user the key belongs to, never of another', async () => {
    const playedKeys = vi.fn(async () => new Set<string>());
    const journal = vi.fn(async () => new Map<string, AggregatedSong>());
    await buildHome('sara', deps({ playedKeys, journal }));
    expect(playedKeys).toHaveBeenCalledWith('sara');
    expect(journal).toHaveBeenCalledWith('sara');
  });

  it('holds 20 songs and keeps the order steady when two posts have the same date (the title breaks the tie)', async () => {
    const songs = Array.from({ length: 25 }, (_, i) => song('Art', `t${String(i).padStart(2, '0')}`, '2026-01-01'));
    const reversed = [...songs].reverse();
    const first = await buildHome('mike', deps({ journal: async () => journalOf(...songs) }));
    const second = await buildHome('mike', deps({ journal: async () => journalOf(...reversed) }));
    const keys = (h: typeof first) => (h.sections[0].kind === 'tracks' ? h.sections[0].tracks.map((t) => t.songKey) : []);
    expect(keys(first)).toHaveLength(HOME_LIMITS.fresh);
    expect(keys(first)).toEqual(keys(second));
    expect(keys(first)[0]).toBe(songs[0].songKey);
  });

  it('puts a song whose posts have no readable date last, not first', async () => {
    const dated = song('A', 'dated', '2025-05-05');
    const undated = song('B', 'undated', 'not a date');
    const home = await buildHome('mike', deps({ journal: async () => journalOf(undated, dated) }));
    const section = home.sections[0];
    if (section.kind !== 'tracks') throw new Error('tracks expected');
    expect(section.tracks.map((t) => t.songKey)).toEqual([dated.songKey, undated.songKey]);
  });
});

describe('the journal is read once', () => {
  it('for the whole Home', async () => {
    const a = song('A', 'heard', '2026-01-01');
    const b = song('B', 'fresh', '2026-02-01');
    const journal = vi.fn(async () => journalOf(a, b));
    const home = await buildHome('mike', deps({ journal, playedKeys: async () => new Set([a.songKey]) }));
    expect(idsOf(home)).toEqual(['fresh']);
    expect(journal).toHaveBeenCalledTimes(1);
  });

  it('and a failure of the journal costs «Nuovi dai tuoi reel», not the playlists', async () => {
    const journal = vi.fn(async () => { throw new Error('db down'); });
    const home = await buildHome('mike', deps({ journal, playlists: async () => [playlist('p1', 'Road trip', 3)] }));
    expect(idsOf(home)).toEqual(['playlists']);
    expect(journal).toHaveBeenCalledTimes(1);
  });
});

describe('one section failing', () => {
  it('costs only that section, and says so in the log', async () => {
    const fresh = song('B', 'fresh', '2026-01-01');
    const home = await buildHome('mike', deps({
      playlists: async () => [playlist('p1', 'Road trip', 3)],
      playedKeys: async () => { throw new Error('play_events is down'); },
      journal: async () => journalOf(fresh),
    }));
    expect(idsOf(home)).toEqual(['playlists']);
    expect(logError).toHaveBeenCalledWith('home: section fresh failed', expect.objectContaining({ err: expect.stringContaining('play_events is down') }));
  });

  it('a failing build of the tracks leaves the playlists in place', async () => {
    const fresh = song('B', 'fresh', '2026-01-01');
    const home = await buildHome('mike', deps({
      playlists: async () => [playlist('p1', 'Road trip', 3)],
      journal: async () => journalOf(fresh),
      tracks: async () => { throw new Error('files unreachable'); },
    }));
    expect(idsOf(home)).toEqual(['playlists']);
  });
});

describe('rule P (ADR-0018, ADR-0020): nothing names a store', () => {
  it('has only the fields the contract lists, at every level', async () => {
    const a = song('A', 'heard', '2026-01-01');
    const b = song('B', 'fresh', '2026-02-01');
    const home = await buildHome('mike', deps({
      playlists: async () => [playlist('p1', 'Road trip', 3)],
      coverKeys: async () => new Map([['p1', [a.songKey]]]),
      journal: async () => journalOf(a, b),
      playedKeys: async () => new Set([a.songKey]),
    }));
    expect(Object.keys(home).sort()).toEqual(['displayName', 'sections', 'user']);
    for (const section of home.sections) {
      const allowed = section.kind === 'playlists' ? ['id', 'kind', 'playlists', 'title'] : ['id', 'kind', 'title', 'tracks'];
      expect(Object.keys(section).sort()).toEqual(allowed);
      if (section.kind === 'playlists') {
        for (const p of section.playlists) {
          expect(Object.keys(p).sort()).toEqual(['canEdit', 'coverKeys', 'createdAt', 'id', 'kind', 'name', 'ruleSummary', 'songCount', 'updatedAt']);
        }
      }
    }
    expect(JSON.stringify(home)).not.toMatch(/fritz|192\.168|dlna|mediaserver|\.local/i);
  });
});

describe('the real reads (what the route uses)', () => {
  it('lists the playlists of the viewer with the count of the dynamic ones filled in', async () => {
    const stored = [playlist('p1', 'A', 1)];
    vi.mocked(listPlaylists).mockResolvedValue(stored);
    vi.mocked(resolveSummaries).mockResolvedValue(stored);
    await expect(realHomeDeps.playlists('sara')).resolves.toEqual(stored);
    expect(listPlaylists).toHaveBeenCalledWith({ userId: 'sara', isAdmin: false });
    expect(resolveSummaries).toHaveBeenCalledWith(stored, { userId: 'sara', isAdmin: false });
  });

  it('takes the cover keys of the static playlists from the database in one query and those of a dynamic one from its rule', async () => {
    vi.mocked(firstSongKeys).mockResolvedValue(new Map([['s1', ['a', 'b', 'c', 'd']]]));
    vi.mocked(resolveSongKeys).mockResolvedValue({ songKeys: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] });
    const list = [playlist('s1', 'Static', 4), playlist('d1', 'Rule', 6, { kind: 'dynamic' })];
    const covers = await realHomeDeps.coverKeys(list, 'mike');
    expect(firstSongKeys).toHaveBeenCalledWith(['s1'], HOME_LIMITS.coverKeys);
    expect(resolveSongKeys).toHaveBeenCalledTimes(1);
    expect(resolveSongKeys).toHaveBeenCalledWith(list[1], { userId: 'mike', isAdmin: false });
    expect(covers.get('s1')).toEqual(['a', 'b', 'c', 'd']);
    expect(covers.get('d1')).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
});
