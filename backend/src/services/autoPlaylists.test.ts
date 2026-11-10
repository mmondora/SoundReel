import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../types';
import {
  MemoryAutoPlaylistStore,
  MIN_SONGS,
  contentSongs,
  findTheme,
  processEntry,
  talksAboutMusic,
  type AutoPlaylistDeps,
  type ThemeRow,
} from './autoPlaylists';
import type { TitlePlan, TitleSource } from './autoPlaylistTitle';

type SongSource = 'audio_fingerprint' | 'ai_analysis' | 'both' | 'music_list' | 'spotify_link' | 'shazam_link';
const song = (title: string, artist: string, source: SongSource = 'ai_analysis') => ({
  title, artist, album: null, source, spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false,
});

let n = 0;
const entry = (songs: ReturnType<typeof song>[], over: Partial<Entry> = {}): Entry =>
  ({
    id: `e${++n}`,
    sourceUrl: `https://www.instagram.com/reel/${n}/`,
    sourcePlatform: 'instagram',
    inputChannel: 'telegram',
    inputUser: null,
    ownerUser: 'mike',
    caption: 'ecco le 5 musiche di natale',
    thumbnailUrl: null,
    mediaUrl: null,
    status: 'completed',
    results: { songs, films: [], notes: [], links: [], tags: [], summary: 'Cinque canzoni natalizie.' },
    actionLog: [],
    createdAt: '2026-11-05T10:00:00.000Z',
    ...over,
  }) as Entry;

const christmas = () => [
  song('Last Christmas', 'Wham!'),
  song('All I Want for Christmas Is You', 'Mariah Carey'),
  song('Jingle Bell Rock', 'Bobby Helms'),
  song('Santa Tell Me', 'Ariana Grande'),
  song('Underneath the Tree', 'Kelly Clarkson'),
];
const jazz = (...titles: string[]) => titles.map((t) => song(t, 'Various'));

const keyOf = (artist: string, title: string) => `${artist.toLowerCase()}::${title.toLowerCase()}`;

let store: MemoryAutoPlaylistStore;
let titles: ReturnType<typeof vi.fn>;
let announce: ReturnType<typeof vi.fn>;
let lookup: Map<string, Entry>;

const deps = (): AutoPlaylistDeps => ({
  store,
  getEntry: async (id) => lookup.get(id) ?? null,
  title: titles as unknown as AutoPlaylistDeps['title'],
  language: async () => 'it',
  announce: announce as unknown as AutoPlaylistDeps['announce'],
});

const oneOff = (title: string): TitlePlan => ({ aboutMusic: true, title, kind: 'one_off', existingTheme: null });
const theme = (title: string, existing: string | null = null): TitlePlan => ({ aboutMusic: true, title, kind: 'theme', existingTheme: existing });

beforeEach(() => {
  n = 0;
  store = new MemoryAutoPlaylistStore();
  titles = vi.fn();
  announce = vi.fn().mockResolvedValue(undefined);
  lookup = new Map();
});

const run = async (e: Entry, opts?: { announce?: boolean }) => {
  lookup.set(e.id, e);
  return processEntry(e, deps(), opts);
};

