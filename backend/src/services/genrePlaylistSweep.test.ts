import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { logInfo, logWarning } from '../utils/logger';
import { MemoryAutoPlaylistStore, MIN_PLAYLIST_SONGS } from './autoPlaylists';
import { GENRE_OF_THEME, GENRE_PLAYLIST_LIMIT, THEME_SUFFIX, genreRule, genreThemeKey } from './genreThemes';
import {
  GENRE_SWEEP_EVERY_MS,
  GENRE_SWEEP_FIRST_RUN_MS,
  ensureGenrePlaylists,
  genreThemes,
  planGenreSweep,
  runGenreSweep,
  startGenreSweepSchedule,
  type GenreSweepDeps,
} from './genrePlaylistSweep';

// ADR-0024, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.14. Michele, 10 November, asked about the genre playlists that do not exist
// yet because no post of the theme went by: «Un controllo una volta al giorno le fa nascere subito, senza aspettare il post. Lo faccio?» — «Sì,
// controllo giornaliero (Recommended)». The sweep makes, for every genre with at least two songs and no playlist, the same dynamic playlist a post
// of that theme would have made; one that the user deleted is never made again.

/** How many songs of the library carry each genre THEME (by the word of the theme); what was asked. */
let library: Record<string, number>;
let asked: Array<[string, string[]]>;
let store: MemoryAutoPlaylistStore;
let announce: ReturnType<typeof vi.fn>;
const NOW = new Date('2026-11-11T03:00:00.000Z');

const keyOfWord = (word: string): string => {
  const theme = genreThemes().find((t) => t.word === word);
  if (!theme) throw new Error(`no theme ${word}`);
  return theme.key;
};

const deps = (over: Partial<GenreSweepDeps> = {}): GenreSweepDeps => ({
  store,
  countGenreSongs: async (owner, genres) => {
    asked.push([owner, genres]);
    return library[genreThemeKey(genres)] ?? 0;
  },
  announce: announce as unknown as GenreSweepDeps['announce'],
  now: () => NOW,
  ...over,
});

/** A library as the parent measured the real one on 10 November: Latina 8, Techno 4, Blues 4, Metal 2, Punk 1, Reggae 1, the rest already have a playlist. */
const realish = (): Record<string, number> => ({
  [keyOfWord('Latina')]: 8, [keyOfWord('Techno')]: 4, [keyOfWord('Blues')]: 4, [keyOfWord('Metal')]: 2, [keyOfWord('Punk')]: 1, [keyOfWord('Reggae')]: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  library = {};
  asked = [];
  store = new MemoryAutoPlaylistStore();
  announce = vi.fn().mockResolvedValue(undefined);
});

describe('the genre themes the sweep looks at', () => {
  it('one per SET of genres: «Rap» and «Hip hop» are one theme, «R&B» and «Soul» too; House and Techno are two', () => {
    const themes = genreThemes();
    expect(themes).toHaveLength(21);
    expect(new Set(themes.map((t) => t.key)).size).toBe(21);
    expect(themes.filter((t) => t.key === genreThemeKey(['Hip-Hop/Rap']))).toHaveLength(1);
    expect(themes.filter((t) => t.key === genreThemeKey(['R&B/Soul']))).toHaveLength(1);
    expect(themes.map((t) => t.word)).toContain('House');
    expect(themes.map((t) => t.word)).toContain('Techno');
  });

  it('the title is the word of the theme and the suffix; of two words (one set of genres) the FIRST of the registry, always the same string', () => {
    const byWord = new Map(genreThemes().map((t) => [t.word, t]));
    expect(byWord.get('Latina')?.title).toBe(`Latina${THEME_SUFFIX}`);
    expect(byWord.get('Colonne sonore')?.title).toBe('Colonne sonore da ascoltare');
    expect(byWord.get('Hip hop')?.title).toBe('Hip hop da ascoltare');
    expect(byWord.has('Rap')).toBe(false);
    expect(byWord.get('R&B')?.title).toBe('R&B da ascoltare');
    expect(byWord.has('Soul')).toBe(false);
  });

  it('they come in the order of the registry, and every theme of the registry is there (by its set of genres)', () => {
    const words = genreThemes().map((t) => t.word);
    const registry = Object.keys(GENRE_OF_THEME);
    expect(words).toEqual(registry.filter((w) => w !== 'Rap' && w !== 'Soul'));
    for (const word of registry) expect(genreThemes().some((t) => t.key === genreThemeKey(GENRE_OF_THEME[word]))).toBe(true);
  });

  it('a theme carries the genres of the registry (what the rule will select), as the engine passes them', () => {
    const rock = genreThemes().find((t) => t.word === 'Rock');
    expect(rock?.genres).toEqual(['Rock', 'Hard Rock']);
    expect(rock?.key).toBe(genreThemeKey(['Rock', 'Hard Rock']));
  });
});

