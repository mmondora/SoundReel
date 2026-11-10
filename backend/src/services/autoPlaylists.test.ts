import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../types';
import {
  MemoryAutoPlaylistStore,
  MIN_PLAYLIST_SONGS,
  MIN_SONGS,
  allSongs,
  contentSongs,
  findTheme,
  processEntry,
  songsFor,
  talksAboutMusic,
  type AutoPlaylistDeps,
  type ThemeRow,
} from './autoPlaylists';
import type { TitlePlan, TitleSource } from './autoPlaylistTitle';
import { genreRule } from './genreThemes';

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
/** How many songs of the library carry the genre (the library the playlist of a genre looks at); what was asked. */
let genreCount = 0;
let genreAsked: Array<[string, string[]]> = [];

const deps = (): AutoPlaylistDeps => ({
  store,
  getEntry: async (id) => lookup.get(id) ?? null,
  title: titles as unknown as AutoPlaylistDeps['title'],
  language: async () => 'it',
  announce: announce as unknown as AutoPlaylistDeps['announce'],
  countGenreSongs: async (owner, genres) => {
    genreAsked.push([owner, genres]);
    return genreCount;
  },
});

const oneOff = (title: string): TitlePlan => ({ aboutMusic: true, title, kind: 'one_off', existingTheme: null });
const theme = (title: string, existing: string | null = null): TitlePlan => ({ aboutMusic: true, title, kind: 'theme', existingTheme: existing });

