import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getUserSongs: vi.fn(), libraryEntries: vi.fn(), buildTracks: vi.fn() }));
vi.mock('./userSongs', () => ({ getUserSongs: m.getUserSongs }));
vi.mock('./libraryOnlySongs', async (orig) => ({ ...(await orig<typeof import('./libraryOnlySongs')>()), libraryEntries: m.libraryEntries }));
vi.mock('./offlineManifest', () => ({ buildTracks: m.buildTracks }));
vi.mock('../utils/db', () => ({ query: vi.fn() }));

import { creditsOf, parseSearchQuery, searchEverything, songsOnlyAsFiles, titleKeyOf } from './mondropSearch';
import type { LibraryEntry } from './libraryOnlySongs';
import type { AggregatedSong } from '../types';

const journalSong = (artist: string, title: string, album: string | null = null, fs = false): AggregatedSong => ({
  songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`, title, artist, album, youtubeUrl: null, spotifyUrl: null,
  mentions: [{ entryId: 'e1', createdAt: '2026-11-01T00:00:00Z' }], meta: null, inLibrary: fs, fs,
});

/**
 * A song found as a file. `where`: only on the box, only on geekom's disk, or both. `album` is the album shown; `mediaAlbum` the
 * album TAG of the box's file (null: the box has no tag, as for the copies made from a file name).
 */
const entry = (
  artist: string,
  title: string,
  album: string | null,
  where: 'local' | 'media' | 'both' = 'media',
  mediaAlbum: string | null | undefined = album,
): LibraryEntry => ({
  songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`, artist, title, album,
  local: where === 'media' ? null : ({ relPath: `${album ?? 'x'}/${artist} - ${title}.mp3`, album } as never),
  media: where === 'local' ? null : ({ relPath: `Music/${artist}/${album ?? 'x'}/${title}.mp3`, album: mediaAlbum ?? null } as never),
});

// What the box and geekom really hold of Bassi Maestro (8 November): the originals are tagged, the copies made from file names
// are not, the Mac import says «feat.», and the same song is there two or three times.
const GIORNI_MATTI = [
  entry('Bassi Maestro', 'Giorni matti', 'Classe 73'),
  entry('Bassi Maestro feat. Ape & Zampa', 'Giorni matti', 'Classe 73'),
  entry('Bassi Maestro, Ape, Zampa', 'Giorni matti', 'Bassi Maestro', 'both', null),
];
const SIC = [entry('Bassi Maestro', 'S.I.C', 'Background'), entry('Bassi Maestro', 'S.I.C.', 'Bassi Maestro', 'both', null)];
const SAIC = [
  entry('Bassi Maestro', 'S.A.I.C.', 'Street Collection vol.1'),
  entry('Bassi Maestro feat.Fabri Fibra', 'S.A.I.C.', 'Street Collection vol.1'),
  entry('Bassi Maestro, Fabri Fibra', 'S.A.I.C. - 2019 Remastered', 'Bassi Maestro', 'both', null),
];
const KINGS = [
  entry('El Raton', 'King’s Supreme', 'Machete Mixtape Gold Edition'),
  entry('Hell Raton, Ensi, Salmo, En-gma, Bassi Maestro, Rocco Hunt, Gemitaiz', "King's Supreme", 'Bassi Maestro', 'both', null),
  entry('Hell Raton, Ensi, Salmo, En?gma, Bassi Maestro, Rocco Hunt, Gemitaiz', "King's Supreme", null, 'media', null),
];
const NON_MUOVONO = [
  entry('Bassi Maestro', 'Non muovono il collo', 'Mia maestà'),
  entry('Bassi Maestro feat. Fabri Fibra', 'Non muovono il collo', 'Mia maestà (Deluxe)'),
  entry('Bassi Maestro, Fabri Fibra', 'Non muovono il collo', 'Bassi Maestro', 'both', null),
];
const CAPIRAI = entry("Bassi Maestro", 'Capirai', "L'ultimo testimone", 'both');
const FOTO = entry('Bassi Maestro', 'Foto di gruppo', 'Bassi Maestro', 'both');
const DAFT = entry('Daft Punk', 'One More Time', 'Discovery');
const BASSI = [...GIORNI_MATTI, ...SIC, ...SAIC, ...KINGS, ...NON_MUOVONO, CAPIRAI, FOTO, DAFT];