describe('what the sweep decides (and a preview shows): nothing is written', () => {
  it('a genre with at least two songs and no playlist gets one; with fewer it waits; the numbers are the ones of the library', async () => {
    library = realish();
    const plan = await planGenreSweep('mike', deps());
    const by = new Map(plan.map((i) => [i.theme.word, i]));
    expect(by.get('Latina')).toMatchObject({ action: 'create', matching: 8 });
    expect(by.get('Techno')).toMatchObject({ action: 'create', matching: 4 });
    expect(by.get('Blues')).toMatchObject({ action: 'create', matching: 4 });
    expect(by.get('Metal')).toMatchObject({ action: 'create', matching: 2 });
    expect(by.get('Punk')).toMatchObject({ action: 'skip', reason: 'too_few_songs', matching: 1 });
    expect(by.get('Reggae')).toMatchObject({ action: 'skip', reason: 'too_few_songs', matching: 1 });
    expect(by.get('Jazz')).toMatchObject({ action: 'skip', reason: 'too_few_songs', matching: 0 });
    expect(plan.filter((i) => i.action === 'create').map((i) => i.theme.word)).toEqual(['Techno', 'Blues', 'Metal', 'Latina']);
  });

  it('the minimum is the one of every automatic playlist: exactly two is enough, one is not', async () => {
    expect(MIN_PLAYLIST_SONGS).toBe(2);
    library = { [keyOfWord('Folk')]: MIN_PLAYLIST_SONGS, [keyOfWord('Funk')]: MIN_PLAYLIST_SONGS - 1 };
    const plan = await planGenreSweep('mike', deps());
    expect(plan.find((i) => i.theme.word === 'Folk')).toMatchObject({ action: 'create', matching: 2 });
    expect(plan.find((i) => i.theme.word === 'Funk')).toMatchObject({ action: 'skip', reason: 'too_few_songs' });
  });

  it('a theme that has a playlist is left alone and the library is not even asked about it', async () => {
    library = { [keyOfWord('Jazz')]: 15 };
    await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: keyOfWord('Jazz'), sourceEntryId: 'e1', createdAt: NOW });
    const plan = await planGenreSweep('mike', deps());
    expect(plan.find((i) => i.theme.word === 'Jazz')).toEqual(expect.objectContaining({ action: 'skip', reason: 'has_playlist' }));
    expect(asked.some(([, genres]) => genreThemeKey(genres) === keyOfWord('Jazz'))).toBe(false);
  });

  it('a playlist the user DELETED is remembered: the theme is skipped as «deleted by the user», never counted, never made again', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    const made = await store.createPlaylist({ owner: 'mike', name: 'Latina da ascoltare', kind: 'theme', themeKey: keyOfWord('Latina'), sourceEntryId: null, createdAt: NOW });
    store.deletePlaylist(made.id);
    const plan = await planGenreSweep('mike', deps());
    expect(plan.find((i) => i.theme.word === 'Latina')).toEqual(expect.objectContaining({ action: 'skip', reason: 'deleted_by_user' }));
    expect(asked.some(([, genres]) => genreThemeKey(genres) === keyOfWord('Latina'))).toBe(false);
  });

  it('«Rap» and «Hip hop» are one theme: a playlist made for either is the playlist of both', async () => {
    library = { [genreThemeKey(['Hip-Hop/Rap'])]: 60 };
    await store.createPlaylist({ owner: 'mike', name: 'Rap da ascoltare', kind: 'theme', themeKey: genreThemeKey(GENRE_OF_THEME.Rap), sourceEntryId: 'e1', createdAt: NOW });
    const plan = await planGenreSweep('mike', deps());
    expect(plan.filter((i) => i.theme.key === genreThemeKey(['Hip-Hop/Rap']))).toEqual([expect.objectContaining({ action: 'skip', reason: 'has_playlist' })]);
  });

  it('the library is asked with the genres of the theme and for THIS owner; each owner has his own themes', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    await store.createPlaylist({ owner: 'sara', name: 'Latina da ascoltare', kind: 'theme', themeKey: keyOfWord('Latina'), sourceEntryId: 'e9', createdAt: NOW });
    const plan = await planGenreSweep('mike', deps());
    expect(plan.find((i) => i.theme.word === 'Latina')).toMatchObject({ action: 'create' });
    expect(asked.every(([owner]) => owner === 'mike')).toBe(true);
    expect(asked.find(([, genres]) => genreThemeKey(genres) === keyOfWord('Latina'))?.[1]).toEqual(GENRE_OF_THEME.Latina);
  });

  it('writes NOTHING: no playlist, no run, no message', async () => {
    library = realish();
    const create = vi.spyOn(store, 'createPlaylist');
    const save = vi.spyOn(store, 'saveRun');
    await planGenreSweep('mike', deps());
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(store.playlists.size).toBe(0);
  });

  it('a theme whose library cannot be counted is a «failed» line and the others go on', async () => {
    library = { [keyOfWord('Latina')]: 8, [keyOfWord('Blues')]: 4 };
    const plan = await planGenreSweep('mike', deps({
      countGenreSongs: async (_o, genres) => {
        if (genreThemeKey(genres) === keyOfWord('Techno')) throw new Error('db down');
        return library[genreThemeKey(genres)] ?? 0;
      },
    }));
    expect(plan.find((i) => i.theme.word === 'Techno')).toEqual(expect.objectContaining({ action: 'failed', error: 'db down' }));
    expect(plan.find((i) => i.theme.word === 'Latina')).toMatchObject({ action: 'create' });
    expect(plan.find((i) => i.theme.word === 'Blues')).toMatchObject({ action: 'create' });
    expect(logWarning).toHaveBeenCalled();
  });
});

