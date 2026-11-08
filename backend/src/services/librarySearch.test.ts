import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getUserSongs: vi.fn(), getLocalFiles: vi.fn(), getMediaSnapshot: vi.fn() }));
vi.mock('./userSongs', () => ({ getUserSongs: m.getUserSongs }));
vi.mock('./musicFolders', () => ({ getLocalFiles: m.getLocalFiles, libraryDisplayRoot: () => '~/Music' }));
vi.mock('./musicSnapshot', () => ({ getMediaSnapshot: m.getMediaSnapshot }));

import { searchLibrary } from './librarySearch';
import { normalizeSearch } from '../utils/searchText';

const local = (relPath: string, over: Record<string, unknown> = {}) => {
  const artist = (over.artist as string) ?? '';
  const title = (over.title as string) ?? relPath;
  const album = (over.album as string | null) ?? null;
  return { relPath, artist, title, album, bytes: 5_000_000, folderId: 'library', folderLabel: 'Libreria (cartella di Spooty)', builtIn: true, searchText: normalizeSearch(`${artist} ${title} ${album ?? ''} ${relPath}`), ...over };
};
const media = (relPath: string, artist: string, title: string, album: string | null = null) => ({
  relPath, artist, title, album, bytes: 6_000_000, normKey: `${artist.toLowerCase()}|${title.toLowerCase()}`, searchText: normalizeSearch(`${artist} ${title} ${album ?? ''} ${relPath}`),
});
const song = (artist: string, title: string, over: Record<string, unknown> = {}) => ({ songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`, artist, title, album: null, tags: [], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  m.getUserSongs.mockResolvedValue(new Map([['kavinsky::nightcall', song('Kavinsky', 'Nightcall')]]));
  m.getLocalFiles.mockReturnValue([
    local('Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3', { artist: 'Bassi Maestro', title: 'Foto di gruppo', album: 'Bassi Maestro' }),
    local('Bassi Maestro/Bassi Maestro, Fabri Fibra - Non muovono il collo.mp3', { artist: 'Bassi Maestro, Fabri Fibra', title: 'Non muovono il collo', album: 'Bassi Maestro' }),
    local('Altro/Maestro Splinter - Intro.mp3', { artist: 'Maestro Splinter', title: 'Intro', album: 'Altro' }),
    local('Old Band - Old Song.mp3', { artist: 'Old Band', title: 'Old Song', folderId: 'e1', folderLabel: 'Vecchi MP3', builtIn: false }),
  ]);
  m.getMediaSnapshot.mockResolvedValue({
    files: [
      media('Music/Bassi Maestro/Cuore Nero/01 - Cuore Nero.mp3', 'Bassi Maestro', 'Cuore Nero', 'Cuore Nero'),
      media('Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3', 'Kavinsky', 'Nightcall', 'Nightcall'),
    ],
    byNormKey: new Map(),
  });
});

describe('searchLibrary (Michele: «Maestro Bassi», the folder is «Bassi Maestro»)', () => {
  it('finds a folder whatever the order of the words, with accents and case ignored', async () => {
    for (const q of ['Maestro Bassi', 'bassi maestro', 'MAESTRO  bassi', 'Bássi, Maestro!']) {
      const res = await searchLibrary({ q, userId: 'mike' });
      expect(res.counts.local, q).toBe(2); // Maestro Splinter has "maestro" but not "bassi"
      expect(res.counts.media, q).toBe(1);
    }
  });

  it('every word must be there (AND), and it searches the album and the path too, not only the title', async () => {
    expect((await searchLibrary({ q: 'maestro splinter', userId: 'mike' })).counts.local).toBe(1);
    expect((await searchLibrary({ q: 'maestro gruppo', userId: 'mike' })).counts.local).toBe(1);
    expect((await searchLibrary({ q: 'cuore nero music', userId: 'mike' })).counts.media).toBe(1); // "Music/" is in the path
    expect((await searchLibrary({ q: 'maestro zzzz', userId: 'mike' })).counts).toEqual({ songs: 0, media: 0, local: 0 });
  });

  it('says where each file is: the box\'s URL or the disk path with its display root', async () => {
    const res = await searchLibrary({ q: 'bassi maestro', userId: 'mike' });
    const media = res.results.find((r) => r.scope === 'media');
    expect(media).toMatchObject({
      artist: 'Bassi Maestro', title: 'Cuore Nero', folder: 'Media server', bytes: 6_000_000,
      location: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Bassi%20Maestro/Cuore%20Nero/01%20-%20Cuore%20Nero.mp3',
    });
    const disk = res.results.filter((r) => r.scope === 'local');
    expect(disk[0]).toMatchObject({ folder: 'Libreria (cartella di Spooty)', location: '~/Music/Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3' });
    const extra = (await searchLibrary({ q: 'old band', userId: 'mike' })).results[0];
    expect(extra).toMatchObject({ scope: 'local', folder: 'Vecchi MP3', location: 'Vecchi MP3/Old Band - Old Song.mp3' }); // an extra folder shows under its label
  });

  it('marks what is already in the journal and keeps the journal scope without a file location', async () => {
    const res = await searchLibrary({ q: 'kavinsky nightcall', userId: 'mike' });
    expect(res.results.find((r) => r.scope === 'songs')).toMatchObject({ inJournal: true, location: null, songKey: 'kavinsky::nightcall' });
    expect(res.results.find((r) => r.scope === 'media')).toMatchObject({ inJournal: true, songKey: 'kavinsky::nightcall' });
    expect((await searchLibrary({ q: 'bassi maestro', userId: 'mike' })).results.every((r) => r.scope === 'songs' || !r.inJournal)).toBe(true);
  });

  it('one scope at a time, and the other scopes are not even read', async () => {
    const only = await searchLibrary({ q: 'bassi', scope: 'media', userId: 'mike' });
    expect(only.results.map((r) => r.scope)).toEqual(['media']);
    expect(only.counts).toEqual({ songs: 0, media: 1, local: 0 });
    expect(m.getLocalFiles).not.toHaveBeenCalled();
    await searchLibrary({ q: 'bassi', scope: 'local', userId: 'mike' });
    expect(m.getMediaSnapshot).toHaveBeenCalledTimes(1);
  });

  it('counts the matches beyond the limit and ranks artist/title hits above path-only hits', async () => {
    m.getLocalFiles.mockReturnValue([
      ...Array.from({ length: 5 }, (_, i) => local(`Bassi Maestro/Raccolta/0${i} - Brano ${i}.mp3`, { artist: 'Altri', title: `Brano ${i}`, album: 'Raccolta' })),
      local('Zeta/Bassi Maestro - Ultimo.mp3', { artist: 'Bassi Maestro', title: 'Ultimo', album: 'Zeta' }),
    ]);
    const res = await searchLibrary({ q: 'bassi maestro', scope: 'local', limit: 3, userId: 'mike' });
    expect(res.counts.local).toBe(6);
    expect(res.results).toHaveLength(3);
    expect(res.results[0]).toMatchObject({ artist: 'Bassi Maestro', title: 'Ultimo' }); // the artist match first, though it sorts last by name
  });

  it('never returns more than 100 per scope, whatever is asked', async () => {
    m.getLocalFiles.mockReturnValue(Array.from({ length: 150 }, (_, i) => local(`Bassi Maestro - ${i}.mp3`, { artist: 'Bassi Maestro', title: String(i) })));
    const res = await searchLibrary({ q: 'bassi', scope: 'local', limit: 9999, userId: 'mike' });
    expect(res.results).toHaveLength(100);
    expect(res.counts.local).toBe(150);
  });

  it('an empty query finds nothing instead of everything', async () => {
    expect((await searchLibrary({ q: ' !! ', userId: 'mike' })).counts).toEqual({ songs: 0, media: 0, local: 0 });
  });
});