const setLibrary = (all: LibraryEntry[]) => m.libraryEntries.mockResolvedValue({ all, byKey: new Map(all.map((e) => [e.songKey, e])) });
const ask = (over: Record<string, unknown> = {}) =>
  searchEverything({ q: 'bassi maestro', artist: null, album: null, limit: 30, offset: 0, sections: true, userId: 'mike', ...over } as never);
const keys = (r: { tracks: Array<{ songKey: string }> }) => r.tracks.map((t) => t.songKey);

beforeEach(() => {
  vi.clearAllMocks();
  m.getUserSongs.mockResolvedValue(new Map()); // the journal knows no Bassi Maestro: the case Michele met on 8 November
  setLibrary(BASSI);
  m.buildTracks.mockImplementation(async (songs: AggregatedSong[]) =>
    songs.map((s) => ({ songKey: s.songKey, title: s.title, artist: s.artist, album: s.album, libraryOnly: s.libraryOnly ?? false })));
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
  it('splits a credit into the artists on commas, semicolons, feat./ft./featuring, « x » and « vs »', () => {
    expect(creditsOf('Bassi Maestro, Fabri Fibra')).toEqual(['Bassi Maestro', 'Fabri Fibra']);
    expect(creditsOf('Bassi Maestro feat.Fabri Fibra')).toEqual(['Bassi Maestro', 'Fabri Fibra']);
    expect(creditsOf('Bassi Maestro Feat Fabri Fibra; Ape ft. Zampa')).toEqual(['Bassi Maestro', 'Fabri Fibra', 'Ape', 'Zampa']);
    expect(creditsOf('Bad Bunny x Jhay Cortez')).toEqual(['Bad Bunny', 'Jhay Cortez']);
    expect(creditsOf('Daft Punk vs. Someone featuring Other')).toEqual(['Daft Punk', 'Someone', 'Other']);
    expect(creditsOf('')).toEqual([]);
  });

  it('keeps one name whole: «&», «and», a word that starts with feat, an «X» in a name', () => {
    expect(creditsOf('Simon & Garfunkel')).toEqual(['Simon & Garfunkel']);
    expect(creditsOf('Hell Raton, Ensi & Salmo feat. Gemitaiz')).toEqual(['Hell Raton', 'Ensi & Salmo', 'Gemitaiz']);
    expect(creditsOf('Sidewalks and Skeletons')).toEqual(['Sidewalks and Skeletons']);
    expect(creditsOf('Feather')).toEqual(['Feather']);
    expect(creditsOf('X Japan')).toEqual(['X Japan']);
    expect(creditsOf('Malcolm X')).toEqual(['Malcolm X']);
    expect(creditsOf('AC/DC')).toEqual(['AC/DC']);
  });
});