describe('making the playlists', () => {
  it('makes the DYNAMIC playlist of every genre planned: the rule, the key, no songs of its own, no source post, the moment of the sweep', async () => {
    library = realish();
    const out = await ensureGenrePlaylists('mike', deps());
    expect(out.created).toBe(4);
    const made = [...store.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
    expect(made.map((p) => p.name)).toEqual(['Blues da ascoltare', 'Latina da ascoltare', 'Metal da ascoltare', 'Techno da ascoltare']);
    for (const p of made) {
      const theme = genreThemes().find((t) => t.title === p.name)!;
      expect(p).toMatchObject({ owner: 'mike', kind: 'theme', themeKey: theme.key, sourceEntryId: null, createdAt: NOW, rule: genreRule(theme.genres), songs: [] });
    }
  });

  it('registers each theme, so that a later post of the theme finds the playlist and a deletion is remembered', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    const out = await ensureGenrePlaylists('mike', deps());
    const id = out.items.find((i) => i.theme.word === 'Latina')?.playlistId;
    expect(await store.listThemes('mike')).toEqual([{ themeKey: keyOfWord('Latina'), title: 'Latina da ascoltare', playlistId: id }]);
    store.deletePlaylist(id!);
    const again = await ensureGenrePlaylists('mike', deps());
    expect(again.created).toBe(0);
    expect(again.items.find((i) => i.theme.word === 'Latina')).toEqual(expect.objectContaining({ action: 'skip', reason: 'deleted_by_user' }));
  });

  it('tells the owner of each birth, like the engine: «Nuova playlist: …» and how many songs; no post to link', async () => {
    library = { [keyOfWord('Latina')]: 8, [keyOfWord('Metal')]: 2 };
    await ensureGenrePlaylists('mike', deps());
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenCalledWith({ userId: 'mike', title: 'Nuova playlist: Latina da ascoltare', body: '8 brani', entryId: null });
    expect(announce).toHaveBeenCalledWith({ userId: 'mike', title: 'Nuova playlist: Metal da ascoltare', body: '2 brani', entryId: null });
  });

  it('the number it announces is what the rule will show: at most 200 songs, even when the library has more', async () => {
    library = { [keyOfWord('Pop')]: GENRE_PLAYLIST_LIMIT + 300 };
    await ensureGenrePlaylists('mike', deps());
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ body: `${GENRE_PLAYLIST_LIMIT} brani` }));
  });

  it('a message that cannot be sent does not undo the playlist nor stop the others', async () => {
    library = { [keyOfWord('Latina')]: 8, [keyOfWord('Blues')]: 4 };
    announce.mockRejectedValue(new Error('inbox down'));
    const out = await ensureGenrePlaylists('mike', deps());
    expect(out.created).toBe(2);
    expect(store.playlists.size).toBe(2);
    expect(out.items.filter((i) => i.action === 'failed')).toEqual([]);                       // a message is not a failure of the playlist
    expect(out.items.filter((i) => i.action === 'create')).toHaveLength(2);
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('is IDEMPOTENT: the second run makes nothing and says nothing', async () => {
    library = realish();
    await ensureGenrePlaylists('mike', deps());
    announce.mockClear();
    const second = await ensureGenrePlaylists('mike', deps());
    expect(second.created).toBe(0);
    expect(announce).not.toHaveBeenCalled();
    expect(store.playlists.size).toBe(4);
  });

  it('never touches a playlist that is there: the automatic one of a theme keeps its id, its name (renamed or not) and its songs', async () => {
    const jazz = await store.createPlaylist({ owner: 'mike', name: 'Il mio jazz', kind: 'theme', themeKey: keyOfWord('Jazz'), sourceEntryId: 'e1', createdAt: new Date('2026-10-01T10:00:00Z'), rule: genreRule(GENRE_OF_THEME.Jazz) });
    const before = JSON.stringify([...store.playlists.values()]);
    library = { ...realish(), [keyOfWord('Jazz')]: 15 };
    await ensureGenrePlaylists('mike', deps());
    const after = store.playlists.get(jazz.id);
    expect(after?.name).toBe('Il mio jazz');
    expect(JSON.stringify(after)).toBe(JSON.stringify(JSON.parse(before)[0]));
  });

  it('the posts that WAITED for the genre are done now that the playlist is born', async () => {
    await store.saveRun('p1', 'mike', { status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: keyOfWord('Metal') });
    library = { [keyOfWord('Metal')]: 2 };
    const out = await ensureGenrePlaylists('mike', deps());
    const id = out.items.find((i) => i.theme.word === 'Metal')?.playlistId;
    expect(await store.getRun('p1', 'mike')).toEqual({ status: 'done', playlistId: id, reason: null });
  });

  it('with one song only the posts keep waiting: nothing is made, nothing is closed', async () => {
    await store.saveRun('p1', 'mike', { status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: keyOfWord('Punk') });
    library = { [keyOfWord('Punk')]: 1 };
    await ensureGenrePlaylists('mike', deps());
    expect(await store.getRun('p1', 'mike')).toMatchObject({ status: 'waiting' });
    expect(store.playlists.size).toBe(0);
  });

  it('two sweeps at the same moment (or a sweep and a post) make ONE playlist and ONE message: the one that finds it there says «already there»', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    const [a, b] = await Promise.all([ensureGenrePlaylists('mike', deps()), ensureGenrePlaylists('mike', deps())]);
    expect(a.created + b.created).toBe(1);
    expect(store.playlists.size).toBe(1);
    expect(announce).toHaveBeenCalledTimes(1);
    const loser = a.created === 0 ? a : b;
    expect(loser.items.find((i) => i.theme.word === 'Latina')).toEqual(expect.objectContaining({ action: 'skip', reason: 'has_playlist' }));
  });

  it('a unique violation from the database is «already there», not an error', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    vi.spyOn(store, 'createPlaylist').mockRejectedValue(Object.assign(new Error('duplicate key value violates unique constraint "uq_playlists_theme"'), { code: '23505' }));
    const out = await ensureGenrePlaylists('mike', deps());
    expect(out.created).toBe(0);
    expect(out.items.find((i) => i.theme.word === 'Latina')).toEqual(expect.objectContaining({ action: 'skip', reason: 'has_playlist' }));
    expect(announce).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('a theme that cannot be made is a warning and a «failed» line; the others are made', async () => {
    library = { [keyOfWord('Latina')]: 8, [keyOfWord('Blues')]: 4 };
    const real = store.createPlaylist.bind(store);
    vi.spyOn(store, 'createPlaylist').mockImplementation(async (input) => {
      if (input.themeKey === keyOfWord('Latina')) throw new Error('disk full');
      return real(input);
    });
    const out = await ensureGenrePlaylists('mike', deps());
    expect(out.created).toBe(1);
    expect(out.items.find((i) => i.theme.word === 'Latina')).toEqual(expect.objectContaining({ action: 'failed', error: 'disk full' }));
    expect([...store.playlists.values()].map((p) => p.name)).toEqual(['Blues da ascoltare']);
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('genre playlist'), expect.objectContaining({ owner: 'mike', error: 'disk full' }));
  });

  it('the moment of the sweep is asked once for the whole owner (every playlist of a run has the same date)', async () => {
    library = { [keyOfWord('Latina')]: 8, [keyOfWord('Blues')]: 4 };
    let calls = 0;
    await ensureGenrePlaylists('mike', deps({ now: () => { calls++; return new Date(NOW.getTime() + calls); } }));
    expect(calls).toBe(1);
    expect(new Set([...store.playlists.values()].map((p) => p.createdAt.getTime())).size).toBe(1);
  });
});

