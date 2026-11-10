import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../types';
import { MemoryAutoPlaylistStore } from '../services/autoPlaylists';
import type { TitlePlan } from '../services/autoPlaylistTitle';
import { buildAutoPlaylists, parseArgs, undoAutoPlaylists, type Deps, type UndoDeps } from './buildAutoPlaylists';

const song = (title: string, source = 'ai_analysis') => ({ title, artist: 'Various', album: null, source, spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });
const entry = (id: string, createdAt: string, titles: string[], over: Partial<Entry> = {}): Entry =>
  ({ id, sourceUrl: `https://x/${id}`, ownerUser: 'mike', caption: 'c', createdAt, status: 'completed', results: { songs: titles.map((t) => song(t)), films: [], notes: [], links: [], tags: [], summary: 's' }, actionLog: [], ...over }) as unknown as Entry;

// a theme the metadata has no tag for: a list of the songs of the posts (a genre like Jazz is a rule: see the tests of the genre themes below)
const jazzPlan: TitlePlan = { aboutMusic: true, title: 'Synthwave da ascoltare', kind: 'theme', existingTheme: null };
const jazzJoin: TitlePlan = { aboutMusic: true, title: 'Synthwave da ascoltare', kind: 'theme', existingTheme: 'Synthwave da ascoltare' };
const xmasPlan: TitlePlan = { aboutMusic: true, title: 'Le 5 musiche di Natale', kind: 'one_off', existingTheme: null };

let lines: string[];
let tellOwner: ReturnType<typeof vi.fn>;
let store: MemoryAutoPlaylistStore;
let storeAsked: boolean[];
/** How many songs of the library carry the genre (what the playlist of a genre looks at). */
let genreCount = 0;
const base = (entries: Entry[], plans: Array<TitlePlan | null>): Deps => {
  let i = 0;
  return {
    candidates: async () => entries,
    store: async (apply) => { storeAsked.push(apply); return store; },
    title: async () => plans[i++] ?? null,
    language: async () => 'it',
    countGenreSongs: async () => genreCount,
    tellOwner: tellOwner as unknown as Deps['tellOwner'],
    say: (l) => lines.push(l),
  };
};

beforeEach(() => {
  lines = [];
  tellOwner = vi.fn().mockResolvedValue(undefined);
  store = new MemoryAutoPlaylistStore();
  storeAsked = [];
  genreCount = 0;
});

describe('reading the command line', () => {
  it('the preview is the default; --apply writes', () => {
    expect(parseArgs([])).toEqual({ apply: false, owner: null, limit: null, undoSince: null });
    expect(parseArgs(['--apply', '--owner', 'mike', '--limit', '10'])).toEqual({ apply: true, owner: 'mike', limit: 10, undoSince: null });
    expect(parseArgs(['--undo-since', '2026-11-10T02:00:00Z']).undoSince).toBe('2026-11-10T02:00:00Z');
  });
  it('an undo moment that is not a date is refused', () => {
    expect(() => parseArgs(['--undo-since', 'ieri'])).toThrow(/--undo-since/);
  });

  it('a limit that is not a whole positive number is refused', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow(/--limit/);
    expect(() => parseArgs(['--limit', 'x'])).toThrow(/--limit/);
  });
});

