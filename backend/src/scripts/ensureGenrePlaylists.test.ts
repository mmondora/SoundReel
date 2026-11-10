import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { MemoryAutoPlaylistStore } from '../services/autoPlaylists';
import { genreThemeKey } from '../services/genreThemes';
import { genreThemes } from '../services/genrePlaylistSweep';
import { ensureGenrePlaylistsScript, parseArgs, type ScriptDeps } from './ensureGenrePlaylists';

// The script that does by hand what the daily sweep does (ADR-0024, spec §3.A.14): PREVIEW by default, `--apply` writes. Same code path as the sweep.

const keyOf = (word: string): string => genreThemes().find((t) => t.word === word)!.key;
let store: MemoryAutoPlaylistStore;
let lines: string[];
let announce: ReturnType<typeof vi.fn>;
let library: Record<string, number>;
let owners: string[];

const deps = (over: Partial<ScriptDeps> = {}): ScriptDeps => ({
  store,
  countGenreSongs: async (_owner, genres) => library[genreThemeKey(genres)] ?? 0,
  announce: announce as unknown as ScriptDeps['announce'],
  now: () => new Date('2026-11-11T03:00:00.000Z'),
  listOwners: async () => owners,
  say: (line) => lines.push(line),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  store = new MemoryAutoPlaylistStore();
  lines = [];
  announce = vi.fn().mockResolvedValue(undefined);
  owners = ['mike'];
  library = { [keyOf('Latina')]: 8, [keyOf('Techno')]: 4, [keyOf('Blues')]: 4, [keyOf('Metal')]: 2, [keyOf('Punk')]: 1 };
});

describe('the arguments', () => {
  it('without flags it is a preview for everybody', () => {
    expect(parseArgs([])).toEqual({ apply: false, owner: null });
  });

  it('`--apply` writes; `--owner <u>` narrows to one user', () => {
    expect(parseArgs(['--apply'])).toEqual({ apply: true, owner: null });
    expect(parseArgs(['--owner', 'mike'])).toEqual({ apply: false, owner: 'mike' });
    expect(parseArgs(['--apply', '--owner', 'sara'])).toEqual({ apply: true, owner: 'sara' });
    expect(parseArgs(['--owner', 'sara', '--apply'])).toEqual({ apply: true, owner: 'sara' });
  });

  it('`--owner` without a name is an error, not «everybody»', () => {
    expect(() => parseArgs(['--owner'])).toThrow(/--owner/);
    expect(() => parseArgs(['--owner', '--apply'])).toThrow(/--owner/);
  });
});

describe('the preview (the default): says what would be made and why the rest is not, writes nothing', () => {
  it('lists, per user, the genres that would be born with their songs, and why the others are not', async () => {
    await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: keyOf('Jazz'), sourceEntryId: 'e1', createdAt: new Date() });
    const gone = await store.createPlaylist({ owner: 'mike', name: 'Reggae da ascoltare', kind: 'theme', themeKey: keyOf('Reggae'), sourceEntryId: 'e2', createdAt: new Date() });
    store.deletePlaylist(gone.id);
    const summary = await ensureGenrePlaylistsScript(deps(), { apply: false, owner: null });
    const text = lines.join('\n');
    expect(lines[0]).toMatch(/ANTEPRIMA \(niente scritto\)/);
    expect(text).toMatch(/nasce\s+«Latina da ascoltare»\s+8 brani col tag Latina/);
    expect(text).toMatch(/nasce\s+«Techno da ascoltare»\s+4 brani/);
    expect(text).toMatch(/nasce\s+«Blues da ascoltare»\s+4 brani/);
    expect(text).toMatch(/nasce\s+«Metal da ascoltare»\s+2 brani/);
    expect(text).toMatch(/aspetta\s+«Punk da ascoltare»\s+1 brano col tag: ne servono 2/);
    expect(text).toMatch(/c'e' gia'\s+«Jazz da ascoltare»/);
    expect(text).toMatch(/cancellata\s+«Reggae da ascoltare».*non si rifa/);
    expect(summary).toMatchObject({ owners: 1, toCreate: 4, created: 0, hasPlaylist: 1, deleted: 1, failed: 0 });
    expect(lines[lines.length - 1]).toMatch(/da fare: 4 nascono, 1 c'e' gia', 1 cancellata/);
  });

  it('WRITES NOTHING: no playlist, no theme, no run, no message', async () => {
    const create = vi.spyOn(store, 'createPlaylist');
    const save = vi.spyOn(store, 'saveRun');
    await ensureGenrePlaylistsScript(deps(), { apply: false, owner: null });
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(store.playlists.size).toBe(0);
  });

  it('names the users it looked at', async () => {
    owners = ['mike', 'sara'];
    await ensureGenrePlaylistsScript(deps(), { apply: false, owner: null });
    expect(lines.filter((l) => /^utente /.test(l))).toEqual(['utente mike:', 'utente sara:']);
  });
});