describe('what counts as a post that talks about music', () => {
  it('takes the songs of the CONTENT, once each, in the order of the post', () => {
    const e = entry([
      song('A', 'X', 'ai_analysis'), song('B', 'X', 'both'), song('A', 'X', 'ai_analysis'), song('C', 'Y', 'music_list'),
    ]);
    expect(contentSongs(e).keys).toEqual(['x::a', 'x::b', 'y::c']);
    expect(contentSongs(e).songs.map((s) => s.title)).toEqual(['A', 'B', 'C']);
  });

  it('the background track found by the audio fingerprint, and the link paths, do not count', () => {
    const e = entry([song('A', 'X', 'audio_fingerprint'), song('B', 'X', 'audio_fingerprint'), song('C', 'X', 'spotify_link'), song('D', 'X', 'shazam_link')]);
    expect(contentSongs(e).keys).toEqual([]);
    expect(talksAboutMusic(e)).toBe(false);
  });

  it('a song without a title is no song; a song without an artist is still one', () => {
    const e = entry([song('', 'X'), song('   ', 'X'), { ...song('Solo titolo', ''), artist: undefined as unknown as string }]);
    expect(contentSongs(e).keys).toEqual(['::solo titolo']);
  });

  it('needs at least two: one song, or one plus a fingerprint, is not a playlist', () => {
    expect(MIN_SONGS).toBe(2);
    expect(talksAboutMusic(entry([song('A', 'X')]))).toBe(false);
    expect(talksAboutMusic(entry([song('A', 'X'), song('B', 'X', 'audio_fingerprint')]))).toBe(false);
    expect(talksAboutMusic(entry([song('A', 'X'), song('B', 'X')]))).toBe(true);
    expect(talksAboutMusic(entry([song('A', 'X', 'both'), song('B', 'X', 'both')]))).toBe(true);
  });

  it('an entry with no results at all is no problem', () => {
    expect(contentSongs({ results: undefined } as unknown as Entry).keys).toEqual([]);
  });
});

describe('a precise title: one playlist for the post', () => {
  it('«ecco le 5 musiche di natale» → a playlist with that title and the 5 songs, in the order of the post', async () => {
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    const e = entry(christmas());
    const out = await run(e);
    expect(out).toMatchObject({ status: 'done', title: 'Le 5 musiche di Natale', kind: 'one_off', created: true, added: 5 });
    if (out.status !== 'done') throw new Error('x');
    expect(store.songKeysOf(out.playlistId)).toEqual(christmas().map((s) => keyOf(s.artist, s.title)));
    const made = store.playlists.get(out.playlistId)!;
    expect(made).toMatchObject({ owner: 'mike', name: 'Le 5 musiche di Natale', kind: 'one_off', themeKey: null, sourceEntryId: e.id });
    // the date of creation is the date of the post
    expect(made.createdAt.toISOString()).toBe('2026-11-05T10:00:00.000Z');
  });

  it('is announced once: «Nuova playlist: …» with how many songs', async () => {
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    const e = entry(christmas());
    await run(e);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith({ userId: 'mike', entryId: e.id, title: 'Nuova playlist: Le 5 musiche di Natale', body: '5 brani' });
  });

  it('a second run of the same post does nothing: one playlist, one message', async () => {
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    const e = entry(christmas());
    await run(e);
    const again = await run(e);
    expect(again).toEqual({ status: 'skipped', reason: 'already_done' });
    expect(store.playlists.size).toBe(1);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(titles).toHaveBeenCalledTimes(1);
  });

  it('two posts with the same precise title are two playlists (the date beside the name tells them apart)', async () => {
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    await run(entry(christmas()));
    await run(entry(christmas().map((s) => ({ ...s, title: `${s.title} 2` })), { createdAt: '2026-11-09T10:00:00.000Z' }));
    expect(store.playlists.size).toBe(2);
    expect([...store.playlists.values()].map((p) => p.name)).toEqual(['Le 5 musiche di Natale', 'Le 5 musiche di Natale']);
  });
});

