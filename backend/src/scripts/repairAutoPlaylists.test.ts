import { beforeEach, describe, expect, it, vi } from 'vitest';
import { genreRule } from '../services/genreThemes';
import { parseArgs, planRepair, repairAutoPlaylists, type AutoPlaylistRow, type RepairDeps } from './repairAutoPlaylists';

let n = 0;
const row = (name: string, songCount: number, over: Partial<AutoPlaylistRow> = {}): AutoPlaylistRow => ({
  id: `p${++n}`,
  owner: 'mike',
  name,
  autoKind: 'theme',
  themeKey: `key ${n}`,
  themeTitle: name,
  kind: 'static',
  songCount,
  ...over,
});

/** How many songs carry each genre: what the library has. */
let library: Record<string, number>;
const count = vi.fn(async (_owner: string, genres: string[]) => genres.reduce((sum, g) => sum + (library[g] ?? 0), 0));

beforeEach(() => {
  n = 0;
  library = { 'R&B/Soul': 30, Folk: 3, Cantautori: 5, Jazz: 15, Rock: 60, 'Hard Rock': 3, Pop: 131, 'Hip-Hop/Rap': 60 };
  count.mockClear();
});

const kinds = (actions: Awaited<ReturnType<typeof planRepair>>) => actions.map((a) => `${a.type}:${a.playlist.name}`);

describe('reading the command line', () => {
  it('the preview is the default; --apply writes', () => {
    expect(parseArgs([])).toEqual({ apply: false });
    expect(parseArgs(['--apply'])).toEqual({ apply: true });
  });
});

describe('what to do with each automatic playlist', () => {
  it('a theme that names a genre becomes DYNAMIC when the library has two songs with the tag (Michele: «deve avere il tag soul la canzone»)', async () => {
    const soul = row('Soul da ascoltare', 2);
    const [action] = await planRepair([soul], count);
    expect(action).toEqual({ type: 'to_dynamic', playlist: soul, themeKey: 'genre:R&B/Soul', genres: ['R&B/Soul'], matching: 30 });
    expect(count).toHaveBeenCalledWith('mike', ['R&B/Soul']);
  });

  it('a playlist of ONE song that names a genre is not taken apart if the tag has songs: it becomes the rule (Folk: 1 song -> 3 with the tag)', async () => {
    const [action] = await planRepair([row('Folk da ascoltare', 1)], count);
    expect(action).toMatchObject({ type: 'to_dynamic', matching: 3 });
  });

  it('a genre the library has fewer than two songs of is taken apart, and its posts wait on the genre key', async () => {
    library = { 'R&B/Soul': 1 };
    const [action] = await planRepair([row('Soul da ascoltare', 5)], count);
    expect(action).toMatchObject({ type: 'dismantle', why: 'genre_has_too_few', waitKey: 'genre:R&B/Soul', matching: 1 });
  });

  it('a theme with no tag in the metadata and ONE song is taken apart (a playlist has two songs); its posts wait on its own key', async () => {
    const lofi = row('Lo-fi da ascoltare', 1, { themeKey: 'ascoltare lo-fi' });
    const [action] = await planRepair([lofi, ], count);
    expect(action).toEqual({ type: 'dismantle', playlist: lofi, waitKey: 'ascoltare lo-fi', why: 'too_small', matching: null });
    expect(count).not.toHaveBeenCalled(); // no genre: the library is not looked at
  });

  it('the occasions are no genre: «Musica per allenarsi» with one song is taken apart', async () => {
    const [action] = await planRepair([row('Musica per allenarsi', 1, { themeKey: 'allenarsi musica' })], count);
    expect(action).toMatchObject({ type: 'dismantle', why: 'too_small', waitKey: 'allenarsi musica' });
  });

  it('a theme with no tag and two songs or more stays as it is (Synthwave: the posts feed it)', async () => {
    expect(kinds(await planRepair([row('Synthwave da ascoltare', 14), row('Musica per la notte', 2)], count))).toEqual([
      'keep:Synthwave da ascoltare', 'keep:Musica per la notte',
    ]);
  });

  it('a precise playlist (one for a post) with fewer than two songs is taken apart and its post is not waited on; with two it stays', async () => {
    const small = row('Le 5 musiche di Natale', 1, { autoKind: 'one_off', themeKey: null, themeTitle: null });
    const fine = row('10 canzoni del 2026', 10, { autoKind: 'one_off', themeKey: null, themeTitle: null });
    const actions = await planRepair([small, fine], count);
    expect(actions[0]).toMatchObject({ type: 'dismantle', waitKey: null, why: 'too_small' });
    expect(actions[1].type).toBe('keep');
  });

  it('a PRECISE playlist (one for a post) whose name looks like a genre theme is not a theme: the posts made it, it stays a list', async () => {
    const odd = row('Jazz da ascoltare', 4, { autoKind: 'one_off', themeKey: null, themeTitle: null });
    expect((await planRepair([odd], count))[0].type).toBe('keep');
    expect(count).not.toHaveBeenCalled();
  });

  it('«Rap» and «Hip hop» are one genre: the first becomes the rule, the second is MERGED into it (one playlist per set of genres)', async () => {
    const hip = row('Hip hop da ascoltare', 3);
    const rap = row('Rap da ascoltare', 2);
    const actions = await planRepair([hip, rap], count);
    expect(actions[0]).toMatchObject({ type: 'to_dynamic', themeKey: 'genre:Hip-Hop/Rap' });
    expect(actions[1]).toMatchObject({ type: 'merge', playlist: rap, into: hip, themeKey: 'genre:Hip-Hop/Rap' });
  });

  it('a static duplicate of a genre playlist that is already dynamic is merged into it, and the dynamic one is kept', async () => {
    const dynamic = row('Soul da ascoltare', 0, { kind: 'dynamic', themeKey: 'genre:R&B/Soul' });
    const stale = row('R&B da ascoltare', 4);
    const actions = await planRepair([dynamic, stale], count);
    expect(actions[0].type).toBe('keep');
    expect(actions[1]).toMatchObject({ type: 'merge', into: dynamic });
  });

  it('a playlist the user RENAMED is still its theme (the registry keeps the title): it becomes the rule and keeps its new name', async () => {
    const renamed = row('I miei soul', 2, { themeTitle: 'Soul da ascoltare' });
    const [action] = await planRepair([renamed], count);
    expect(action).toMatchObject({ type: 'to_dynamic', themeKey: 'genre:R&B/Soul' });
  });

  it('a playlist that is dynamic already is left alone, whatever it is', async () => {
    const dyn = row('Più ascoltate di notte', 0, { kind: 'dynamic', autoKind: 'one_off', themeKey: null });
    expect((await planRepair([dyn], count))[0].type).toBe('keep');
  });

  it('each user has his own library and his own playlist of the genre', async () => {
    const a = row('Soul da ascoltare', 2, { owner: 'mike' });
    const b = row('Soul da ascoltare', 2, { owner: 'sara' });
    const actions = await planRepair([a, b], count);
    expect(actions.map((x) => x.type)).toEqual(['to_dynamic', 'to_dynamic']);
    expect(count).toHaveBeenCalledTimes(2);
  });
});

