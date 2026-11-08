import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ getSpotifyConfig: vi.fn(), updateSpotifyConfig: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import type { Song } from '../types';
import {
  applyEntry,
  correctEntry,
  fixSongIdentity,
  parseArgs,
  parseFixes,
  refuses,
  type Deps,
  type EntryRow,
  type KeyUsage,
  type SongFix,
} from './fixSongIdentity';

const NOW = new Date('2026-11-08T12:00:00.000Z');

const song = (title: string, artist: string, over: Partial<Song> = {}): Song => ({
  title, artist, album: null, source: 'ai_analysis', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false, ...over,
});
const entry = (id: string, songs: Song[], over: Partial<EntryRow> = {}): EntryRow => ({
  id,
  results: { songs, films: [], notes: [], links: [], tags: [], summary: 'riassunto' },
  action_log: [{ action: 'start', details: {}, timestamp: '2026-08-01T10:00:00Z' }],
  ...over,
});

const MEZZANINE: SongFix = { from: { artist: '@massiveattackofficial', title: 'Mezzanine' }, to: { artist: 'Massive Attack', title: 'Mezzanine', album: 'Mezzanine' } };
const SURRENDER_A: SongFix = {
  from: { artist: '@cursesforever - Jennifer Cardini Remix', title: 'surrender' },
  to: { artist: 'Curses', title: 'Surrender (Jennifer Cardini Remix)' },
};
const SURRENDER_B: SongFix = {
  from: { artist: '@cursesforever - surrender (@jennifercardini remix)', title: 'surrender' },
  to: { artist: 'Curses', title: 'Surrender (Jennifer Cardini Remix)' },
};

describe('parseFixes', () => {
  it('reads a list of fixes and trims what they say', () => {
    const fixes = parseFixes(JSON.stringify([{ from: { artist: '@x', title: 'T' }, to: { artist: ' Real Artist ', title: ' T ', album: null } }]));
    expect(fixes).toEqual([{ from: { artist: '@x', title: 'T' }, to: { artist: 'Real Artist', title: 'T', album: null } }]);
  });

  it('says what is wrong, and where', () => {
    expect(() => parseFixes('{')).toThrow(/not valid JSON/);
    expect(() => parseFixes('{}')).toThrow(/non-empty array/);
    expect(() => parseFixes('[]')).toThrow(/non-empty array/);
    expect(() => parseFixes('[{"to":{"artist":"a","title":"b"}}]')).toThrow(/fixes\[0\]: needs "from" and "to"/);
    expect(() => parseFixes('[{"from":{"artist":"a","title":""},"to":{"artist":"a","title":"b"}}]')).toThrow(/fixes\[0\].from/);
    expect(() => parseFixes('[{"from":{"artist":"a","title":"b"},"to":{"artist":"","title":"b"}}]')).toThrow(/fixes\[0\].to/);
    expect(() => parseFixes('[{"from":{"artist":"a","title":"b"},"to":{"artist":"c","title":"d","album":3}}]')).toThrow(/album/);
    expect(() => parseFixes('[{"from":{"artist":"A","title":"B"},"to":{"artist":"a","title":"b"}}]')).toThrow(/the same song/);
  });

  it('a from with an empty artist is allowed (a song found with no artist)', () => {
    expect(parseFixes('[{"from":{"artist":"","title":"Dimas"},"to":{"artist":"Masego","title":"Dimas"}}]')).toHaveLength(1);
  });
});