describe('a generic title: one playlist for the theme, the newest songs first', () => {
  const jazzOne = () => entry(jazz('So What', 'Take Five', 'Blue in Green'), { createdAt: '2026-11-01T10:00:00.000Z' });
  const jazzTwo = () => entry(jazz('Autumn Leaves', 'Naima'), { createdAt: '2026-11-08T10:00:00.000Z', caption: 'altri album jazz da ascoltare' });

  it('the first post makes the playlist and registers the theme', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare'));
    const out = await run(jazzOne());
    expect(out).toMatchObject({ status: 'done', kind: 'theme', created: true, added: 3, title: 'Jazz da ascoltare' });
    expect([...store.themes.values()]).toEqual([{ owner: 'mike', themeKey: 'ascoltare jazz', title: 'Jazz da ascoltare', playlistId: expect.any(String) }]);
    if (out.status !== 'done') throw new Error('x');
    expect(store.songKeysOf(out.playlistId)).toEqual(['various::so what', 'various::take five', 'various::blue in green']);
  });

  it('the next post of the theme joins THE SAME playlist; its songs go in front, in the order of that post', async () => {
    titles.mockResolvedValueOnce(theme('Jazz da ascoltare'));
    const first = await run(jazzOne());
    titles.mockResolvedValueOnce(theme('Jazz da ascoltare', 'Jazz da ascoltare'));
    const second = await run(jazzTwo());
    if (first.status !== 'done' || second.status !== 'done') throw new Error('x');
    expect(second.playlistId).toBe(first.playlistId);
    expect(second).toMatchObject({ created: false, added: 2 });
    expect(store.playlists.size).toBe(1);
    expect(store.songKeysOf(first.playlistId)).toEqual([
      'various::autumn leaves', 'various::naima', // the newest post first
      'various::so what', 'various::take five', 'various::blue in green',
    ]);
  });

  it('a third post goes in front of the second, and a song that is already there is not added twice', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare', 'Jazz da ascoltare'));
    await run(jazzOne());
    await run(jazzTwo());
    const third = await run(entry(jazz('So What', 'Round Midnight', 'Moanin'), { createdAt: '2026-11-10T10:00:00.000Z' }));
    if (third.status !== 'done') throw new Error('x');
    expect(third.added).toBe(2);
    expect(store.songKeysOf(third.playlistId)).toEqual([
      'various::round midnight', 'various::moanin',
      'various::autumn leaves', 'various::naima',
      'various::so what', 'various::take five', 'various::blue in green',
    ]);
  });

  it('the message of a post that feeds a theme says how many songs came in', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare', 'Jazz da ascoltare'));
    await run(jazzOne());
    const two = jazzTwo();
    await run(two);
    expect(announce).toHaveBeenLastCalledWith({ userId: 'mike', entryId: two.id, title: 'Jazz da ascoltare', body: '+2 brani' });
  });

  it('a post whose songs are all already there is done and says nothing', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare', 'Jazz da ascoltare'));
    await run(jazzOne());
    announce.mockClear();
    const out = await run(entry(jazz('So What', 'Take Five')));
    expect(out).toMatchObject({ status: 'done', created: false, added: 0 });
    expect(announce).not.toHaveBeenCalled();
  });

  it('finds the theme without the help of the model: the same words, or nearly', async () => {
    titles.mockResolvedValueOnce(theme('Jazz da ascoltare'));
    const first = await run(jazzOne());
    titles.mockResolvedValueOnce(theme('ascoltare jazz'));                 // same key
    const second = await run(jazzTwo());
    titles.mockResolvedValueOnce(theme('Jazz per ascoltare ancora'));      // 2 of 3 words: not enough
    const third = await run(entry(jazz('Cool Struttin', 'Misty')));
    if (first.status !== 'done' || second.status !== 'done' || third.status !== 'done') throw new Error('x');
    expect(second.playlistId).toBe(first.playlistId);
    expect(third.playlistId).not.toBe(first.playlistId);
    expect(store.playlists.size).toBe(2);
  });

  it('a playlist that was RENAMED keeps receiving its theme (the key is not the name)', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare', 'Jazz da ascoltare'));
    const first = await run(jazzOne());
    if (first.status !== 'done') throw new Error('x');
    store.playlists.get(first.playlistId)!.name = 'Il mio jazz della sera';
    const second = await run(jazzTwo());
    expect(second).toMatchObject({ status: 'done', created: false, playlistId: first.playlistId });
  });

  it('a playlist the user DELETED is not made again: the next post of the theme is skipped', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare', 'Jazz da ascoltare'));
    const first = await run(jazzOne());
    if (first.status !== 'done') throw new Error('x');
    store.deletePlaylist(first.playlistId);
    announce.mockClear();
    const second = await run(jazzTwo());
    expect(second).toEqual({ status: 'skipped', reason: 'theme_deleted' });
    expect(store.playlists.size).toBe(0);
    expect(announce).not.toHaveBeenCalled();
    // and the post is not asked about again
    const e = jazzTwo();
    await run(e);
    expect(await run(e)).toEqual({ status: 'skipped', reason: 'already_done' });
  });

  it('the model is told which themes exist, but not the ones the user deleted', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare'));
    const first = await run(jazzOne());
    if (first.status !== 'done') throw new Error('x');
    titles.mockClear();
    titles.mockResolvedValue(theme('Rock anni 80'));
    await run(entry(jazz('Africa', 'Rosanna')));
    const seen = titles.mock.calls[0][0] as TitleSource;
    expect(seen.themes).toEqual(['Jazz da ascoltare']);
    store.deletePlaylist(first.playlistId);
    titles.mockClear();
    await run(entry(jazz('Hysteria', 'Plush')));
    expect((titles.mock.calls[0][0] as TitleSource).themes).toEqual(['Rock anni 80']);
  });
});