describe('the backfill of the posts already in the library', () => {
  const entries = [
    entry('e1', '2026-05-03T10:00:00.000Z', ['So What', 'Take Five']),
    entry('e2', '2026-06-11T10:00:00.000Z', ['Last Christmas', 'Jingle Bell Rock']),
    entry('e3', '2026-07-02T10:00:00.000Z', ['Naima', 'Autumn Leaves', 'Moanin']),
    entry('e4', '2026-07-03T10:00:00.000Z', ['Only One']),                    // ONE song: it can only feed a theme
    entry('e5', '2026-07-04T10:00:00.000Z', []),                              // no song at all: not a candidate
  ];
  const single: TitlePlan = { aboutMusic: true, title: 'Synthwave da ascoltare', kind: 'theme', existingTheme: 'Synthwave da ascoltare' };
  const plans = [jazzPlan, xmasPlan, jazzJoin, single];

  it('the preview asks for the memory store, writes nothing and tells nobody', async () => {
    const summary = await buildAutoPlaylists(base(entries, plans), { apply: false, owner: null, limit: null, undoSince: null });
    expect(storeAsked).toEqual([false]);
    expect(tellOwner).not.toHaveBeenCalled();
    expect(summary).toEqual({ candidates: 4, singles: 1, lists: 3, created: 2, joined: 2, pending: 0, waiting: 0, skipped: 0, already: 0, songs: 8 });
    expect(lines[0]).toContain('ANTEPRIMA');
    expect(lines[0]).toContain('voci con canzoni: 4 (3 ne elencano piu\' di una, 1 ne hanno una sola)');
    expect(lines.some((l) => l.includes('«Synthwave da ascoltare»') && l.includes('2 brani (nuova)'))).toBe(true);
    expect(lines.some((l) => l.includes('+3 brani (nella stessa playlist)'))).toBe(true);
    expect(lines.some((l) => l.includes('(1 canzone)') && l.includes('«Synthwave da ascoltare»') && l.includes('+1 brani'))).toBe(true);
    expect(lines.join('\n')).toContain('«Le 5 musiche di Natale» (preciso): 2 brani');
    expect(lines.join('\n')).toContain('«Synthwave da ascoltare» (tema): 6 brani');
  });

  it('goes from the oldest post and the theme ends with the newest songs in front', async () => {
    await buildAutoPlaylists(base(entries, plans), { apply: false, owner: null, limit: null, undoSince: null });
    const jazz = [...store.playlists.values()].find((p) => p.name === 'Synthwave da ascoltare')!;
    expect(store.songKeysOf(jazz.id)).toEqual(['various::only one', 'various::naima', 'various::autumn leaves', 'various::moanin', 'various::so what', 'various::take five']);
    expect(jazz.createdAt.toISOString()).toBe('2026-05-03T10:00:00.000Z');
  });

  it('a post with no song is not a candidate, not even asked', async () => {
    const asked = vi.fn();
    const deps = { ...base(entries, plans), title: async (s: unknown) => { asked(s); return jazzPlan; } };
    await buildAutoPlaylists(deps, { apply: false, owner: null, limit: null, undoSince: null });
    expect(asked).toHaveBeenCalledTimes(4);
  });

  it('--limit takes the first ones, the oldest', async () => {
    const summary = await buildAutoPlaylists(base(entries, plans), { apply: false, owner: null, limit: 2, undoSince: null });
    expect(summary.candidates).toBe(2);
    expect(store.playlists.size).toBe(2);
  });

  it('a post with no good title is said, and counted as pending (it will be tried again)', async () => {
    const summary = await buildAutoPlaylists(base(entries, [jazzPlan, null, jazzJoin, single]), { apply: false, owner: null, limit: null, undoSince: null });
    expect(summary).toMatchObject({ pending: 1, created: 1, joined: 2 });
    expect(lines.some((l) => l.includes('e2') && l.includes('nessun titolo buono'))).toBe(true);
  });

  it('a post that is not about music is said as skipped', async () => {
    const notMusic: TitlePlan = { aboutMusic: false, title: '', kind: 'theme', existingTheme: null };
    const summary = await buildAutoPlaylists(base([entries[3]], [notMusic]), { apply: false, owner: null, limit: null, undoSince: null });
    expect(summary).toMatchObject({ skipped: 1, created: 0 });
    expect(lines.some((l) => l.includes('saltata (not_about_music)'))).toBe(true);
  });

  it('--apply asks for the real store and tells each user ONCE, with how many playlists and songs', async () => {
    const mixed = [...entries, entry('e6', '2026-08-01T10:00:00.000Z', ['Africa', 'Rosanna'], { ownerUser: 'sara' })];
    await buildAutoPlaylists(base(mixed, [...plans, { aboutMusic: true, title: 'Rock anni 80', kind: 'theme', existingTheme: null }]), { apply: true, owner: null, limit: null, undoSince: null });
    expect(storeAsked).toEqual([true]);
    expect(lines[0]).toContain('SCRIVE');
    expect(tellOwner).toHaveBeenCalledTimes(2);
    expect(tellOwner).toHaveBeenCalledWith('mike', { playlists: 2, songs: 8 });
    expect(tellOwner).toHaveBeenCalledWith('sara', { playlists: 1, songs: 2 });
  });

  it('a user whose posts only joined existing playlists is not told «I made playlists»', async () => {
    store = new MemoryAutoPlaylistStore();
    const first = await store.createPlaylist({ owner: 'mike', name: 'Synthwave da ascoltare', kind: 'theme', themeKey: 'ascoltare synthwave', sourceEntryId: 'old', createdAt: new Date() });
    expect(first.created).toBe(true);
    await buildAutoPlaylists(base([entries[0]], [jazzJoin]), { apply: true, owner: null, limit: null, undoSince: null });
    expect(tellOwner).not.toHaveBeenCalled();
  });

  it('a single song whose theme has no playlist yet WAITS: no playlist of one song, counted and said', async () => {
    const lonely: TitlePlan = { aboutMusic: true, title: 'Musica per la notte', kind: 'theme', existingTheme: null };
    const summary = await buildAutoPlaylists(base([entries[3]], [lonely]), { apply: false, owner: null, limit: null, undoSince: null });
    expect(summary).toMatchObject({ waiting: 1, created: 0, joined: 0, songs: 0 });
    expect(store.playlists.size).toBe(0);
    expect(lines.some((l) => l.includes('e4') && l.includes('in attesa'))).toBe(true);
    expect(lines.join('\n')).toContain('1 in attesa del secondo brano');
  });

  it('two singles of the same theme: the second one makes the playlist with both, the first is done', async () => {
    const lonely: TitlePlan = { aboutMusic: true, title: 'Musica per la notte', kind: 'theme', existingTheme: null };
    const two = [entry('s1', '2026-07-01T10:00:00.000Z', ['Nightcall']), entry('s2', '2026-07-02T10:00:00.000Z', ['Dynamite Girl'])];
    const summary = await buildAutoPlaylists(base(two, [lonely, lonely]), { apply: false, owner: null, limit: null, undoSince: null });
    expect(summary).toMatchObject({ waiting: 1, created: 1, songs: 2 });
    expect(store.runs.get('s1|mike')?.status).toBe('done');
  });

  it('the posts already seen are counted, not printed again (a second run is not 700 lines of noise)', async () => {
    await store.saveRun('e1', 'mike', { status: 'done', playlistId: 'p', reason: null });
    await store.saveRun('e4', 'mike', { status: 'skipped', playlistId: null, reason: 'not_about_music' });
    const summary = await buildAutoPlaylists(base(entries, [xmasPlan, jazzPlan]), { apply: false, owner: null, limit: null, undoSince: null });
    expect(summary).toMatchObject({ already: 2, created: 2 });
    expect(lines.some((l) => l.includes('e1'))).toBe(false);
    expect(lines.join('\n')).toContain('2 gia\' viste');
  });

  it('a post that waited is read again, and finds the theme: the catch-up of a theme that was taken apart', async () => {
    const lonely: TitlePlan = { aboutMusic: true, title: 'Musica per la notte', kind: 'theme', existingTheme: null };
    const two = [entry('s1', '2026-07-01T10:00:00.000Z', ['Nightcall']), entry('s2', '2026-07-02T10:00:00.000Z', ['Dynamite Girl'])];
    await store.saveRun('s1', 'mike', { status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: 'musica notte' });
    await store.saveRun('s2', 'mike', { status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: 'musica notte' });
    const summary = await buildAutoPlaylists(base(two, [lonely, lonely]), { apply: false, owner: null, limit: null, undoSince: null });
    expect(summary).toMatchObject({ created: 1, waiting: 0, already: 1, songs: 2 });
  });

  it('the playlist of a GENRE is born when the library has two songs with the tag, and is a rule: no song of its own', async () => {
    genreCount = 30;
    const soul: TitlePlan = { aboutMusic: true, title: 'Soul da ascoltare', kind: 'theme', existingTheme: null };
    const summary = await buildAutoPlaylists(base([entries[3]], [soul]), { apply: false, owner: null, limit: null, undoSince: null });
    expect(summary).toMatchObject({ created: 1, waiting: 0 });
    const made = [...store.playlists.values()][0];
    expect(made.rule).toMatchObject({ order: 'newest', genres: ['R&B/Soul'] });
    expect(made.songs).toEqual([]);
  });

  it('never prints the text of a post, only titles and counts', async () => {
    const secret = entry('e9', '2026-09-01T10:00:00.000Z', ['A', 'B'], { caption: 'TESTO-SEGRETO-DEL-POST' });
    await buildAutoPlaylists(base([secret], [xmasPlan]), { apply: false, owner: null, limit: null, undoSince: null });
    expect(lines.join('\n')).not.toContain('TESTO-SEGRETO');
  });
});