describe('correctEntry', () => {
  it('rewrites the artist and album of the song, and rebuilds the search link that carried the handle', () => {
    const row = entry('e1', [
      song('Glory Box', 'Portishead'),
      song('Mezzanine', '@massiveattackofficial', {
        album: 'Massive Attack',
        youtubeUrl: 'https://www.youtube.com/watch?v=L6eGCrSr3Ss',
        soundcloudUrl: 'https://soundcloud.com/search/sounds?q=%40massiveattackofficial%20Mezzanine',
      }),
    ]);
    const out = correctEntry(row, [MEZZANINE], NOW)!;
    expect(out.results.songs).toHaveLength(2);
    expect(out.results.songs[0]).toEqual(row.results!.songs[0]); // the other song is untouched
    expect(out.results.songs[1]).toMatchObject({
      title: 'Mezzanine',
      artist: 'Massive Attack',
      album: 'Mezzanine',
      youtubeUrl: 'https://www.youtube.com/watch?v=L6eGCrSr3Ss', // a link to a specific video stays
      soundcloudUrl: 'https://soundcloud.com/search/sounds?q=Massive%20Attack%20Mezzanine',
    });
    expect(out.results.summary).toBe('riassunto');
  });

  it('adds one song_corrected line to the action log and leaves the old lines', () => {
    const out = correctEntry(entry('e1', [song('Mezzanine', '@massiveattackofficial')]), [MEZZANINE], NOW)!;
    expect(out.actionLog.map((l) => l.action)).toEqual(['start', 'song_corrected']);
    expect(out.actionLog[1].timestamp).toBe('2026-11-08T12:00:00.000Z');
    expect(out.actionLog[1].details).toMatchObject({
      source: 'fixSongIdentity',
      changes: [{ from: '@massiveattackofficial::mezzanine', to: 'massive attack::mezzanine', rewritten: 1, folded: 0 }],
    });
    expect(out.changes).toHaveLength(1);
  });

  it('matches the way the song key does: case and spaces do not matter', () => {
    expect(correctEntry(entry('e1', [song('  MEZZANINE ', '@MassiveAttackOfficial')]), [MEZZANINE], NOW)).not.toBeNull();
  });

  it('two songs that become the same song are one, the first completed with what the other knew', () => {
    const row = entry('e2', [
      song('Poison Lips', 'Vitalic'),
      song('surrender', '@cursesforever - Jennifer Cardini Remix', { youtubeUrl: 'https://www.youtube.com/watch?v=8QXjly95EOg' }),
      song('surrender', '@cursesforever - surrender (@jennifercardini remix)', { spotifyUrl: 'https://open.spotify.com/track/abc', addedToPlaylist: true }),
    ]);
    const out = correctEntry(row, [SURRENDER_A, SURRENDER_B], NOW)!;
    expect(out.results.songs.map((s) => `${s.artist} / ${s.title}`)).toEqual(['Vitalic / Poison Lips', 'Curses / Surrender (Jennifer Cardini Remix)']);
    expect(out.results.songs[1]).toMatchObject({
      youtubeUrl: 'https://www.youtube.com/watch?v=8QXjly95EOg', // the first one's own link is kept
      spotifyUrl: 'https://open.spotify.com/track/abc', // the other's is added
      addedToPlaylist: true,
    });
    const folded = out.changes.reduce((n, c) => n + c.folded, 0);
    expect(folded).toBe(1);
  });

  it('keeps the album when the fix gives none, and clears it when the fix says null', () => {
    const keep = correctEntry(entry('e1', [song('surrender', '@cursesforever - Jennifer Cardini Remix', { album: 'Old' })]), [SURRENDER_A], NOW)!;
    expect(keep.results.songs[0].album).toBe('Old');
    const clear = correctEntry(
      entry('e1', [song('Mezzanine', '@massiveattackofficial', { album: 'Massive Attack' })]),
      [{ ...MEZZANINE, to: { ...MEZZANINE.to, album: null } }],
      NOW,
    )!;
    expect(clear.results.songs[0].album).toBeNull();
  });

  it('returns null when nothing matches, also when run a second time', () => {
    const row = entry('e1', [song('Glory Box', 'Portishead')]);
    expect(correctEntry(row, [MEZZANINE], NOW)).toBeNull();
    const first = correctEntry(entry('e1', [song('Mezzanine', '@massiveattackofficial')]), [MEZZANINE], NOW)!;
    expect(correctEntry({ id: 'e1', results: first.results, action_log: first.actionLog }, [MEZZANINE], NOW)).toBeNull();
  });

  it('copes with an entry that has no songs or no results', () => {
    expect(correctEntry({ id: 'e', results: null, action_log: null }, [MEZZANINE], NOW)).toBeNull();
    expect(correctEntry({ id: 'e', results: { songs: undefined as never, films: [], notes: [], links: [], tags: [], summary: null }, action_log: [] }, [MEZZANINE], NOW)).toBeNull();
  });

  it('does not touch its input', () => {
    const row = entry('e1', [song('Mezzanine', '@massiveattackofficial')]);
    const before = structuredClone(row);
    correctEntry(row, [MEZZANINE], NOW);
    expect(row).toEqual(before);
  });
});