describe('--apply: the same decisions, written', () => {
  it('makes the playlists, says so line by line and tells the owner', async () => {
    const summary = await ensureGenrePlaylistsScript(deps(), { apply: true, owner: null });
    expect(lines[0]).toMatch(/SCRIVE \(--apply\)/);
    expect(lines.join('\n')).toMatch(/creata\s+«Latina da ascoltare»\s+8 brani col tag Latina/);
    expect(summary).toMatchObject({ owners: 1, toCreate: 4, created: 4 });
    expect(lines[lines.length - 1]).toMatch(/fatto: 4 create/);
    expect([...store.playlists.values()].map((p) => p.name).sort()).toEqual(['Blues da ascoltare', 'Latina da ascoltare', 'Metal da ascoltare', 'Techno da ascoltare']);
    expect(announce).toHaveBeenCalledTimes(4);
  });

  it('THE SAME CODE PATH: a preview and an apply on the same library decide the same thing', async () => {
    await ensureGenrePlaylistsScript(deps(), { apply: false, owner: null });
    const preview = lines.map((l) => l.replace(/nasce\s+/, 'X ').replace(/creata\s+/, 'X ')).filter((l) => l.startsWith('  '));
    lines = [];
    await ensureGenrePlaylistsScript(deps(), { apply: true, owner: null });
    const applied = lines.map((l) => l.replace(/nasce\s+/, 'X ').replace(/creata\s+/, 'X ')).filter((l) => l.startsWith('  '));
    // after the apply the four exist, so the second look is the first one with «nasce» turned into «creata»: compare what was DECIDED
    expect(applied.filter((l) => l.startsWith('  X '))).toEqual(preview.filter((l) => l.startsWith('  X ')));
  });

  it('is idempotent: the second apply says the playlists are there and makes nothing', async () => {
    await ensureGenrePlaylistsScript(deps(), { apply: true, owner: null });
    lines = [];
    announce.mockClear();
    const again = await ensureGenrePlaylistsScript(deps(), { apply: true, owner: null });
    expect(again).toMatchObject({ created: 0, toCreate: 0, hasPlaylist: 4 });
    expect(announce).not.toHaveBeenCalled();
    expect(store.playlists.size).toBe(4);
  });

  it('a playlist the user deleted is not made again, not even with --apply', async () => {
    await ensureGenrePlaylistsScript(deps(), { apply: true, owner: null });
    const latina = [...store.playlists.values()].find((p) => p.name === 'Latina da ascoltare')!;
    store.deletePlaylist(latina.id);
    lines = [];
    const again = await ensureGenrePlaylistsScript(deps(), { apply: true, owner: null });
    expect(again.created).toBe(0);
    expect(again.deleted).toBe(1);
    expect(store.playlists.size).toBe(3);
  });
});