describe('every owner, one run', () => {
  const runDeps = (owners: string[], over: Partial<GenreSweepDeps> = {}) => ({ ...deps(over), listOwners: async () => owners });

  it('sweeps every owner on his own library and says how many playlists were made', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    const result = await runGenreSweep(runDeps(['mike', 'sara']));
    expect(result).toMatchObject({ owners: 2, created: 2, failed: 0 });
    expect([...store.playlists.values()].map((p) => p.owner).sort()).toEqual(['mike', 'sara']);
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('created 2 playlists'), expect.objectContaining({ owners: 2, created: 2 }));
  });

  it('the register says «1 playlist» for one, «N playlists» for more, and counts what was made', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    await runGenreSweep(runDeps(['mike']));
    expect(logInfo).toHaveBeenLastCalledWith(expect.stringMatching(/created 1 playlist$/), expect.objectContaining({ owners: 1, created: 1 }));
    await runGenreSweep(runDeps(['mike']));
    expect(logInfo).toHaveBeenLastCalledWith(expect.stringMatching(/created 0 playlists$/), expect.objectContaining({ created: 0 }));
  });

  it('the run counts what it made, what it left alone (a playlist there, a deletion, too few songs) and what failed', async () => {
    library = { [keyOfWord('Latina')]: 8, [keyOfWord('Techno')]: 4 };
    const made = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: keyOfWord('Jazz'), sourceEntryId: 'e1', createdAt: NOW });
    expect(made.created).toBe(true);
    const result = await runGenreSweep(runDeps(['mike'], {
      countGenreSongs: async (_o, genres) => {
        if (genreThemeKey(genres) === keyOfWord('Blues')) throw new Error('boom');
        return library[genreThemeKey(genres)] ?? 0;
      },
    }));
    // 21 themes: 2 made (Latina, Techno), 1 failed (Blues), the other 18 left alone (Jazz has its playlist, the rest has fewer than two songs)
    expect(result).toEqual({ owners: 1, created: 2, skipped: 18, failed: 1 });
  });

  it('a user with no library (no songs with a genre) gets nothing and no message', async () => {
    const result = await runGenreSweep(runDeps(['nobody']));
    expect(result).toMatchObject({ owners: 1, created: 0 });
    expect(store.playlists.size).toBe(0);
    expect(announce).not.toHaveBeenCalled();
  });

  it('an owner that fails does not stop the others, and the failure is a warning', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    // a store that cannot read the themes of «mike» and is the same store for everybody else
    const flaky = new Proxy(store, {
      get(target, prop) {
        if (prop === 'listThemes') return async (owner: string) => { if (owner === 'mike') throw new Error('db down'); return target.listThemes(owner); };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await runGenreSweep(runDeps(['mike', 'sara'], { store: flaky }));
    expect(result).toMatchObject({ owners: 2, created: 1, failed: 1 });
    expect([...store.playlists.values()].map((p) => p.owner)).toEqual(['sara']);
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('genre playlist sweep'), expect.objectContaining({ owner: 'mike', error: 'db down' }));
  });

  it('never throws, even when the owners cannot be listed', async () => {
    const result = await runGenreSweep({ ...deps(), listOwners: async () => { throw new Error('db down'); } });
    expect(result).toMatchObject({ owners: 0, created: 0, failed: 1 });
    expect(logWarning).toHaveBeenCalled();
  });

  it('an owner with no name, and «anonymous», are nobody: they get nothing', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    const result = await runGenreSweep(runDeps(['', 'anonymous', 'mike']));
    expect(result.owners).toBe(1);
    expect([...store.playlists.values()].map((p) => p.owner)).toEqual(['mike']);
  });

  it('the same owner twice in the list is swept once', async () => {
    library = { [keyOfWord('Latina')]: 8 };
    const result = await runGenreSweep(runDeps(['mike', 'mike']));
    expect(result.owners).toBe(1);
    expect(result.created).toBe(1);
  });
});