describe('undoing an application', () => {
  const made = [
    { id: 'p1', name: 'Jazz da ascoltare', ownerUser: 'mike', themeKey: 'ascoltare jazz' },
    { id: 'p2', name: 'Le 5 musiche di Natale', ownerUser: 'mike', themeKey: null },
  ];
  let removed: Array<{ since: Date; ids: string[] }>;
  const undoDeps = (found = made, runs = 7): UndoDeps => ({
    findMade: async () => found,
    countRuns: async () => runs,
    remove: async (since, playlists) => { removed.push({ since, ids: playlists.map((p) => p.id) }); },
    say: (l) => lines.push(l),
  });
  beforeEach(() => { removed = []; });

  it('a preview by default: says what it would take away and takes nothing', async () => {
    const out = await undoAutoPlaylists(undoDeps(), { since: '2026-11-10T02:00:00Z', apply: false });
    expect(out).toEqual({ playlists: 2, runs: 7 });
    expect(removed).toEqual([]);
    expect(lines[0]).toContain('ANNULLA dal 2026-11-10T02:00:00.000Z: 2 playlist automatiche, 7 corse');
    expect(lines[0]).toContain('ANTEPRIMA');
    expect(lines.join('\n')).toContain('«Jazz da ascoltare»');
  });

  it('--apply takes them away, with the moment it was asked for', async () => {
    await undoAutoPlaylists(undoDeps(), { since: '2026-11-10T02:00:00Z', apply: true });
    expect(removed).toHaveLength(1);
    expect(removed[0].ids).toEqual(['p1', 'p2']);
    expect(removed[0].since.toISOString()).toBe('2026-11-10T02:00:00.000Z');
    expect(lines[0]).toContain('TOGLIE');
  });

  it('nothing made and no run: nothing to take away, even with --apply', async () => {
    const out = await undoAutoPlaylists(undoDeps([], 0), { since: '2026-11-10T02:00:00Z', apply: true });
    expect(out).toEqual({ playlists: 0, runs: 0 });
    expect(removed).toEqual([]);
  });

  it('runs without any playlist made (posts that were skipped) are still reset, so they can be asked again', async () => {
    await undoAutoPlaylists(undoDeps([], 5), { since: '2026-11-10T02:00:00Z', apply: true });
    expect(removed).toHaveLength(1);
    expect(removed[0].ids).toEqual([]);
  });
});
