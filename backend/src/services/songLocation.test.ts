import { describe, expect, it, vi } from 'vitest';

vi.mock('./songFiles', () => ({ listSongFileLocations: vi.fn() }));
vi.mock('./musicSnapshot', () => ({ getMediaSnapshot: vi.fn() }));
vi.mock('./musicFolders', () => ({ libraryDisplayRoot: () => '~/Music' }));

import { locateSongs } from './songLocation';
import { normKey } from './mediaIndex';
import type { MediaFile, MediaSnapshot } from './musicSnapshot';
import type { SongFileLocationRow } from './songFiles';

const BOX = 'http://192.168.178.10:49200/AUDIO/DLNA-1-0';

const snapshot = (files: Array<[string, string, string, number | null]>): MediaSnapshot => {
  const list: MediaFile[] = files.map(([relPath, artist, title, bytes]) => ({ relPath, artist, title, album: null, bytes, normKey: normKey(artist, title), searchText: '' }));
  const byNormKey = new Map<string, MediaFile[]>();
  for (const f of list) byNormKey.set(f.normKey, [...(byNormKey.get(f.normKey) ?? []), f]);
  return { files: list, byNormKey };
};
const row = (over: Partial<SongFileLocationRow>): SongFileLocationRow => ({ songKey: 'k', status: 'ready', relPath: null, mediaRelPath: null, mediaUrl: null, videoId: null, ...over });
const locate = async (key: string, artist: string, title: string, deps: { rows?: SongFileLocationRow[]; media?: MediaSnapshot; tracks?: Array<{ artist: string; title: string; album: string | null; relPath: string }> }) => {
  const rows = new Map((deps.rows ?? []).map((r) => [r.songKey, r]));
  return (await locateSongs([{ songKey: key, artist, title }], deps.tracks ?? [], { rows, media: deps.media ?? snapshot([]) })).get(key)!;
};

describe('locateSongs (W2/W8: every green dot is explained by a path or a URL)', () => {
  it('on the disk only: a library file with the same artist and title, shown with its display root', async () => {
    const loc = await locate('bassi maestro::foto di gruppo', 'Bassi Maestro', 'Foto di gruppo', {
      tracks: [{ artist: 'Bassi Maestro', title: 'Foto di gruppo', album: 'Bassi Maestro', relPath: 'Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3' }],
    });
    expect(loc).toEqual({ fs: true, mediaServer: false, fsPath: '~/Music/Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3', mediaUrl: null, mediaPath: null, streamUrl: null });
  });

  it('on the box only (the 2.8.0 case: Nightcall): the box\'s own file, adopted, no disk file', async () => {
    const loc = await locate('kavinsky::nightcall', 'Kavinsky', 'Nightcall', {
      rows: [row({ songKey: 'kavinsky::nightcall', mediaRelPath: 'Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3', mediaUrl: `${BOX}/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3` })],
    });
    expect(loc).toMatchObject({ fs: false, mediaServer: true, fsPath: null, mediaPath: 'Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3', mediaUrl: `${BOX}/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3` });
  });

  it('on the box because the catalogue lists it, even when nobody ever asked for a download', async () => {
    const loc = await locate('kavinsky::nightcall', 'Kavinsky', 'Nightcall', {
      media: snapshot([['Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3', 'Kavinsky', 'Nightcall', 6109100]]),
    });
    expect(loc).toMatchObject({ fs: false, mediaServer: true, mediaUrl: `${BOX}/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3` });
  });

  it('catalogue hits follow the reuse rules: a live cut is not "the song", junk never counts', async () => {
    const media = snapshot([
      ['Music/Kavinsky/Live/Nightcall (Live).mp3', 'Kavinsky', 'Nightcall (Live)', 9_000_000],
      ['Music/Kavinsky/._Nightcall.mp3', 'Kavinsky', 'Nightcall', 4096],
    ]);
    // "(Live)" normalises to the same key as the studio cut, so the lookup meets both: neither may be taken for it
    expect((await locate('kavinsky::nightcall', 'Kavinsky', 'Nightcall', { media })).mediaServer).toBe(false);
  });

  it('both places: a disk file recorded for the song and its replica verified on the box', async () => {
    const loc = await locate('a::b', 'A', 'B', {
      rows: [row({ songKey: 'a::b', relPath: 'SoundReel/A - B.mp3', mediaUrl: `${BOX}/Music/SoundReel/SoundReel/A%20-%20B.mp3` })],
    });
    expect(loc).toMatchObject({ fs: true, mediaServer: true, fsPath: '~/Music/SoundReel/A - B.mp3', mediaPath: 'Music/SoundReel/SoundReel/A - B.mp3' });
  });

  it('nowhere: streaming only, no dot — and the video link when the song\'s video is known', async () => {
    expect(await locate('x::y', 'X', 'Y', {})).toEqual({ fs: false, mediaServer: false, fsPath: null, mediaUrl: null, mediaPath: null, streamUrl: null });
    expect((await locate('x::y', 'X', 'Y', { rows: [row({ songKey: 'x::y', status: 'queued', videoId: 'abcdefghijk' })] })).streamUrl).toBe('https://www.youtube.com/watch?v=abcdefghijk');
  });

  it('a row that is not ready never counts as a file (a stale path of a failed job is not a location)', async () => {
    const loc = await locate('a::b', 'A', 'B', { rows: [row({ songKey: 'a::b', status: 'failed', relPath: 'SoundReel/old.mp3', mediaUrl: `${BOX}/x.mp3` })] });
    expect(loc).toMatchObject({ fs: false, mediaServer: false, fsPath: null, mediaUrl: null });
  });

  it('serves a whole list from the same lookups', async () => {
    const rows = new Map<string, SongFileLocationRow>();
    const out = await locateSongs(
      [{ songKey: 'a::1', artist: 'A', title: '1' }, { songKey: 'a::2', artist: 'A', title: '2' }],
      [{ artist: 'A', title: '2', album: null, relPath: 'A - 2.mp3' }],
      { rows, media: snapshot([]) },
    );
    expect([...out.keys()]).toEqual(['a::1', 'a::2']);
    expect(out.get('a::1')!.fs).toBe(false);
    expect(out.get('a::2')!.fs).toBe(true);
  });
});