describe('the genres with no song at all are ONE line, not twenty (they are not «waiting»: nothing is there to wait with)', () => {
  it('names them together, and keeps «aspetta» for the genre that has one song and needs a second', async () => {
    const summary = await ensureGenrePlaylistsScript(deps(), { apply: false, owner: null });
    const text = lines.join('\n');
    expect(lines.filter((l) => /^  aspetta/.test(l))).toHaveLength(1);                    // only Punk (one song)
    expect(text).toMatch(/nessun brano col tag: Jazz, Rock, Pop/);
    expect(text).not.toMatch(/«Jazz da ascoltare»/);
    expect(summary).toMatchObject({ toCreate: 4, waiting: 1, noSongs: 16 });
    expect(lines[lines.length - 1]).toMatch(/1 aspetta, 16 senza brani/);
  });

  it('a user with no library at all says so in one line', async () => {
    owners = ['nobody'];
    library = {};
    const summary = await ensureGenrePlaylistsScript(deps(), { apply: false, owner: null });
    expect(lines.filter((l) => l.startsWith('  ')).length).toBe(1);
    expect(lines.join('\n')).toMatch(/nessun brano col tag: Jazz/);
    expect(summary).toMatchObject({ toCreate: 0, waiting: 0, noSongs: 21 });
  });

  it('with every genre made or waiting there is no «nessun brano» line', async () => {
    library = Object.fromEntries(genreThemes().map((t) => [t.key, 3]));
    await ensureGenrePlaylistsScript(deps(), { apply: false, owner: null });
    expect(lines.join('\n')).not.toMatch(/nessun brano/);
  });
});

describe('who it looks at', () => {
  it('`--owner` looks at that user only, and does not even ask who has entries', async () => {
    owners = ['mike', 'sara'];
    const listOwners = vi.fn().mockResolvedValue(owners);
    await ensureGenrePlaylistsScript(deps({ listOwners }), { apply: true, owner: 'sara' });
    expect(listOwners).not.toHaveBeenCalled();
    expect([...store.playlists.values()].every((p) => p.owner === 'sara')).toBe(true);
    expect(store.playlists.size).toBe(4);
  });

  it('«anonymous» and an empty name are nobody', async () => {
    const summary = await ensureGenrePlaylistsScript(deps(), { apply: true, owner: 'anonymous' });
    expect(summary.owners).toBe(0);
    expect(lines.join('\n')).toMatch(/nessun utente/);
    expect(store.playlists.size).toBe(0);
  });

  it('no user has entries: it says so and writes nothing', async () => {
    owners = [];
    const summary = await ensureGenrePlaylistsScript(deps(), { apply: true, owner: null });
    expect(summary).toMatchObject({ owners: 0, created: 0 });
    expect(lines.join('\n')).toMatch(/nessun utente/);
  });

  it('a user that fails is reported and the others go on', async () => {
    owners = ['mike', 'sara'];
    const flaky = new Proxy(store, {
      get(target, prop) {
        if (prop === 'listThemes') return async (owner: string) => { if (owner === 'mike') throw new Error('db down'); return target.listThemes(owner); };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const summary = await ensureGenrePlaylistsScript(deps({ store: flaky }), { apply: true, owner: null });
    expect(lines.join('\n')).toMatch(/ERRORE utente mike: db down/);
    expect(summary).toMatchObject({ owners: 2, created: 4, failed: 1 });
  });

  it('a genre that fails is a line and the others go on', async () => {
    const summary = await ensureGenrePlaylistsScript(deps({
      countGenreSongs: async (_o, genres) => { if (genreThemeKey(genres) === keyOf('Techno')) throw new Error('boom'); return library[genreThemeKey(genres)] ?? 0; },
    }), { apply: false, owner: null });
    expect(lines.join('\n')).toMatch(/ERRORE\s+«Techno da ascoltare»\s+boom/);
    expect(summary).toMatchObject({ toCreate: 3, failed: 1 });
  });
});