describe('titleKeyOf: what two entries of one recording have in common', () => {
  it('ignores case, accents, punctuation, spaces and typographic apostrophes', () => {
    expect(titleKeyOf('S.I.C')).toBe(titleKeyOf('S.I.C.'));
    expect(titleKeyOf("King's Supreme")).toBe(titleKeyOf('King’s Supreme'));
    expect(titleKeyOf('Fuori dal coro')).toBe(titleKeyOf('Fuori Dal Coro'));
    expect(titleKeyOf('Mia maestà')).toBe(titleKeyOf('MIA MAESTA'));
  });

  it('ignores a «(feat. X)» written into the title: it is a credit, not a version', () => {
    expect(titleKeyOf('Nightcall (feat. Lovefoxxx)')).toBe(titleKeyOf('Nightcall'));
    expect(titleKeyOf('Nightcall [ft. Lovefoxxx]')).toBe(titleKeyOf('Nightcall'));
    expect(titleKeyOf('Song (With You)')).not.toBe(titleKeyOf('Song')); // «With You» is part of that title
  });

  it('keeps a version label: a version is another song', () => {
    expect(titleKeyOf('S.A.I.C. - 2019 Remastered')).not.toBe(titleKeyOf('S.A.I.C.'));
    expect(titleKeyOf('Feel Good Inc. (Instrumental)')).not.toBe(titleKeyOf('Feel Good Inc.'));
    expect(titleKeyOf('...')).toBe(''); // no letters or digits: never «the same» as anything
  });
});

describe('searchEverything: Bassi Maestro, who is on the NAS and on geekom but not in the journal', () => {
  it('finds his songs once each, library-only, with no field that names a store', async () => {
    const r = await ask();
    // Giorni matti ×3 → 1, S.I.C/S.I.C. → 1, S.A.I.C. ×2 → 1 (+ its remastered version), King's Supreme (Hell Raton's credit) ×2 → 1,
    // Non muovono il collo ×3 → 1, Capirai, Foto di gruppo. (El Raton's own King's Supreme does not name Bassi Maestro: not found.)
    expect(r.total).toBe(8);
    expect(r.tracks.map((t) => t.title).sort()).toEqual(
      ['Capirai', 'Foto di gruppo', 'Giorni matti', 'Non muovono il collo', 'S.A.I.C.', 'S.A.I.C. - 2019 Remastered', 'S.I.C.', "King's Supreme"].sort());
    expect(m.buildTracks.mock.calls[0][0].every((s: AggregatedSong) => s.libraryOnly === true && s.mentions.length === 0)).toBe(true);
    for (const t of r.tracks) expect(Object.keys(t)).not.toEqual(expect.arrayContaining(['where']));
  });

  it('three spellings of one recording are ONE row: the one with a file on geekom, under the album of the real tag', async () => {
    const r = await ask({ q: 'giorni matti' });
    expect(r.total).toBe(1);
    expect(r.tracks[0]).toMatchObject({ songKey: 'bassi maestro, ape, zampa::giorni matti', artist: 'Bassi Maestro, Ape, Zampa', album: 'Classe 73' });
  });

  it('«S.I.C» and «S.I.C.» are one song; the album is the tag («Background»), not the geekom folder («Bassi Maestro»)', async () => {
    const r = await ask({ q: 'maestro s i c' });
    expect(r.tracks.filter((t) => t.title.startsWith('S.I.C'))).toHaveLength(1);
    expect(r.tracks.find((t) => t.title === 'S.I.C.')).toMatchObject({ songKey: 'bassi maestro::s.i.c.', album: 'Background' });
  });

  it('a version stays its own song: «S.A.I.C. - 2019 Remastered» is not hidden behind «S.A.I.C.»', async () => {
    const titles = (await ask({ q: 'fabri fibra' })).tracks.map((t) => t.title).sort();
    expect(titles).toEqual(['Non muovono il collo', 'S.A.I.C.', 'S.A.I.C. - 2019 Remastered']);
    expect((await ask({ q: 'remastered' })).tracks.map((t) => t.title)).toEqual(['S.A.I.C. - 2019 Remastered']);
  });

  it('when the copies are all on the box, the fullest credit is the one shown', async () => {
    const r = await ask({ q: 'fabri fibra' });
    expect(r.tracks.find((t) => t.title === 'S.A.I.C.')).toMatchObject({ songKey: 'bassi maestro feat.fabri fibra::s.a.i.c.' });
  });

  it('two songs with the same title and NO artist in common are two rows', async () => {
    setLibrary([entry('Nine Inch Nails', 'Hurt', 'The Downward Spiral'), entry('Johnny Cash', 'Hurt', 'American IV'), entry('Johnny Cash, June Carter', 'Hurt', 'Live', 'media')]);
    const r = await ask({ q: 'hurt' });
    expect(r.total).toBe(2); // Cash's two files are one song, Nine Inch Nails' is another
    expect(r.tracks.map((t) => t.artist).sort()).toEqual(['Johnny Cash, June Carter', 'Nine Inch Nails']);
  });

  it('a credit that names nobody never joins two songs («Various Artists», «Unknown»)', async () => {
    setLibrary([entry('Various Artists', 'Intro', 'Compilation A'), entry('Various Artists, Someone', 'Intro', 'Compilation B'), entry('Unknown', 'Intro', 'Demo')]);
    // the first two share only «Various Artists», which names nobody; the third is «Unknown»: nothing links any of them
    expect((await ask({ q: 'intro' })).total).toBe(3);
    // the same two with a real artist in common ARE one song
    setLibrary([entry('Bassi Maestro, Various Artists', 'Intro', 'A'), entry('Bassi Maestro', 'Intro', 'B')]);
    expect((await ask({ q: 'intro' })).total).toBe(1);
  });

  it('a title with no letters or digits is never «the same» as another', async () => {
    setLibrary([entry('Bassi Maestro', '...', 'A'), entry('Bassi Maestro, Ape', '…', 'B')]);
    expect((await ask({ q: 'bassi' })).total).toBe(2);
  });

  it('word order and accents do not matter: «Maestro Bassi» finds him, «mia maesta» finds the album', async () => {
    expect((await ask({ q: 'maestro bassi' })).total).toBe(8);
    const r = await ask({ q: 'mia maesta' });
    expect(r.tracks.map((t) => t.title)).toEqual(['Non muovono il collo']);
    expect(r.albums).toEqual([{ title: 'Mia maestà (Deluxe)', artist: 'Bassi Maestro', tracks: 1 }]); // the fullest credit's tag
  });

  it('the folders of a file are searched, the roots every file shares are not: «classe 73» finds the song, «music» and «soundreel» find nothing', async () => {
    setLibrary([{ ...entry('Bassi Maestro', 'Giorni matti', null, 'media'), media: { relPath: 'Music/SoundReel/_MacMusic/Bassi Maestro/Classe 73/06 - Giorni matti.mp3', album: null } as never }]);
    expect((await ask({ q: 'classe 73' })).total).toBe(1);
    expect((await ask({ q: 'music' })).total).toBe(0);
    expect((await ask({ q: 'soundreel' })).total).toBe(0);
    expect((await ask({ q: 'mp3' })).total).toBe(0);
  });
});