describe('refuses', () => {
  it('an old key with playlists, files or plays is not abandoned; empty enrichment rows do not stop it', () => {
    const none: KeyUsage = { playlists: 0, files: 0, plays: 0, meta: 3 };
    expect(refuses(none)).toBe(false);
    expect(refuses({ ...none, playlists: 1 })).toBe(true);
    expect(refuses({ ...none, files: 1 })).toBe(true);
    expect(refuses({ ...none, plays: 4 })).toBe(true);
  });
});

describe('parseArgs', () => {
  it('is a dry run unless --apply, and --dry-run wins', () => {
    expect(parseArgs(['--file', '/tmp/f.json'])).toEqual({ file: '/tmp/f.json', apply: false, backup: null });
    expect(parseArgs(['--file', 'f', '--apply', '--backup', '/tmp/b'])).toEqual({ file: 'f', apply: true, backup: '/tmp/b' });
    expect(parseArgs(['--file', 'f', '--apply', '--dry-run']).apply).toBe(false);
    expect(parseArgs(['--file', '--apply'])).toEqual({ file: null, apply: true, backup: null });
  });
});

describe('fixSongIdentity', () => {
  const FILE = JSON.stringify([
    { from: MEZZANINE.from, to: MEZZANINE.to },
    { from: SURRENDER_A.from, to: SURRENDER_A.to },
  ]);
  const rows = [
    entry('aaaaaaaa-1', [song('Mezzanine', '@massiveattackofficial')]),
    entry('bbbbbbbb-2', [song('surrender', '@cursesforever - Jennifer Cardini Remix')]),
    entry('cccccccc-3', [song('Mezzanine', 'Massive Attack')]), // the title matches, the song does not: left alone
  ];

  function deps(over: Partial<Deps> = {}) {
    const said: string[] = [];
    const order: string[] = [];
    const d: Deps = {
      readFile: vi.fn(async () => FILE),
      entries: vi.fn(async () => rows),
      usage: vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, { playlists: 0, files: 0, plays: 0, meta: 1 }]))),
      backup: vi.fn(async () => { order.push('backup'); }),
      apply: vi.fn(async (id: string) => { order.push(`apply:${id.slice(0, 8)}`); return [{ from: 'a', to: 'b', rewritten: 1, folded: 0 }]; }),
      say: (line) => said.push(line),
      now: () => NOW,
      ...over,
    };
    return { d, said, order };
  }

  it('is a dry run by default: it shows what would change and writes nothing', async () => {
    const { d, said } = deps();
    const out = await fixSongIdentity(d, { file: '/tmp/f.json', apply: false, backup: null });
    expect(out).toEqual({ entries: 2, corrected: 0, refused: 0, failed: 0 });
    expect(d.backup).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
    const text = said.join('\n');
    expect(text).toContain('aaaaaaaa');
    expect(text).toContain('@massiveattackofficial::mezzanine  ->  massive attack::mezzanine');
    expect(text).not.toContain('cccccccc');
    expect(text).toContain('DRY RUN');
  });

  it('writes the backup of the entries it will change before the first change', async () => {
    const { d, order } = deps();
    const out = await fixSongIdentity(d, { file: 'f', apply: true, backup: null });
    expect(out).toEqual({ entries: 2, corrected: 2, refused: 0, failed: 0 });
    expect(order).toEqual(['backup', 'apply:aaaaaaaa', 'apply:bbbbbbbb']);
    const [path, ids] = vi.mocked(d.backup).mock.calls[0];
    expect(path).toMatch(/^\/tmp\/soundreel-fix-song-identity-2026-11-08T12-00-00-000Z\.jsonl$/); // never under /data/media
    expect(ids).toEqual(['aaaaaaaa-1', 'bbbbbbbb-2']);
  });

  it('refuses a fix whose old key has a playlist, a file or plays, and still does the others', async () => {
    const { d, said } = deps({
      usage: vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, { playlists: k.startsWith('@massive') ? 2 : 0, files: 0, plays: 0, meta: 0 }]))),
    });
    const out = await fixSongIdentity(d, { file: 'f', apply: true, backup: null });
    expect(out).toEqual({ entries: 1, corrected: 1, refused: 1, failed: 0 });
    expect(vi.mocked(d.apply).mock.calls.map((c) => c[0])).toEqual(['bbbbbbbb-2']);
    expect(said.join('\n')).toMatch(/RIFIUTATA/);
  });

  it('one entry that fails does not stop the others, and one that no longer needs it is reported', async () => {
    const { d, said } = deps({
      apply: vi.fn(async (id: string) => {
        if (id.startsWith('aaaaaaaa')) throw new Error('deadlock');
        return null;
      }),
    });
    const out = await fixSongIdentity(d, { file: 'f', apply: true, backup: null });
    expect(out).toEqual({ entries: 2, corrected: 0, refused: 0, failed: 1 });
    expect(said.join('\n')).toContain('ERRORE aaaaaaaa: deadlock');
    expect(said.join('\n')).toContain('invariata');
  });

  it('needs a file, and does nothing (not even a backup) when no entry matches', async () => {
    const { d } = deps({ entries: vi.fn(async () => [rows[2]]) });
    await expect(fixSongIdentity(d, { file: null, apply: true, backup: null })).rejects.toThrow(/usage/);
    const out = await fixSongIdentity(d, { file: 'f', apply: true, backup: null });
    expect(out.entries).toBe(0);
    expect(d.backup).not.toHaveBeenCalled();
  });
});