describe('repairing', () => {
  const make = (rows: AutoPlaylistRow[]) => {
    const lines: string[] = [];
    const deps = {
      listAuto: vi.fn(async () => rows),
      countGenreSongs: count,
      makeDynamic: vi.fn(async () => undefined),
      dismantle: vi.fn(async () => undefined),
      say: (l: string) => lines.push(l),
    } satisfies RepairDeps;
    return { deps, lines };
  };
  const set = () => [
    row('Soul da ascoltare', 2), row('Folk da ascoltare', 1), row('Lo-fi da ascoltare', 1, { themeKey: 'ascoltare lo-fi' }),
    row('Synthwave da ascoltare', 14), row('Hip hop da ascoltare', 3), row('Rap da ascoltare', 2),
  ];

  it('the PREVIEW says everything and writes nothing', async () => {
    const { deps, lines } = make(set());
    const summary = await repairAutoPlaylists(deps, { apply: false });
    expect(summary).toEqual({ total: 6, kept: 1, toDynamic: 3, merged: 1, dismantled: 1 });
    expect(deps.makeDynamic).not.toHaveBeenCalled();
    expect(deps.dismantle).not.toHaveBeenCalled();
    expect(lines[0]).toContain('ANTEPRIMA');
    expect(lines.some((l) => l.includes('dinamica') && l.includes('«Soul da ascoltare»') && l.includes('2 brani dei post -> 30 brani col tag R&B/Soul'))).toBe(true);
    expect(lines.some((l) => l.includes('dinamica') && l.includes('«Folk da ascoltare»') && l.includes('1 brano dei post -> 3 brani'))).toBe(true);
    expect(lines.some((l) => l.includes('smontata') && l.includes('«Lo-fi da ascoltare»') && l.includes('ha 1 brano: ne servono 2'))).toBe(true);
    expect(lines.some((l) => l.includes('unita') && l.includes('«Rap da ascoltare»'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('3 diventano dinamiche, 1 unite, 1 smontate, 1 restano');
  });

  it('--apply makes the rules and takes apart what has to go, in the order of the list', async () => {
    const rows = set();
    const { deps, lines } = make(rows);
    await repairAutoPlaylists(deps, { apply: true });
    expect(lines[0]).toContain('SCRIVE');
    expect(deps.makeDynamic).toHaveBeenCalledTimes(3);
    expect(deps.makeDynamic).toHaveBeenNthCalledWith(1, rows[0], 'genre:R&B/Soul', genreRule(['R&B/Soul']));
    expect(deps.makeDynamic).toHaveBeenNthCalledWith(2, rows[1], 'genre:Folk', genreRule(['Folk']));
    expect(deps.dismantle).toHaveBeenCalledWith(rows[2], { waitKey: 'ascoltare lo-fi', mergeInto: null });
    expect(deps.dismantle).toHaveBeenCalledWith(rows[5], { waitKey: null, mergeInto: rows[4].id });
    expect(lines[lines.length - 1]).toContain('fatto');
  });

  it('nothing to repair is said and nothing is written', async () => {
    const { deps, lines } = make([row('Synthwave da ascoltare', 14), row('Le 5 musiche', 5, { autoKind: 'one_off', themeKey: null })]);
    expect(await repairAutoPlaylists(deps, { apply: true })).toEqual({ total: 2, kept: 2, toDynamic: 0, merged: 0, dismantled: 0 });
    expect(deps.makeDynamic).not.toHaveBeenCalled();
    expect(deps.dismantle).not.toHaveBeenCalled();
    expect(lines[lines.length - 1]).toContain('0 diventano dinamiche, 0 unite, 0 smontate, 2 restano');
  });

  it('is idempotent: once the genre playlists are dynamic, a second run keeps everything', async () => {
    const rows = [row('Soul da ascoltare', 0, { kind: 'dynamic', themeKey: 'genre:R&B/Soul' }), row('Synthwave da ascoltare', 14)];
    const { deps } = make(rows);
    expect(await repairAutoPlaylists(deps, { apply: true })).toMatchObject({ kept: 2, toDynamic: 0, dismantled: 0, merged: 0 });
  });
});