describe('searchEverything: one entry per group, the same one whatever was typed', () => {
  it('the same group is shown with the same song key found by the artist, the album, the title or a credit', async () => {
    const found = async (over: Record<string, unknown>) => (await ask(over)).tracks.find((t) => t.title === 'Giorni matti')?.songKey;
    const expected = 'bassi maestro, ape, zampa::giorni matti';
    expect(await found({ q: 'giorni matti' })).toBe(expected);
    expect(await found({ q: 'ape zampa' })).toBe(expected);
    expect(await found({ q: 'bassi maestro' })).toBe(expected);
    expect(await found({ q: '', artist: 'Bassi Maestro' })).toBe(expected);
    expect(await found({ q: '', artist: 'Ape & Zampa' })).toBe(expected); // a name credited on ANY file of the song is the song's
  });

  it('an album page shows the member that is ON that album: its file, its key', async () => {
    const r = await ask({ q: '', album: 'Mia maestà (Deluxe)' });
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0]).toMatchObject({ songKey: 'bassi maestro feat. fabri fibra::non muovono il collo', album: 'Mia maestà (Deluxe)' });
    expect(r.albums).toEqual([]);
  });

  it('a song found by the album of ANY of its files shows under that album, once', async () => {
    const r = await ask({ q: '', album: 'Classe 73' });
    expect(r.total).toBe(1);
    expect(r.tracks[0]).toMatchObject({ title: 'Giorni matti', album: 'Classe 73' });
  });

  it('artist= is every name credited on ANY file of the song, and no artists section', async () => {
    const r = await ask({ q: '', artist: 'Fabri Fibra' });
    expect(r.tracks.map((t) => t.title).sort()).toEqual(['Non muovono il collo', 'S.A.I.C.', 'S.A.I.C. - 2019 Remastered']);
    expect(r.artists).toEqual([]);
    // the geekom copy of «Non muovono il collo» credits him too, but even if the one shown did not, the song is his
    setLibrary([entry('Bassi Maestro', 'Solo', 'X', 'both'), entry('Bassi Maestro feat. Fabri Fibra', 'Solo', 'X', 'media')]);
    const r2 = await ask({ q: '', artist: 'Fabri Fibra' });
    expect(r2.tracks.map((t) => t.songKey)).toEqual(['bassi maestro::solo']); // shown: the one on geekom's disk
  });

  it('pages over songs, not over files', async () => {
    const first = await ask({ limit: 3 });
    const second = await ask({ limit: 3, offset: 3 });
    const third = await ask({ limit: 3, offset: 6 });
    expect([first.tracks.length, second.tracks.length, third.tracks.length]).toEqual([3, 3, 2]);
    expect(new Set([...keys(first), ...keys(second), ...keys(third)]).size).toBe(8);
    expect(second.offset).toBe(3);
  });

  it('King\'s Supreme: «King\'s» and «King’s», «En-gma» and «En?gma» do not split a song; a credit nobody shares does', async () => {
    const r = await ask({ q: 'supreme' });
    expect(r.total).toBe(2); // El Raton's file (no artist in common) and the two spellings of Hell Raton's, which are one
    expect(r.tracks.map((t) => t.artist).sort()).toEqual(['El Raton', 'Hell Raton, Ensi, Salmo, En-gma, Bassi Maestro, Rocco Hunt, Gemitaiz']);
  });
});