describe('when there is nothing to make', () => {
  it('a post that does not talk about music is not even asked to the model, and leaves no trace', async () => {
    const e = entry([song('A', 'X', 'audio_fingerprint')]);
    expect(await run(e)).toEqual({ status: 'skipped', reason: 'not_music_post' });
    expect(titles).not.toHaveBeenCalled();
    expect(store.runs.size).toBe(0);
  });

  it('no good title: nothing is made with a bad one, the post stays «pending» and is tried again later', async () => {
    titles.mockResolvedValueOnce(null);
    const e = entry(christmas());
    expect(await run(e)).toEqual({ status: 'pending', reason: 'no_title' });
    expect(store.playlists.size).toBe(0);
    expect(announce).not.toHaveBeenCalled();
    expect(store.runs.get(`${e.id}|mike`)).toMatchObject({ status: 'pending', reason: 'no_title' });
    titles.mockResolvedValueOnce(oneOff('Le 5 musiche di Natale'));
    expect(await run(e)).toMatchObject({ status: 'done', created: true, added: 5 });
  });

  it('the songs are not what the post is about (a background track, the titles of films): no playlist, said once, never asked again', async () => {
    titles.mockResolvedValue({ aboutMusic: false, title: '', kind: 'one_off', existingTheme: null });
    const e = entry(christmas());
    expect(await run(e)).toEqual({ status: 'skipped', reason: 'not_about_music' });
    expect(store.playlists.size).toBe(0);
    expect(announce).not.toHaveBeenCalled();
    expect(store.runs.get(`${e.id}|mike`)).toMatchObject({ status: 'skipped', reason: 'not_about_music' });
    expect(await run(e)).toEqual({ status: 'skipped', reason: 'already_done' });
    expect(titles).toHaveBeenCalledTimes(1);
  });

  it('an entry that is gone, or has no owner, is skipped', async () => {
    expect(await processEntry('nope', deps())).toEqual({ status: 'skipped', reason: 'entry_not_found' });
    expect(await run(entry(christmas(), { ownerUser: 'anonymous' }))).toEqual({ status: 'skipped', reason: 'no_owner' });
    expect(await run(entry(christmas(), { ownerUser: '' }))).toEqual({ status: 'skipped', reason: 'no_owner' });
  });

  it('can be given the id of the entry', async () => {
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    const e = entry(christmas());
    lookup.set(e.id, e);
    expect(await processEntry(e.id, deps())).toMatchObject({ status: 'done' });
  });
});