describe('the schedule: a first run soon after the start, then every 24 hours', () => {
  /** Timers that remember what they were asked, and can be fired by hand. */
  function fakeTimers() {
    const calls: Array<{ kind: 'timeout' | 'interval'; ms: number; fn: () => void; unref: ReturnType<typeof vi.fn>; cleared: boolean }> = [];
    const make = (kind: 'timeout' | 'interval') => (fn: () => void, ms: number) => {
      const entry = { kind, ms, fn, unref: vi.fn(), cleared: false };
      calls.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    };
    const clear = (t: unknown) => { (t as { cleared: boolean }).cleared = true; };
    return { calls, timers: { setTimeout: make('timeout'), setInterval: make('interval'), clearTimeout: clear, clearInterval: clear } };
  }

  it('the constants: about two minutes after the boot, then once a day', () => {
    expect(GENRE_SWEEP_FIRST_RUN_MS).toBe(2 * 60 * 1000);
    expect(GENRE_SWEEP_EVERY_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('starts one timeout (the first run) and one interval (the daily run), and neither keeps the process alive', () => {
    const { calls, timers } = fakeTimers();
    startGenreSweepSchedule(async () => undefined, { timers });
    expect(calls.map((c) => [c.kind, c.ms])).toEqual([['timeout', GENRE_SWEEP_FIRST_RUN_MS], ['interval', GENRE_SWEEP_EVERY_MS]]);
    for (const c of calls) expect(c.unref).toHaveBeenCalledTimes(1);
  });

  it('the delays can be given (a test, or an urgent run)', () => {
    const { calls, timers } = fakeTimers();
    startGenreSweepSchedule(async () => undefined, { timers, firstRunMs: 5, everyMs: 7 });
    expect(calls.map((c) => c.ms)).toEqual([5, 7]);
  });

  it('runs at the first timeout and at every tick', async () => {
    const { calls, timers } = fakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    startGenreSweepSchedule(run, { timers });
    expect(run).not.toHaveBeenCalled();
    calls[0].fn();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    calls[1].fn();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a run that fails never stops the schedule: it is a warning and the next tick runs', async () => {
    const { calls, timers } = fakeTimers();
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    startGenreSweepSchedule(run, { timers });
    calls[1].fn();
    await new Promise((r) => setImmediate(r));
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('genre playlist sweep'), expect.objectContaining({ error: 'boom' }));
    calls[1].fn();
    await new Promise((r) => setImmediate(r));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a tick that finds the previous run still going does not start another', async () => {
    const { calls, timers } = fakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    startGenreSweepSchedule(run, { timers });
    calls[0].fn();
    calls[1].fn();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((r) => setImmediate(r));
    calls[1].fn();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('the stop function clears both timers, and a timer that fires after it runs nothing', async () => {
    const { calls, timers } = fakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startGenreSweepSchedule(run, { timers });
    stop();
    expect(calls.every((c) => c.cleared)).toBe(true);
    calls[0].fn();
    calls[1].fn();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  describe('with the real timers (fake clock)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('two minutes after the start, then at 24 h, 48 h…', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      const stop = startGenreSweepSchedule(run);
      await vi.advanceTimersByTimeAsync(GENRE_SWEEP_FIRST_RUN_MS - 1);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(GENRE_SWEEP_EVERY_MS);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(GENRE_SWEEP_EVERY_MS);
      expect(run).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(GENRE_SWEEP_EVERY_MS * 2);
      expect(run).toHaveBeenCalledTimes(3);
    });
  });
});