describe('searchEverything: the sections count songs, not files', () => {
  it('lists him as an artist once, with the number of SONGS where he is credited', async () => {
    const r = await ask();
    expect(r.artists).toEqual([{ name: 'Bassi Maestro', tracks: 8 }]); // once, with the number of SONGS (not the 18 files); not Fabri Fibra, not Gemitaiz: they do not match what was typed
  });

  it('counts the albums among ALL the songs found, one album per song, tags before geekom folders, biggest first', async () => {
    const r = await ask({ limit: 1 });
    expect(r.tracks).toHaveLength(1);
    expect(r.total).toBe(8);
    // «Bassi Maestro» is a folder of geekom's library and, for «Foto di gruppo», a real tag: it is the album of the 3 songs that have
    // nothing better (Foto di gruppo, the remastered S.A.I.C., King's Supreme), NOT of Giorni matti, Capirai... which have real tags
    expect(r.albums[0]).toEqual({ title: 'Bassi Maestro', artist: 'Bassi Maestro', tracks: 3 });
    expect(r.albums.find((a) => a.title === 'Classe 73')).toEqual({ title: 'Classe 73', artist: 'Bassi Maestro', tracks: 1 });
    expect(r.albums.length).toBe(6);
  });

  it('artist= gives the albums of ONE artist (up to 60), without the artists section', async () => {
    const r = await ask({ q: '', artist: 'Bassi Maestro' });
    expect(r.total).toBe(8);
    expect(r.artists).toEqual([]);
    expect(r.albums.map((a) => a.title)).toEqual(expect.arrayContaining(['Classe 73', 'Mia maestà (Deluxe)', 'Background', 'Street Collection vol.1', "L'ultimo testimone"]));
  });

  it('album= gives the songs of one album and no albums section', async () => {
    const r = await ask({ q: '', album: 'Background' });
    expect(r.tracks.map((t) => t.title)).toEqual(['S.I.C']); // the file that IS on that album, as tagged
    expect(r.albums).toEqual([]);
  });

  it('sections=0 sends only the tracks', async () => {
    const r = await ask({ sections: false });
    expect(r.artists).toEqual([]);
    expect(r.albums).toEqual([]);
    expect(r.tracks.length).toBe(8);
  });

  it('a song with the words only in its album comes after the ones with the words in the artist or the title', async () => {
    setLibrary([entry('Qualcuno', 'Brano', 'Bassi Maestro Live'), entry('Bassi Maestro', 'Zeta', 'Altro')]);
    const r = await ask();
    expect(r.tracks.map((t) => t.title)).toEqual(['Zeta', 'Brano']);
  });

  it('finds nothing without failing, also when the catalogue is empty (the box was out)', async () => {
    setLibrary([]);
    expect(await ask()).toMatchObject({ tracks: [], artists: [], albums: [], total: 0 });
    expect(m.buildTracks).toHaveBeenCalledWith([], 'mike');
  });
});