describe('the user, the messages', () => {
  it('each user has his own playlists and his own themes', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare'));
    const a = await run(entry(jazz('So What', 'Take Five'), { ownerUser: 'mike' }));
    const b = await run(entry(jazz('So What', 'Take Five'), { ownerUser: 'sara' }));
    if (a.status !== 'done' || b.status !== 'done') throw new Error('x');
    expect(a.playlistId).not.toBe(b.playlistId);
    expect(store.playlists.size).toBe(2);
  });

  it('with `announce: false` (the preview, the backfill) nothing is announced', async () => {
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    await run(entry(christmas()), { announce: false });
    expect(announce).not.toHaveBeenCalled();
  });

  it('a message that cannot be sent does not undo the playlist', async () => {
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    announce.mockRejectedValue(new Error('inbox down'));
    const e = entry(christmas());
    expect(await run(e)).toMatchObject({ status: 'done', created: true });
    expect(store.runs.get(`${e.id}|mike`)?.status).toBe('done');
  });

  it('one song reads «1 brano»', async () => {
    titles.mockResolvedValue(theme('Jazz da ascoltare', 'Jazz da ascoltare'));
    await run(entry(jazz('So What', 'Take Five')));
    const e = entry(jazz('So What', 'Naima'));
    await run(e);
    expect(announce).toHaveBeenLastCalledWith(expect.objectContaining({ body: '+1 brano' }));
  });
});

describe('finding the theme', () => {
  const themes: ThemeRow[] = [
    { themeKey: 'ascoltare jazz', title: 'Jazz da ascoltare', playlistId: 'p1' },
    { themeKey: 'natale musica', title: 'Musica di Natale', playlistId: 'p2' },
    { themeKey: 'rock', title: 'Rock', playlistId: null },
  ];

  it('the theme the model named wins, then the same key, then the closest words', () => {
    expect(findTheme({ aboutMusic: true, title: 'Qualcosa', kind: 'theme', existingTheme: 'Musica di Natale' }, themes)?.playlistId).toBe('p2');
    expect(findTheme({ aboutMusic: true, title: 'ascoltare jazz', kind: 'theme', existingTheme: null }, themes)?.playlistId).toBe('p1');
    expect(findTheme({ aboutMusic: true, title: 'Musica natale', kind: 'theme', existingTheme: null }, themes)?.playlistId).toBe('p2');
  });

  it('a deleted theme is found too (so that it is NOT made again)', () => {
    expect(findTheme({ aboutMusic: true, title: 'Rock', kind: 'theme', existingTheme: null }, themes)).toMatchObject({ playlistId: null });
  });

  it('nothing in common is no theme', () => {
    expect(findTheme({ aboutMusic: true, title: 'Classica per studiare', kind: 'theme', existingTheme: null }, themes)).toBeNull();
    expect(findTheme({ aboutMusic: true, title: 'Jazz', kind: 'theme', existingTheme: null }, [])).toBeNull();
  });
});

describe('the memory store keeps the rules of the database', () => {
  it('one playlist per theme and per post, even when asked twice', async () => {
    const a = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'e1', createdAt: new Date() });
    const b = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'e2', createdAt: new Date() });
    expect(b).toEqual({ id: a.id, created: false });
    const c = await store.createPlaylist({ owner: 'mike', name: 'Natale', kind: 'one_off', themeKey: null, sourceEntryId: 'e3', createdAt: new Date() });
    const d = await store.createPlaylist({ owner: 'mike', name: 'Natale', kind: 'one_off', themeKey: null, sourceEntryId: 'e3', createdAt: new Date() });
    expect(d).toEqual({ id: c.id, created: false });
  });

  it('songs go in front of the ones that are there, in the order given, and never twice', async () => {
    const { id } = await store.createPlaylist({ owner: 'mike', name: 'T', kind: 'theme', themeKey: 't', sourceEntryId: 'e1', createdAt: new Date() });
    expect(await store.addSongs(id, ['a', 'b'], { front: false, addedAt: new Date() })).toBe(2);
    expect(await store.addSongs(id, ['c', 'd', 'a'], { front: true, addedAt: new Date() })).toBe(2);
    expect(await store.addSongs(id, ['c'], { front: true, addedAt: new Date() })).toBe(0);
    expect(store.songKeysOf(id)).toEqual(['c', 'd', 'a', 'b']);
    expect(await store.addSongs('missing', ['x'], { front: false, addedAt: new Date() })).toBe(0);
  });
});
