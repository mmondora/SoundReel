import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getUserSongs: vi.fn(), libraryEntries: vi.fn(), buildTracks: vi.fn() }));
vi.mock('./userSongs', () => ({ getUserSongs: m.getUserSongs }));
vi.mock('./libraryOnlySongs', async (orig) => ({ ...(await orig<typeof import('./libraryOnlySongs')>()), libraryEntries: m.libraryEntries }));
vi.mock('./offlineManifest', () => ({ buildTracks: m.buildTracks }));
vi.mock('../utils/db', () => ({ query: vi.fn() }));

import { creditsOf, parseSearchQuery, searchEverything } from './mondropSearch';
import type { LibraryEntry } from './libraryOnlySongs';
import type { AggregatedSong } from '../types';

const journalSong = (artist: string, title: string, album: string | null = null): AggregatedSong => ({
  songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`, title, artist, album, youtubeUrl: null, spotifyUrl: null,
  mentions: [{ entryId: 'e1', createdAt: '2026-11-01T00:00:00Z' }], meta: null, inLibrary: false,
});

const entry = (artist: string, title: string, album: string | null, where: 'local' | 'media' | 'both' = 'media'): LibraryEntry => ({
  songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`, artist, title, album,
  local: where === 'media' ? null : ({ relPath: `${album ?? 'x'}/${artist} - ${title}.mp3` } as never),
  media: where === 'local' ? null : ({ relPath: `Music/${artist}/${album ?? 'x'}/${title}.mp3` } as never),
});

const BASSI = [
  entry('Bassi Maestro', 'Foto di gruppo', 'Foto di gruppo', 'both'),
  entry('Bassi Maestro', 'S.I.C.', 'Background'),
  entry('Bassi Maestro', 'Capirai', 'Background', 'local'),
  entry('Bassi Maestro, Fabri Fibra', 'Non muovono il collo', 'Mia maestà'),
  entry('Hell Raton, Ensi, Salmo, Bassi Maestro, Gemitaiz', "King's Supreme", 'Street Collection vol.1'),
  entry('Daft Punk', 'One More Time', 'Discovery'),
];

const ask = (over: Record<string, unknown> = {}) =>
  searchEverything({ q: 'bassi maestro', artist: null, album: null, limit: 30, offset: 0, sections: true, userId: 'mike', ...over } as never);

beforeEach(() => {
  vi.clearAllMocks();
  m.getUserSongs.mockResolvedValue(new Map()); // the journal knows no Bassi Maestro: the case Michele met on 8 November
  m.libraryEntries.mockResolvedValue({ all: BASSI, byKey: new Map(BASSI.map((e) => [e.songKey, e])) });
  m.buildTracks.mockImplementation(async (songs: AggregatedSong[]) => songs.map((s) => ({ songKey: s.songKey, title: s.title, artist: s.artist, album: s.album, libraryOnly: s.libraryOnly ?? false })));
});

describe('parseSearchQuery', () => {
  it('reads the query string with the documented defaults', () => {
    expect(parseSearchQuery({ q: ' bassi maestro ' })).toEqual({ ok: true, value: { q: 'bassi maestro', artist: null, album: null, limit: 30, offset: 0, sections: true } });
    expect(parseSearchQuery({ artist: 'Bassi Maestro', limit: '5', offset: '10', sections: '0' })).toEqual({ ok: true, value: { q: '', artist: 'Bassi Maestro', album: null, limit: 5, offset: 10, sections: false } });
  });

  it('refuses an empty search (it would list the whole library) and every malformed number', () => {
    expect(parseSearchQuery({})).toEqual({ ok: false, field: 'q' });
    expect(parseSearchQuery({ q: '   ' })).toEqual({ ok: false, field: 'q' });
    expect(parseSearchQuery({ q: 'x', limit: '0' })).toEqual({ ok: false, field: 'limit' });
    expect(parseSearchQuery({ q: 'x', limit: '201' })).toEqual({ ok: false, field: 'limit' });
    expect(parseSearchQuery({ q: 'x', limit: 'abc' })).toEqual({ ok: false, field: 'limit' });
    expect(parseSearchQuery({ q: 'x', offset: '-1' })).toEqual({ ok: false, field: 'offset' });
    expect(parseSearchQuery({ q: 'x', sections: '2' })).toEqual({ ok: false, field: 'sections' });
  });
});

describe('creditsOf', () => {
  it('splits a credit into the artists, however it is written', () => {
    expect(creditsOf('Bassi Maestro, Fabri Fibra')).toEqual(['Bassi Maestro', 'Fabri Fibra']);
    expect(creditsOf('Hell Raton, Ensi & Salmo feat. Gemitaiz')).toEqual(['Hell Raton', 'Ensi', 'Salmo', 'Gemitaiz']);
    expect(creditsOf('Sidewalks and Skeletons')).toEqual(['Sidewalks and Skeletons']);
    expect(creditsOf('')).toEqual([]);
  });
});