describe('applyEntry', () => {
  function fakeClient(row: EntryRow | null, failOn?: RegExp) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (failOn?.test(sql)) throw new Error('boom');
        if (/FOR UPDATE/.test(sql)) return { rows: row ? [row] : [] };
        return { rows: [] };
      }),
    };
    return { client: client as never, calls };
  }

  it('locks the row, reads it again, corrects it and commits, in one transaction', async () => {
    const fresh = entry('e1', [song('Mezzanine', '@massiveattackofficial')]);
    const { client, calls } = fakeClient(fresh);
    const changes = await applyEntry(client, 'e1', [MEZZANINE], NOW);
    expect(changes).toHaveLength(1);
    expect(calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual(['BEGIN', 'SELECT id,', 'UPDATE entries', 'COMMIT']);
    expect(calls[1].sql).toMatch(/FOR UPDATE/);
    const update = calls[2];
    expect(update.params[0]).toBe('e1');
    expect(JSON.parse(update.params[1] as string).songs[0].artist).toBe('Massive Attack');
    expect(JSON.parse(update.params[2] as string).map((l: { action: string }) => l.action)).toContain('song_corrected');
  });

  it('rolls back and returns null when the row no longer has anything to correct, or is gone', async () => {
    const done = fakeClient(entry('e1', [song('Mezzanine', 'Massive Attack')]));
    expect(await applyEntry(done.client, 'e1', [MEZZANINE], NOW)).toBeNull();
    expect(done.calls.map((c) => c.sql).at(-1)).toBe('ROLLBACK');
    expect(done.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    const gone = fakeClient(null);
    expect(await applyEntry(gone.client, 'e1', [MEZZANINE], NOW)).toBeNull();
    expect(gone.calls.map((c) => c.sql).at(-1)).toBe('ROLLBACK');
  });

  it('rolls back and rethrows when the write fails', async () => {
    const { client, calls } = fakeClient(entry('e1', [song('Mezzanine', '@massiveattackofficial')]), /^UPDATE entries/);
    await expect(applyEntry(client, 'e1', [MEZZANINE], NOW)).rejects.toThrow('boom');
    expect(calls.map((c) => c.sql).at(-1)).toBe('ROLLBACK');
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(false);
  });
});