beforeEach(() => {
  n = 0;
  store = new MemoryAutoPlaylistStore();
  titles = vi.fn();
  announce = vi.fn().mockResolvedValue(undefined);
  lookup = new Map();
  genreCount = 0;
  genreAsked = [];
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
    titles.mockResolvedValue(theme('Synthwave da ascoltare'));
    const out = await run(jazzOne());
    expect(out).toMatchObject({ status: 'done', kind: 'theme', created: true, added: 3, title: 'Synthwave da ascoltare' });
    expect([...store.themes.values()]).toEqual([{ owner: 'mike', themeKey: 'ascoltare synthwave', title: 'Synthwave da ascoltare', playlistId: expect.any(String) }]);
    if (out.status !== 'done') throw new Error('x');
    expect(store.songKeysOf(out.playlistId)).toEqual(['various::so what', 'various::take five', 'various::blue in green']);
  });

  it('the next post of the theme joins THE SAME playlist; its songs go in front, in the order of that post', async () => {
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare'));
    const first = await run(jazzOne());
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
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
    titles.mockResolvedValue(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
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
    titles.mockResolvedValue(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    await run(jazzOne());
    const two = jazzTwo();
    await run(two);
    expect(announce).toHaveBeenLastCalledWith({ userId: 'mike', entryId: two.id, title: 'Synthwave da ascoltare', body: '+2 brani' });
  });

  it('a post whose songs are all already there is done and says nothing', async () => {
    titles.mockResolvedValue(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    await run(jazzOne());
    announce.mockClear();
    const out = await run(entry(jazz('So What', 'Take Five')));
    expect(out).toMatchObject({ status: 'done', created: false, added: 0 });
    expect(announce).not.toHaveBeenCalled();
  });

  it('finds the theme without the help of the model: the same words, or nearly', async () => {
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare'));
    const first = await run(jazzOne());
    titles.mockResolvedValueOnce(theme('ascoltare synthwave'));                 // same key
    const second = await run(jazzTwo());
    titles.mockResolvedValueOnce(theme('Jazz per ascoltare ancora'));      // 2 of 3 words: not enough
    const third = await run(entry(jazz('Cool Struttin', 'Misty')));
    if (first.status !== 'done' || second.status !== 'done' || third.status !== 'done') throw new Error('x');
    expect(second.playlistId).toBe(first.playlistId);
    expect(third.playlistId).not.toBe(first.playlistId);
    expect(store.playlists.size).toBe(2);
  });

  it('a playlist that was RENAMED keeps receiving its theme (the key is not the name)', async () => {
    titles.mockResolvedValue(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    const first = await run(jazzOne());
    if (first.status !== 'done') throw new Error('x');
    store.playlists.get(first.playlistId)!.name = 'Il mio jazz della sera';
    const second = await run(jazzTwo());
    expect(second).toMatchObject({ status: 'done', created: false, playlistId: first.playlistId });
  });

  it('a playlist the user DELETED is not made again: the next post of the theme is skipped', async () => {
    titles.mockResolvedValue(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
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
    titles.mockResolvedValue(theme('Synthwave da ascoltare'));
    const first = await run(jazzOne());
    if (first.status !== 'done') throw new Error('x');
    titles.mockClear();
    titles.mockResolvedValue(theme('Rock anni 80'));
    await run(entry(jazz('Africa', 'Rosanna')));
    const seen = titles.mock.calls[0][0] as TitleSource;
    expect(seen.themes).toEqual(['Synthwave da ascoltare']);
    store.deletePlaylist(first.playlistId);
    titles.mockClear();
    await run(entry(jazz('Hysteria', 'Plush')));
    expect((titles.mock.calls[0][0] as TitleSource).themes).toEqual(['Rock anni 80']);
  });
});

describe('when there is nothing to make', () => {
  it('a post with no song at all is not even asked to the model, and leaves no trace', async () => {
    const e = entry([]);
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
    titles.mockResolvedValue(theme('Synthwave da ascoltare'));
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
    titles.mockResolvedValue(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
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
    const a = await store.createPlaylist({ owner: 'mike', name: 'Synthwave da ascoltare', kind: 'theme', themeKey: 'ascoltare synthwave', sourceEntryId: 'e1', createdAt: new Date() });
    const b = await store.createPlaylist({ owner: 'mike', name: 'Synthwave da ascoltare', kind: 'theme', themeKey: 'ascoltare synthwave', sourceEntryId: 'e2', createdAt: new Date() });
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


describe('a post with ONE song: only ever a theme, and only when it is about music (Michele: «di tutti i post»)', () => {
  const fingerprint = (title: string) => entry([song(title, 'Various', 'audio_fingerprint')], { caption: 'questo pezzo e\' una bomba' });
  const asked = () => titles.mock.calls[0][0] as TitleSource;

  it('songsFor: several content songs are a LIST; one song (named, else recognised) is SINGLE; none is nothing', () => {
    expect(songsFor(entry(christmas()))?.mode).toBe('list');
    expect(songsFor(entry([song('A', 'X', 'ai_analysis')]))).toMatchObject({ mode: 'single', keys: ['x::a'] });
    expect(songsFor(entry([song('A', 'X', 'audio_fingerprint')]))).toMatchObject({ mode: 'single', keys: ['x::a'] });
    expect(songsFor(entry([]))).toBeNull();
    expect(songsFor(entry([song('', 'X')]))).toBeNull();
  });

  it('a song the post NAMES wins over the track recognised from the audio', () => {
    const found = songsFor(entry([song('Named', 'X', 'ai_analysis'), song('Background', 'Y', 'audio_fingerprint')]));
    expect(found).toMatchObject({ mode: 'single', keys: ['x::named'] });
    expect(allSongs(entry([song('Named', 'X', 'ai_analysis'), song('Background', 'Y', 'audio_fingerprint')])).keys).toEqual(['x::named', 'y::background']);
  });

  it('two recognised tracks and nothing named are still a single-song post (they are not a list the post makes)', () => {
    expect(songsFor(entry([song('A', 'X', 'audio_fingerprint'), song('B', 'Y', 'audio_fingerprint')]))).toMatchObject({ mode: 'single', keys: ['x::a', 'y::b'] });
  });

  it('the title step is told which kind of post it is', async () => {
    titles.mockResolvedValue(theme('Synthwave da ascoltare'));
    await run(fingerprint('Nightcall'));
    expect(asked().mode).toBe('single');
    expect(asked().songs).toEqual([{ title: 'Nightcall', artist: 'Various' }]);
    titles.mockClear();
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    await run(entry(christmas()));
    expect(asked().mode).toBe('list');
  });

  it('about music: the first single song WAITS (a playlist has two songs), the second one makes the playlist with both, the next one joins it', async () => {
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare'));
    const first = await run(fingerprint('Nightcall'));
    expect(first).toEqual({ status: 'waiting', reason: 'needs_two_songs' });
    expect(store.playlists.size).toBe(0);
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    const second = await run(entry([song('Dynamite Girl', 'Mitch Murder', 'audio_fingerprint')], { createdAt: '2026-11-08T10:00:00.000Z' }));
    if (second.status !== 'done') throw new Error('x');
    expect(second).toMatchObject({ kind: 'theme', created: true, mode: 'single', added: 2 });
    expect(store.songKeysOf(second.playlistId)).toEqual(['mitch murder::dynamite girl', 'various::nightcall']);
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    const third = await run(entry([song('Turbo Killer', 'Carpenter Brut', 'audio_fingerprint')], { createdAt: '2026-11-09T10:00:00.000Z' }));
    expect(third).toMatchObject({ status: 'done', playlistId: second.playlistId, created: false, added: 1 });
    expect(store.songKeysOf(second.playlistId)[0]).toBe('carpenter brut::turbo killer');
  });

  it('a precise title for ONE song is still a theme (one song is no list), and it waits like any theme', async () => {
    titles.mockResolvedValue(oneOff('Nightcall di Kavinsky'));
    expect(await run(fingerprint('Nightcall'))).toEqual({ status: 'waiting', reason: 'needs_two_songs' });
    expect([...store.runs.values()][0]).toMatchObject({ status: 'waiting', themeKey: expect.any(String) });
    expect(store.playlists.size).toBe(0);
  });

  it('not about music (the background track of a recipe): skipped, said once, no playlist', async () => {
    titles.mockResolvedValue({ aboutMusic: false, title: '', kind: 'theme', existingTheme: null });
    const e = fingerprint('Levitating');
    expect(await run(e)).toEqual({ status: 'skipped', reason: 'not_about_music' });
    expect(store.playlists.size).toBe(0);
    expect(await run(e)).toEqual({ status: 'skipped', reason: 'already_done' });
    expect(titles).toHaveBeenCalledTimes(1);
  });

  it('a NEW theme is announced when it is BORN (with two songs); one more single song in a theme is not news; a LIST joining a theme still is', async () => {
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare'));
    await run(fingerprint('Nightcall'));
    expect(announce).not.toHaveBeenCalled(); // one song: nothing is born yet, so there is nothing to announce
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    await run(entry([song('Dynamite Girl', 'Mitch Murder', 'audio_fingerprint')]));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Nuova playlist: Synthwave da ascoltare', body: '2 brani' }));
    announce.mockClear();
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    await run(entry([song('Digital Rain', 'Gunship', 'audio_fingerprint')]));
    expect(announce).not.toHaveBeenCalled();
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    await run(entry([song('Turbo Killer', 'Carpenter Brut'), song('Resistance', 'Perturbator')]));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Synthwave da ascoltare', body: '+2 brani' }));
  });

  it('a deleted theme is not made again for a single song either', async () => {
    titles.mockResolvedValue(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
    await run(fingerprint('Nightcall'));
    const second = await run(entry([song('Dynamite Girl', 'Mitch Murder', 'audio_fingerprint')]));
    if (second.status !== 'done') throw new Error('x');
    store.deletePlaylist(second.playlistId);
    expect(await run(entry([song('Turbo Killer', 'Carpenter Brut', 'audio_fingerprint')]))).toEqual({ status: 'skipped', reason: 'theme_deleted' });
  });
});

describe('a playlist has at least two songs (Michele, 10 November: «le playlist non possono essere di una sola canzone … si chiamano "play list"»)', () => {
  const single = (title: string, artist: string, createdAt = '2026-11-05T10:00:00.000Z') => entry([song(title, artist, 'audio_fingerprint')], { createdAt });
  const synth = () => titles.mockResolvedValue(theme('Synthwave da ascoltare', 'Synthwave da ascoltare'));
  const waitingRun = (themeKey: string) => ({ status: 'waiting' as const, playlistId: null, reason: 'needs_two_songs', themeKey });

  it('the minimum is two', () => {
    expect(MIN_PLAYLIST_SONGS).toBe(2);
  });

  it('one song waits: no playlist, no theme, no message, and the post is remembered as waiting for its theme', async () => {
    synth();
    const e = single('Nightcall', 'Kavinsky');
    expect(await run(e)).toEqual({ status: 'waiting', reason: 'needs_two_songs' });
    expect(store.playlists.size).toBe(0);
    expect(store.themes.size).toBe(0);
    expect(announce).not.toHaveBeenCalled();
    expect(store.runs.get(`${e.id}|mike`)).toEqual(waitingRun('ascoltare synthwave'));
    expect(genreAsked).toEqual([]); // a theme with no tag in the metadata never looks at the library
  });

  it('the same song in two posts is still ONE song: it keeps waiting', async () => {
    synth();
    await run(single('Nightcall', 'Kavinsky'));
    expect(await run(single('Nightcall', 'Kavinsky'))).toEqual({ status: 'waiting', reason: 'needs_two_songs' });
    expect(store.playlists.size).toBe(0);
  });

  it('the second DIFFERENT song makes the playlist with both, the post that waited is done, and ONE message says «2 brani»', async () => {
    synth();
    const first = single('Nightcall', 'Kavinsky', '2026-11-01T10:00:00.000Z');
    await run(first);
    const out = await run(single('Dynamite Girl', 'Mitch Murder', '2026-11-03T10:00:00.000Z'));
    if (out.status !== 'done') throw new Error('x');
    expect(out).toMatchObject({ created: true, added: 2 });
    expect(store.songKeysOf(out.playlistId)).toEqual([keyOf('Mitch Murder', 'Dynamite Girl'), keyOf('Kavinsky', 'Nightcall')]);
    expect(store.runs.get(`${first.id}|mike`)).toEqual({ status: 'done', playlistId: out.playlistId, reason: null });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nuova playlist: Synthwave da ascoltare', body: '2 brani' }));
  });

  it('a LIST of the theme that arrives while a post waits: the playlist has the list and the waiting song, the newest first', async () => {
    synth();
    await run(single('Nightcall', 'Kavinsky', '2026-11-01T10:00:00.000Z'));
    const out = await run(entry([song('Turbo Killer', 'Carpenter Brut'), song('Resistance', 'Perturbator')], { createdAt: '2026-11-04T10:00:00.000Z' }));
    if (out.status !== 'done') throw new Error('x');
    expect(out).toMatchObject({ created: true, added: 3, mode: 'list' });
    expect(store.songKeysOf(out.playlistId)).toEqual([keyOf('Carpenter Brut', 'Turbo Killer'), keyOf('Perturbator', 'Resistance'), keyOf('Kavinsky', 'Nightcall')]);
  });

  it('a waiting post is looked at again: with another one waiting for the same theme, running it once more makes the playlist (the catch-up)', async () => {
    synth();
    const a = single('Nightcall', 'Kavinsky', '2026-11-01T10:00:00.000Z');
    const b = single('Dynamite Girl', 'Mitch Murder', '2026-11-02T10:00:00.000Z');
    lookup.set(a.id, a);
    lookup.set(b.id, b);
    await store.saveRun(a.id, 'mike', waitingRun('ascoltare synthwave'));
    await store.saveRun(b.id, 'mike', waitingRun('ascoltare synthwave'));
    const out = await run(a);
    if (out.status !== 'done') throw new Error('x');
    expect(out).toMatchObject({ created: true, added: 2 });
    expect(store.songKeysOf(out.playlistId)).toEqual([keyOf('Mitch Murder', 'Dynamite Girl'), keyOf('Kavinsky', 'Nightcall')]);
    expect(store.runs.get(`${a.id}|mike`)?.status).toBe('done');
    expect(store.runs.get(`${b.id}|mike`)).toEqual({ status: 'done', playlistId: out.playlistId, reason: null });
    expect(await run(b)).toEqual({ status: 'skipped', reason: 'already_done' });
  });

  it('what waits for ANOTHER theme does not count: a song of «Folk» is no help to «Synthwave»', async () => {
    titles.mockResolvedValueOnce(theme('Musica per la notte'));
    await run(single('Nightcall', 'Kavinsky'));
    titles.mockResolvedValueOnce(theme('Synthwave da ascoltare'));
    expect(await run(single('Dynamite Girl', 'Mitch Murder'))).toEqual({ status: 'waiting', reason: 'needs_two_songs' });
    expect(store.playlists.size).toBe(0);
  });

  it('what waits for the same theme but belongs to ANOTHER user does not count (each user has his own themes)', async () => {
    synth();
    await run(entry([song('Nightcall', 'Kavinsky', 'audio_fingerprint')], { ownerUser: 'sara' }));
    expect(await run(single('Dynamite Girl', 'Mitch Murder'))).toEqual({ status: 'waiting', reason: 'needs_two_songs' });
    expect(store.playlists.size).toBe(0);
  });

  it('a post that was marked done is not a waiting one: only the waiting ones are pooled', async () => {
    synth();
    const done = single('Nightcall', 'Kavinsky');
    lookup.set(done.id, done);
    await store.saveRun(done.id, 'mike', { status: 'done', playlistId: null, reason: null, themeKey: 'ascoltare synthwave' });
    expect(await run(single('Dynamite Girl', 'Mitch Murder'))).toEqual({ status: 'waiting', reason: 'needs_two_songs' });
  });

  it('a theme the user deleted is not made again, waiting or not', async () => {
    store.themes.set('mike|ascoltare synthwave', { owner: 'mike', themeKey: 'ascoltare synthwave', title: 'Synthwave da ascoltare', playlistId: null });
    synth();
    expect(await run(single('Nightcall', 'Kavinsky'))).toEqual({ status: 'skipped', reason: 'theme_deleted' });
  });

  it('a post that LISTS music never waits: a playlist of its own is born with all its songs', async () => {
    titles.mockResolvedValue(oneOff('Le 5 musiche di Natale'));
    expect(await run(entry(christmas()))).toMatchObject({ status: 'done', created: true, added: 5 });
  });

  it('INVARIANT: whatever mix of posts comes, no playlist the engine makes has fewer than two songs', async () => {
    const plans: TitlePlan[] = [
      theme('Synthwave da ascoltare'), theme('Musica per la notte'), oneOff('Le 5 musiche di Natale'), theme('Synthwave da ascoltare', 'Synthwave da ascoltare'),
      theme('Musica per allenarsi'), theme('Musica per la notte', 'Musica per la notte'), theme('Lo-fi da ascoltare'), theme('Synthwave da ascoltare', 'Synthwave da ascoltare'),
    ];
    const posts = [
      single('A', 'one'), single('B', 'two'), entry(christmas()), single('C', 'three'),
      single('D', 'four'), single('E', 'five'), single('F', 'six'), single('A', 'one'),
    ];
    for (let i = 0; i < posts.length; i++) {
      titles.mockResolvedValueOnce(plans[i]);
      await run(posts[i]);
    }
    expect(store.playlists.size).toBeGreaterThan(0);
    for (const p of store.playlists.values()) expect(p.songs.length, p.name).toBeGreaterThanOrEqual(MIN_PLAYLIST_SONGS);
  });
});

describe('a theme that names a genre is a RULE on the genre, not a list of songs (Michele, 10 November: «"Soul da ascoltare" … deve avere il tag soul la canzone»)', () => {
  const soul = (existing: string | null = null) => theme('Soul da ascoltare', existing);
  const one = (title = 'Midnight Train', artist = 'Gladys Knight', createdAt = '2026-11-05T10:00:00.000Z') => entry([song(title, artist, 'audio_fingerprint')], { createdAt });

  it('the playlist is DYNAMIC: the rule of the genre and no song of its own, born when the library has two songs with the tag', async () => {
    titles.mockResolvedValue(soul());
    genreCount = 30;
    const out = await run(one());
    if (out.status !== 'done') throw new Error('x');
    expect(out).toMatchObject({ kind: 'theme', created: true, title: 'Soul da ascoltare', added: 30 });
    const made = store.playlists.get(out.playlistId);
    expect(made?.rule).toEqual(genreRule(['R&B/Soul']));
    expect(made?.songs).toEqual([]); // the songs come from the tag, at read time
    expect(made?.themeKey).toBe('genre:R&B/Soul');
    expect(genreAsked).toEqual([['mike', ['R&B/Soul']]]);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nuova playlist: Soul da ascoltare', body: '30 brani' }));
  });

  it('the rule is the ONLY way the playlist is filled: the song of the post is not copied into it', async () => {
    titles.mockResolvedValue(soul());
    genreCount = 12;
    const out = await run(entry([song('Midnight Train', 'Gladys Knight'), song('Neither One of Us', 'Gladys Knight')]));
    if (out.status !== 'done') throw new Error('x');
    expect(store.playlists.get(out.playlistId)?.songs).toEqual([]);
  });

  it('with fewer than two songs that carry the tag it WAITS: a playlist has two songs, and a dynamic one would have one', async () => {
    titles.mockResolvedValue(soul());
    genreCount = 1;
    const e = one();
    expect(await run(e)).toEqual({ status: 'waiting', reason: 'needs_two_songs' });
    expect(store.playlists.size).toBe(0);
    expect(store.themes.size).toBe(0);
    expect(announce).not.toHaveBeenCalled();
    expect(store.runs.get(`${e.id}|mike`)).toEqual({ status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: 'genre:R&B/Soul' });
  });

  it('the playlist is born later, when another post of the theme finds two songs with the tag, and the post that waited is closed', async () => {
    titles.mockResolvedValue(soul());
    genreCount = 1;
    const first = one('Midnight Train', 'Gladys Knight', '2026-11-01T10:00:00.000Z');
    await run(first);
    genreCount = 2;
    const out = await run(one('Superstition', 'Stevie Wonder', '2026-11-03T10:00:00.000Z'));
    if (out.status !== 'done') throw new Error('x');
    expect(out).toMatchObject({ created: true, added: 2 });
    expect(store.runs.get(`${first.id}|mike`)).toEqual({ status: 'done', playlistId: out.playlistId, reason: null });
  });

  it('the posts that come after add nothing and say nothing, even a LIST: the tag decides what is in', async () => {
    titles.mockResolvedValue(soul());
    genreCount = 30;
    const first = await run(one());
    if (first.status !== 'done') throw new Error('x');
    announce.mockClear();
    titles.mockResolvedValue(soul('Soul da ascoltare'));
    const next = await run(entry([song('Superstition', 'Stevie Wonder'), song('Ain\'t No Sunshine', 'Bill Withers')]));
    expect(next).toMatchObject({ status: 'done', playlistId: first.playlistId, created: false, added: 0 });
    expect(announce).not.toHaveBeenCalled();
    expect(store.playlists.get(first.playlistId)?.songs).toEqual([]);
    expect(store.playlists.size).toBe(1);
  });

  it('«Rap da ascoltare» and «Hip hop da ascoltare» are ONE playlist, as «R&B» and «Soul» are', async () => {
    genreCount = 20;
    titles.mockResolvedValueOnce(theme('Hip hop da ascoltare'));
    const a = await run(one('Juicy', 'The Notorious B.I.G.'));
    titles.mockResolvedValueOnce(theme('Rap da ascoltare'));
    const b = await run(one('Alright', 'Kendrick Lamar'));
    if (a.status !== 'done' || b.status !== 'done') throw new Error('x');
    expect(b).toMatchObject({ playlistId: a.playlistId, created: false, title: 'Hip hop da ascoltare' });
    titles.mockResolvedValueOnce(theme('R&B da ascoltare'));
    const c = await run(one('Crazy in Love', 'Beyoncé'));
    titles.mockResolvedValueOnce(theme('Soul da ascoltare'));
    const d = await run(one('Superstition', 'Stevie Wonder'));
    if (c.status !== 'done' || d.status !== 'done') throw new Error('x');
    expect(d.playlistId).toBe(c.playlistId);
    expect(store.playlists.size).toBe(2);
  });

  it('a playlist of a genre that the user DELETED is not made again', async () => {
    titles.mockResolvedValue(soul());
    genreCount = 30;
    const first = await run(one());
    if (first.status !== 'done') throw new Error('x');
    store.deletePlaylist(first.playlistId);
    expect(await run(one('Superstition', 'Stevie Wonder'))).toEqual({ status: 'skipped', reason: 'theme_deleted' });
  });

  it('a post that is not about music is skipped before the library is even looked at', async () => {
    titles.mockResolvedValue({ aboutMusic: false, title: '', kind: 'theme', existingTheme: null });
    genreCount = 30;
    expect(await run(one())).toEqual({ status: 'skipped', reason: 'not_about_music' });
    expect(genreAsked).toEqual([]);
  });

  it('the number it announces is what the rule will show: at most 200 songs, even when the library has more', async () => {
    titles.mockResolvedValue(soul());
    genreCount = 500;
    const out = await run(one());
    expect(out).toMatchObject({ status: 'done', created: true, added: 200 });
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ body: '200 brani' }));
  });

  it('each user is counted on his own library', async () => {
    titles.mockResolvedValue(soul());
    genreCount = 5;
    await run(entry([song('A', 'x', 'audio_fingerprint')], { ownerUser: 'sara' }));
    expect(genreAsked).toEqual([['sara', ['R&B/Soul']]]);
  });
});