describe('searchEverything: Bassi Maestro, who is on the NAS and on geekom but not in the journal', () => {
  it('finds every song of his, library-only, one row each, with no field that names a store', async () => {
    const r = await ask();
    expect(r.total).toBe(5);
    expect(r.tracks.map((t) => t.title).sort()).toEqual(['Capirai', "King's Supreme", 'Foto di gruppo', 'Non muovono il collo', 'S.I.C.'].sort());
    expect(m.buildTracks.mock.calls[0][0].every((s: AggregatedSong) => s.libraryOnly === true && s.mentions.length === 0)).toBe(true);
    for (const t of r.tracks) expect(Object.keys(t)).not.toEqual(expect.arrayContaining(['where']));
  });

  it('word order and accents do not matter: «Maestro Bassi» finds him, «mia maesta» finds the album', async () => {
    expect((await ask({ q: 'maestro bassi' })).total).toBe(5);
    const r = await ask({ q: 'mia maesta' });
    expect(r.tracks.map((t) => t.title)).toEqual(['Non muovono il collo']);
    expect(r.albums).toEqual([{ title: 'Mia maestà', artist: 'Bassi Maestro', tracks: 1 }]);
  });

  it('lists him as an artist once, counting the songs where he is only one of the credited names', async () => {
    const r = await ask();
    expect(r.artists).toEqual([{ name: 'Bassi Maestro', tracks: 5 }]); // not Fabri Fibra, not Gemitaiz: they do not match what was typed
  });

  it('counts the albums among ALL the matches, not only the page, biggest first', async () => {
    const r = await ask({ limit: 1 });
    expect(r.tracks).toHaveLength(1);
    expect(r.total).toBe(5);
    expect(r.albums[0]).toEqual({ title: 'Background', artist: 'Bassi Maestro', tracks: 2 });
    expect(r.albums.map((a) => a.title).sort()).toEqual(['Background', 'Foto di gruppo', 'Mia maestà', 'Street Collection vol.1']);
  });

  it('pages the tracks with limit and offset', async () => {
    const first = await ask({ limit: 2 });
    const second = await ask({ limit: 2, offset: 2 });
    expect(first.tracks).toHaveLength(2);
    expect(second.tracks).toHaveLength(2);
    expect(new Set([...first.tracks, ...second.tracks].map((t) => t.songKey)).size).toBe(4);
    expect(second.offset).toBe(2);
  });

  it('artist= gives the page of ONE artist (every credited name counts) and the albums, without the artists section', async () => {
    const r = await ask({ q: '', artist: 'Bassi Maestro' });
    expect(r.total).toBe(5);
    expect(r.artists).toEqual([]);
    expect(r.albums.length).toBe(4);
    expect((await ask({ q: '', artist: 'Fabri Fibra' })).tracks.map((t) => t.title)).toEqual(['Non muovono il collo']);
  });

  it('album= gives the tracks of one album and no albums section', async () => {
    const r = await ask({ q: '', album: 'Background' });
    expect(r.tracks.map((t) => t.title).sort()).toEqual(['Capirai', 'S.I.C.']);
    expect(r.albums).toEqual([]);
  });

  it('sections=0 sends only the tracks', async () => {
    const r = await ask({ sections: false });
    expect(r.artists).toEqual([]);
    expect(r.albums).toEqual([]);
    expect(r.tracks.length).toBe(5);
  });

  it('a song with the words only in its album comes after the ones with the words in the artist or the title', async () => {
    m.libraryEntries.mockResolvedValue({
      all: [entry('Qualcuno', 'Brano', 'Bassi Maestro Live'), entry('Bassi Maestro', 'Zeta', 'Altro')],
      byKey: new Map(),
    });
    const r = await ask();
    expect(r.tracks.map((t) => t.title)).toEqual(['Zeta', 'Brano']);
  });

  it('finds nothing without failing, also when the catalogue is empty (the box was out)', async () => {
    m.libraryEntries.mockResolvedValue({ all: [], byKey: new Map() });
    expect(await ask()).toMatchObject({ tracks: [], artists: [], albums: [], total: 0 });
    expect(m.buildTracks).toHaveBeenCalledWith([], 'mike');
  });
});

describe('searchEverything: the journal and the files are ONE list', () => {
  it('a song in the journal and as a file is a single row, and the journal object (it knows more) is the one used', async () => {
    const j = journalSong('Bassi Maestro', 'Foto di gruppo', 'Foto di gruppo');
    m.getUserSongs.mockResolvedValue(new Map([[j.songKey, j]]));
    const r = await ask();
    const rows = r.tracks.filter((t) => t.title === 'Foto di gruppo');
    expect(rows).toHaveLength(1);
    expect(rows[0].libraryOnly).toBe(false);
    expect(r.total).toBe(5); // not 6
  });

  it('a version is its own song: «S.I.C. (2019 Remastered)» is not hidden behind «S.I.C.»', async () => {
    m.libraryEntries.mockResolvedValue({ all: [...BASSI, entry('Bassi Maestro', 'S.I.C. (2019 Remastered)', 'Background')], byKey: new Map() });
    const titles = (await ask()).tracks.map((t) => t.title);
    expect(titles).toContain('S.I.C.');
    expect(titles).toContain('S.I.C. (2019 Remastered)');
  });

  it('a journal song and a file with the same artist and title, in any case, are one row', async () => {
    const j = journalSong('bassi maestro', 'S.I.C.');
    m.getUserSongs.mockResolvedValue(new Map([[j.songKey, j]]));
    expect((await ask()).tracks.filter((t) => t.title === 'S.I.C.')).toHaveLength(1);
  });

  it('searches the user\'s own journal (never admin scope)', async () => {
    await ask();
    expect(m.getUserSongs).toHaveBeenCalledWith('mike', false);
  });

  it('a journal-only song is found too, by its tags', async () => {
    const j = { ...journalSong('Kavinsky', 'Nightcall', 'OutRun'), tags: ['#darkdisco'] };
    m.getUserSongs.mockResolvedValue(new Map([[j.songKey, j]]));
    const r = await ask({ q: 'darkdisco' });
    expect(r.tracks.map((t) => t.title)).toEqual(['Nightcall']);
  });
});