describe('searchEverything: the journal and the files are ONE list', () => {
  it('a song in the journal and as a file with the SAME key is a single row, and the journal object (it knows more) is the one used', async () => {
    const j = journalSong('Bassi Maestro', 'Foto di gruppo', 'Foto di gruppo');
    m.getUserSongs.mockResolvedValue(new Map([[j.songKey, j]]));
    const r = await ask();
    const rows = r.tracks.filter((t) => t.title === 'Foto di gruppo');
    expect(rows).toHaveLength(1);
    expect(rows[0].libraryOnly).toBe(false);
    expect(r.total).toBe(8); // not 9
  });

  it('a journal song and a file that spell the credit differently are ONE row too, and it is the journal\'s', async () => {
    const j = journalSong('Bassi Maestro', 'Giorni matti', 'Classe 73');
    m.getUserSongs.mockResolvedValue(new Map([[j.songKey, j]]));
    const r = await ask({ q: 'giorni matti' });
    expect(r.total).toBe(1);
    expect(r.tracks[0]).toMatchObject({ songKey: 'bassi maestro::giorni matti', libraryOnly: false });
  });

  it('a journal song wins over a file even when the file is on geekom\'s disk', async () => {
    setLibrary([entry('Kavinsky feat. Lovefoxxx', 'Nightcall', 'OutRun', 'both')]);
    const j = journalSong('Kavinsky', 'Nightcall', 'OutRun');
    m.getUserSongs.mockResolvedValue(new Map([[j.songKey, j]]));
    const r = await ask({ q: 'nightcall' });
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0]).toMatchObject({ songKey: 'kavinsky::nightcall', libraryOnly: false });
  });

  it('a version is its own song: «S.I.C. (2019 Remastered)» is not hidden behind «S.I.C.»', async () => {
    setLibrary([...BASSI, entry('Bassi Maestro', 'S.I.C. (2019 Remastered)', 'Background')]);
    const titles = (await ask()).tracks.map((t) => t.title);
    expect(titles).toContain('S.I.C.');
    expect(titles).toContain('S.I.C. (2019 Remastered)');
  });

  it('a journal song and a file with the same artist and title, in any case, are one row', async () => {
    const j = journalSong('bassi maestro', 'S.I.C.');
    m.getUserSongs.mockResolvedValue(new Map([[j.songKey, j]]));
    expect((await ask()).tracks.filter((t) => t.title.startsWith('S.I.C'))).toHaveLength(1);
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

  it('a journal song whose album is its own keeps it, and is not renamed by a folder of geekom', async () => {
    setLibrary([entry('Kavinsky', 'Nightcall', 'Kavinsky', 'both', null)]);
    const j = journalSong('Kavinsky', 'Nightcall', 'OutRun');
    m.getUserSongs.mockResolvedValue(new Map([[j.songKey, j]]));
    expect((await ask({ q: 'nightcall' })).tracks[0]).toMatchObject({ album: 'OutRun' });
  });
});

