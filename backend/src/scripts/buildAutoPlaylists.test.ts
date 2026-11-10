import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../types';
import { MemoryAutoPlaylistStore } from '../services/autoPlaylists';
import type { TitlePlan } from '../services/autoPlaylistTitle';
import { buildAutoPlaylists, parseArgs, type Deps } from './buildAutoPlaylists';

const song = (title: string, source = 'ai_analysis') => ({ title, artist: 'Various', album: null, source, spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });
const entry = (id: string, createdAt: string, titles: string[], over: Partial<Entry> = {}): Entry =>
  ({ id, sourceUrl: `https://x/${id}`, ownerUser: 'mike', caption: 'c', createdAt, status: 'completed', results: { songs: titles.map((t) => song(t)), films: [], notes: [], links: [], tags: [], summary: 's' }, actionLog: [], ...over }) as unknown as Entry;

const jazzPlan: TitlePlan = { aboutMusic: true, title: 'Jazz da ascoltare', kind: 'theme', existingTheme: null };
const jazzJoin: TitlePlan = { aboutMusic: true, title: 'Jazz da ascoltare', kind: 'theme', existingTheme: 'Jazz da ascoltare' };
const xmasPlan: TitlePlan = { aboutMusic: true, title: 'Le 5 musiche di Natale', kind: 'one_off', existingTheme: null };

let lines: string[];
let tellOwner: ReturnType<typeof vi.fn>;
let store: MemoryAutoPlaylistStore;
let storeAsked: boolean[];
const base = (entries: Entry[], plans: Array<TitlePlan | null>): Deps => {
  let i = 0;
  return {
    candidates: async () => entries,
    store: async (apply) => { storeAsked.push(apply); return store; },
    title: async () => plans[i++] ?? null,
    language: async () => 'it',
    tellOwner: tellOwner as unknown as Deps['tellOwner'],
    say: (l) => lines.push(l),
  };
};

beforeEach(() => {
  lines = [];
  tellOwner = vi.fn().mockResolvedValue(undefined);
  store = new MemoryAutoPlaylistStore();
  storeAsked = [];
});

describe('reading the command line', () => {
  it('the preview is the default; --apply writes', () => {
    expect(parseArgs([])).toEqual({ apply: false, owner: null, limit: null });
    expect(parseArgs(['--apply', '--owner', 'mike', '--limit', '10'])).toEqual({ apply: true, owner: 'mike', limit: 10 });
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
    entry('e4', '2026-07-03T10:00:00.000Z', ['Only One']),                    // one song: no playlist
  ];

  it('the preview asks for the memory store, writes nothing and tells nobody', async () => {
    const summary = await buildAutoPlaylists(base(entries, [jazzPlan, xmasPlan, jazzJoin]), { apply: false, owner: null, limit: null });
    expect(storeAsked).toEqual([false]);
    expect(tellOwner).not.toHaveBeenCalled();
    expect(summary).toEqual({ candidates: 3, created: 2, joined: 1, pending: 0, skipped: 0, songs: 7 });
    expect(lines[0]).toContain('ANTEPRIMA');
    expect(lines.some((l) => l.includes('«Jazz da ascoltare»') && l.includes('2 brani (nuova)'))).toBe(true);
    expect(lines.some((l) => l.includes('+3 brani (nella stessa playlist)'))).toBe(true);
    expect(lines.join('\n')).toContain('«Le 5 musiche di Natale» (preciso): 2 brani');
    expect(lines.join('\n')).toContain('«Jazz da ascoltare» (tema): 5 brani');
  });

  it('goes from the oldest post and the theme ends with the newest songs in front', async () => {
    await buildAutoPlaylists(base(entries, [jazzPlan, xmasPlan, jazzJoin]), { apply: false, owner: null, limit: null });
    const jazz = [...store.playlists.values()].find((p) => p.name === 'Jazz da ascoltare')!;
    expect(store.songKeysOf(jazz.id)).toEqual(['various::naima', 'various::autumn leaves', 'various::moanin', 'various::so what', 'various::take five']);
    expect(jazz.createdAt.toISOString()).toBe('2026-05-03T10:00:00.000Z');
  });

  it('a post that does not talk about music is not counted, not even asked', async () => {
    const asked = vi.fn();
    const deps = { ...base(entries, [jazzPlan, xmasPlan, jazzJoin]), title: async (s: unknown) => { asked(s); return jazzPlan; } };
    await buildAutoPlaylists(deps, { apply: false, owner: null, limit: null });
    expect(asked).toHaveBeenCalledTimes(3);
  });

  it('--limit takes the first ones, the oldest', async () => {
    const summary = await buildAutoPlaylists(base(entries, [jazzPlan, xmasPlan, jazzJoin]), { apply: false, owner: null, limit: 2 });
    expect(summary.candidates).toBe(2);
    expect(store.playlists.size).toBe(2);
  });

  it('a post with no good title is said, and counted as pending (it will be tried again)', async () => {
    const summary = await buildAutoPlaylists(base(entries, [jazzPlan, null, jazzJoin]), { apply: false, owner: null, limit: null });
    expect(summary).toMatchObject({ pending: 1, created: 1, joined: 1 });
    expect(lines.some((l) => l.includes('e2') && l.includes('nessun titolo buono'))).toBe(true);
  });

  it('--apply asks for the real store and tells each user ONCE, with how many playlists and songs', async () => {
    const mixed = [...entries, entry('e5', '2026-08-01T10:00:00.000Z', ['Africa', 'Rosanna'], { ownerUser: 'sara' })];
    await buildAutoPlaylists(base(mixed, [jazzPlan, xmasPlan, jazzJoin, { aboutMusic: true, title: 'Rock anni 80', kind: 'theme', existingTheme: null }]), { apply: true, owner: null, limit: null });
    expect(storeAsked).toEqual([true]);
    expect(lines[0]).toContain('SCRIVE');
    expect(tellOwner).toHaveBeenCalledTimes(2);
    expect(tellOwner).toHaveBeenCalledWith('mike', { playlists: 2, songs: 7 });
    expect(tellOwner).toHaveBeenCalledWith('sara', { playlists: 1, songs: 2 });
  });

  it('a user whose posts only joined existing playlists is not told «I made playlists»', async () => {
    store = new MemoryAutoPlaylistStore();
    const first = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'old', createdAt: new Date() });
    expect(first.created).toBe(true);
    await buildAutoPlaylists(base([entries[0]], [jazzJoin]), { apply: true, owner: null, limit: null });
    expect(tellOwner).not.toHaveBeenCalled();
  });

  it('never prints the text of a post, only titles and counts', async () => {
    const secret = entry('e9', '2026-09-01T10:00:00.000Z', ['A', 'B'], { caption: 'TESTO-SEGRETO-DEL-POST' });
    await buildAutoPlaylists(base([secret], [xmasPlan]), { apply: false, owner: null, limit: null });
    expect(lines.join('\n')).not.toContain('TESTO-SEGRETO');
  });
});
