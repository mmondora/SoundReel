import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getLocalFiles: vi.fn(), getMediaSnapshot: vi.fn() }));
vi.mock('./musicFolders', () => ({ getLocalFiles: m.getLocalFiles }));
vi.mock('./musicSnapshot', () => ({ getMediaSnapshot: m.getMediaSnapshot }));

import { invalidateLibraryEntries, libraryEntries, libraryFilesOf, libraryOnlySong, songFromEntry } from './libraryOnlySongs';

const local = (artist: string, title: string, album: string | null, builtIn = true) =>
  ({ artist, title, album, relPath: `${album ?? ''}/${artist} - ${title}.mp3`, bytes: 3_000_000, searchText: '', folderId: 'library', folderLabel: 'Libreria', builtIn }) as never;
const media = (artist: string, title: string, album: string | null) =>
  ({ artist, title, album, relPath: `Music/${artist}/${album ?? ''}/${title}.mp3`, bytes: 5_000_000, normKey: '', searchText: '' }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateLibraryEntries();
  m.getLocalFiles.mockReturnValue([]);
  m.getMediaSnapshot.mockResolvedValue({ files: [], byNormKey: new Map() });
});

describe('libraryEntries: every song that is a file of geekom or of the box', () => {
  it('joins the two sources by the song key, geekom first (its spelling wins) and the box\'s album TAG over a geekom folder name', async () => {
    m.getLocalFiles.mockReturnValue([local('Bassi Maestro', 'Foto di gruppo', 'Bassi Maestro')]);
    m.getMediaSnapshot.mockResolvedValue({ files: [media('Bassi Maestro', 'Foto di gruppo', 'Foto di gruppo'), media('Bassi Maestro', 'S.I.C.', 'Background')], byNormKey: new Map() });
    const { all, byKey } = await libraryEntries(0);
    expect(all).toHaveLength(2);
    const foto = byKey.get('bassi maestro::foto di gruppo')!;
    expect(foto.local).not.toBeNull();
    expect(foto.media).not.toBeNull();
    expect(foto.artist).toBe('Bassi Maestro');
    expect(foto.album).toBe('Foto di gruppo'); // the tag of the box's file; «Bassi Maestro» is only the folder of geekom's copy
    expect(byKey.get('bassi maestro::s.i.c.')).toMatchObject({ local: null, album: 'Background' });
  });

  it('the key is the song key: case and spaces do not split a song, a version is another song', async () => {
    m.getLocalFiles.mockReturnValue([local('Bassi  Maestro', 'S.I.C.', null)]);
    m.getMediaSnapshot.mockResolvedValue({ files: [media('bassi maestro', 's.i.c.', 'Background'), media('Bassi Maestro', 'S.I.C. (2019 Remastered)', 'Background')], byNormKey: new Map() });
    const { all } = await libraryEntries(0);
    expect(all.map((e) => e.songKey).sort()).toEqual(['bassi maestro::s.i.c.', 'bassi maestro::s.i.c. (2019 remastered)']);
    expect(all.find((e) => e.songKey === 'bassi maestro::s.i.c.')).toMatchObject({ local: expect.anything(), media: expect.anything(), album: 'Background' });
  });

  it('leaves out an extra folder: it is mounted read-only elsewhere and the server cannot serve it', async () => {
    m.getLocalFiles.mockReturnValue([local('A', 'B', null, false), local('C', 'D', null, true)]);
    const { all } = await libraryEntries(0);
    expect(all.map((e) => e.songKey)).toEqual(['c::d']);
  });

  it('is held for a short while, and forgotten on request', async () => {
    m.getMediaSnapshot.mockResolvedValue({ files: [media('A', 'B', null)], byNormKey: new Map() });
    await libraryEntries();
    await libraryEntries();
    expect(m.getMediaSnapshot).toHaveBeenCalledTimes(1);
    invalidateLibraryEntries();
    await libraryEntries();
    expect(m.getMediaSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('libraryEntries: the album and the file of the box that is kept', () => {
  it('a folder of geekom\'s library is the album only when nothing better exists', async () => {
    m.getLocalFiles.mockReturnValue([local('Edmea', 'Some song', 'ITALIAN SONGS REMIXED BY EDMEA'), local('Edmea', 'Other song', 'ITALIAN SONGS REMIXED BY EDMEA')]);
    m.getMediaSnapshot.mockResolvedValue({ files: [media('Edmea', 'Other song', 'The real album')], byNormKey: new Map() });
    const { byKey } = await libraryEntries(0);
    expect(byKey.get('edmea::some song')!.album).toBe('ITALIAN SONGS REMIXED BY EDMEA'); // no tag anywhere: the folder
    expect(byKey.get('edmea::other song')!.album).toBe('The real album'); // the box's tag wins
  });

  it('of several files of the box for one song, the one with an album tag is kept (a copy made from a file name has none)', async () => {
    const copy = media('Bassi Maestro', 'Capirai', null); // the replica of geekom's file: no tag
    const original = media('Bassi Maestro', 'Capirai', "L'ultimo testimone");
    for (const files of [[copy, original], [original, copy]]) {
      invalidateLibraryEntries();
      m.getMediaSnapshot.mockResolvedValue({ files, byNormKey: new Map() });
      const e = (await libraryEntries(0)).byKey.get('bassi maestro::capirai')!;
      expect(e.media).toBe(original);
      expect(e.album).toBe("L'ultimo testimone");
    }
  });

  it('a song with no album anywhere has none', async () => {
    m.getMediaSnapshot.mockResolvedValue({ files: [media('A', 'B', null)], byNormKey: new Map() });
    expect((await libraryEntries(0)).byKey.get('a::b')!.album).toBeNull();
  });
});

describe('libraryOnlySong: the song behind a key', () => {
  it('is rebuilt from the file, with no post and no metadata, and says it is only a file', async () => {
    m.getLocalFiles.mockReturnValue([local('Bassi Maestro', 'Capirai', 'Bassi Maestro')]);
    const s = await libraryOnlySong('bassi maestro::capirai');
    expect(s).toMatchObject({ songKey: 'bassi maestro::capirai', title: 'Capirai', artist: 'Bassi Maestro', album: 'Bassi Maestro', mentions: [], meta: null, inLibrary: true, fs: true, mediaServer: false, libraryOnly: true });
  });

  it('knows a file that is only on the box', async () => {
    m.getMediaSnapshot.mockResolvedValue({ files: [media('Bassi Maestro', 'Fuori dal coro', 'Mia maestà')], byNormKey: new Map() });
    expect(await libraryOnlySong('bassi maestro::fuori dal coro')).toMatchObject({ fs: false, mediaServer: true, libraryOnly: true });
  });

  it('a key that no file carries is unknown', async () => {
    m.getLocalFiles.mockReturnValue([local('A', 'B', null)]);
    expect(await libraryOnlySong('ghost::song')).toBeUndefined();
    expect(songFromEntry({ songKey: 'x::y', artist: 'x', title: 'y', album: null, local: null, media: null })).toMatchObject({ fs: false, mediaServer: false });
  });
});

describe('libraryFilesOf: the exact files behind a key, for serving', () => {
  it('gives the file of geekom and the file of the box of THAT key, and never a neighbour version\'s', async () => {
    const plain = local('Bassi Maestro', 'S.I.C.', 'Background');
    const remaster = media('Bassi Maestro', 'S.I.C. (2019 Remastered)', 'Background');
    m.getLocalFiles.mockReturnValue([plain]);
    m.getMediaSnapshot.mockResolvedValue({ files: [remaster], byNormKey: new Map() });
    expect(await libraryFilesOf('bassi maestro::s.i.c.')).toEqual({ local: plain, media: null });
    expect(await libraryFilesOf('bassi maestro::s.i.c. (2019 remastered)')).toEqual({ local: null, media: remaster });
  });

  it('is undefined for a key no file carries', async () => {
    expect(await libraryFilesOf('ghost::song')).toBeUndefined();
  });
});