describe('songsOnlyAsFiles: what the web adds to the journal so that its search takes from EVERYTHING', () => {
  const titles = (songs: AggregatedSong[]) => songs.map((x) => x.title);

  it('lists every song that is only a file, ONE per song as «Cerca» groups them (not one per file)', async () => {
    const songs = await songsOnlyAsFiles([]);
    // 17 files are 10 songs: the same recording found two or three times is ONE (El Raton's «King's Supreme» shares no credited
    // artist with the posse cut of the same name, so those two stay apart)
    expect(songs).toHaveLength(10);
    expect(titles(songs).filter((t) => t === 'Giorni matti')).toHaveLength(1);
    expect(titles(songs).filter((t) => /^S\.I\.C\.?$/.test(t))).toHaveLength(1);
    // a version has another title and stays its own song
    expect(titles(songs)).toEqual(expect.arrayContaining(['S.A.I.C.', 'S.A.I.C. - 2019 Remastered']));
  });

  it('flags them as files without a post: libraryOnly, no mentions, no metadata, and where the file is', async () => {
    const [capirai] = (await songsOnlyAsFiles([])).filter((x) => x.title === 'Capirai');
    expect(capirai).toMatchObject({ libraryOnly: true, mentions: [], meta: null, inLibrary: true, fs: true, mediaServer: true, artist: 'Bassi Maestro' });
  });

  it('carries EMPTY facets (sources, platforms, tags), not absent ones: a client that finds none would derive them from the whole journal', async () => {
    for (const song of await songsOnlyAsFiles([])) expect(song).toMatchObject({ sources: [], platforms: [], tags: [] });
  });

  it('is sorted by artist and title, so the list reads the same at every request', async () => {
    const songs = await songsOnlyAsFiles([]);
    const order = songs.map((x) => `${x.artist} ${x.title}`.toLowerCase());
    expect(order).toEqual([...order].sort((a, b) => a.localeCompare(b)));
    expect(songs[0].artist).toBe('Bassi Maestro');
  });

  it('shows the album of the box\'s TAG, not the folder of the copy that happens to be shown (the folder is a Spooty playlist name)', async () => {
    const giorni = (await songsOnlyAsFiles([])).find((x) => x.title === 'Giorni matti');
    expect(giorni?.album).toBe('Classe 73');
  });

  it('never repeats a song the list already has: by key, and as the same recording under another spelling', async () => {
    const journal = [
      journalSong('Bassi Maestro', 'Capirai'), // the same KEY as a file
      journalSong('Bassi Maestro', 'S.I.C.'), // one of the two spellings of a group of files
      journalSong('Bassi Maestro', 'Giorni matti'), // the journal's song stands for the whole group of three files
    ];
    const songs = await songsOnlyAsFiles(journal);
    expect(songs).toHaveLength(7);
    expect(titles(songs)).not.toContain('Capirai');
    expect(titles(songs)).not.toContain('Giorni matti');
    expect(titles(songs).filter((t) => /^S\.I\.C\.?$/.test(t))).toHaveLength(0);
    expect(titles(songs)).toContain('Foto di gruppo');
  });

  it('is empty when there are no files (the box is detached and geekom has nothing)', async () => {
    setLibrary([]);
    expect(await songsOnlyAsFiles([journalSong('Queen', 'Bohemian Rhapsody')])).toEqual([]);
  });

  it('asks nothing of the journal itself: it works on the list it is given (the one the web returns)', async () => {
    await songsOnlyAsFiles([journalSong('Bassi Maestro', 'Capirai')]);
    expect(m.getUserSongs).not.toHaveBeenCalled();
  });
});
