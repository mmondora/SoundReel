import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ pool: { query: vi.fn(), end: vi.fn() }, query: vi.fn(), listEntries: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { HEADER, buildCsv, csvField, csvLine, type Deps } from './exportSongsCsv';

const deps = (over: Partial<Deps> = {}): Deps => ({
  songs: async () => [],
  bound: async () => new Map(),
  match: async () => null,
  ...over,
});

describe('csvField', () => {
  it.each([
    ['plain', 'plain'],
    ['', ''],
    ['AC/DC', 'AC/DC'],
    ['Hello, World', '"Hello, World"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['a;b', 'a;b'],
  ])('%j → %j', (value, expected) => {
    expect(csvField(value)).toBe(expected);
  });

  it('null and undefined are empty', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
});

describe('buildCsv', () => {
  it('has the columns the Mac import asked for, in order', () => {
    expect([...HEADER]).toEqual(['song_id', 'artist', 'title', 'album', 'media_rel_path', 'norm_key']);
    expect(csvLine([...HEADER])).toBe('song_id,artist,title,album,media_rel_path,norm_key');
  });

  it('one line per song with the key SoundReel matches the media index with', async () => {
    const { csv, songs, withFile } = await buildCsv(deps({
      songs: async () => [{ songKey: 'bishop briggs::white flag', artist: 'Bishop Briggs', title: 'White Flag (Live)', album: 'Church of Scars' }],
    }));
    expect(csv).toBe(
      'song_id,artist,title,album,media_rel_path,norm_key\n' +
      'bishop briggs::white flag,Bishop Briggs,White Flag (Live),Church of Scars,,bishop briggs|white flag\n',
    );
    expect(songs).toBe(1);
    expect(withFile).toBe(0);
  });

  it('prefers the file the song is bound to, else the one SoundReel would reuse by name', async () => {
    const { csv, withFile } = await buildCsv(deps({
      songs: async () => [
        { songKey: 'a::bound', artist: 'A', title: 'Bound', album: null },
        { songKey: 'a::named', artist: 'A', title: 'Named', album: null },
        { songKey: 'a::none', artist: 'A', title: 'None', album: null },
      ],
      bound: async () => new Map([['a::bound', 'Music/SoundReel/A - Bound.mp3']]),
      match: async (_artist, title) => (title === 'Named' ? 'Music/Other/A - Named.mp3' : null),
    }));
    const rows = csv.trim().split('\n').slice(1).map((l) => l.split(','));
    expect(rows.map((r) => r[4])).toEqual(['Music/SoundReel/A - Bound.mp3', 'Music/Other/A - Named.mp3', '']);
    expect(withFile).toBe(2);
  });

  it('does not ask the index for a song that is already bound', async () => {
    const match = vi.fn(async () => 'x.mp3');
    await buildCsv(deps({
      songs: async () => [{ songKey: 'a::b', artist: 'A', title: 'B', album: null }],
      bound: async () => new Map([['a::b', 'bound.mp3']]),
      match,
    }));
    expect(match).not.toHaveBeenCalled();
  });

  it('quotes commas, quotes and accents survive, and the order is artist then title', async () => {
    const { csv } = await buildCsv(deps({
      songs: async () => [
        { songKey: 'z::last', artist: 'Zed', title: 'Last', album: null },
        { songKey: 'a::two', artist: 'Adèle, ft. X', title: 'Say "You" Won\'t', album: 'Album, the' },
        { songKey: 'a::one', artist: 'Abba', title: 'Chiquitita', album: null },
      ],
    }));
    const lines = csv.trim().split('\n');
    expect(lines[1].startsWith('a::one,Abba,Chiquitita')).toBe(true);
    expect(lines[2]).toBe('a::two,"Adèle, ft. X","Say ""You"" Won\'t","Album, the",,"adèle, ft. x|say ""you"" won\'t"');
    expect(lines[3].startsWith('z::last,Zed,Last')).toBe(true);
  });

  it('holds nothing but names and paths: no URL, no key, no credential', async () => {
    const { csv } = await buildCsv(deps({
      songs: async () => [{ songKey: 'a::b', artist: 'A', title: 'B', album: 'C' }],
      bound: async () => new Map([['a::b', 'Music/SoundReel/A - B.mp3']]),
    }));
    expect(csv).not.toMatch(/https?:\/\//);
    expect(csv.split('\n').slice(1).join('\n')).not.toMatch(/key|token|password|secret/i); // the rows, not the `norm_key` header
  });

  it('is just the header for an empty library', async () => {
    expect((await buildCsv(deps())).csv).toBe('song_id,artist,title,album,media_rel_path,norm_key\n');
  });
});
