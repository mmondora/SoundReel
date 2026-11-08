import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolMock = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn() }));
vi.mock('../utils/db', () => ({ pool: poolMock, query: poolMock.query }));

import { chooseIndexHit, isJunk, lookupMediaIndex, normKey, replaceMediaIndex, type IndexHit, type IndexItem } from './mediaIndex';

const hit = (over: Partial<IndexHit> = {}): IndexHit => ({
  store: 'fritz', relPath: 'Music/SoundReel/Bishop Briggs - White Flag.mp3', artist: 'Bishop Briggs', title: 'White Flag',
  album: 'Church of Scars', durationS: 230, bytes: 5_000_000, normKey: 'bishop briggs|white flag', ...over,
});

describe('normKey / isJunk', () => {
  it('ignores case, spacing and trailing (Live)/[Remaster] groups, like the library matcher', () => {
    expect(normKey('Bishop  Briggs', 'White Flag (Live)')).toBe('bishop briggs|white flag');
    expect(normKey('AC/DC', 'Thunderstruck [Remastered]')).toBe('ac/dc|thunderstruck');
  });

  it('flags macOS shadow files, stubs and non-mp3 files', () => {
    expect(isJunk({ relPath: 'Music/x/._01 - A.mp3', bytes: 4096 })).toBe(true);
    expect(isJunk({ relPath: 'Music/x/a.mp3', bytes: 1000 })).toBe(true);
    expect(isJunk({ relPath: 'Music/x/a.flac', bytes: 9_000_000 })).toBe(true);
    expect(isJunk({ relPath: 'Music/x/a.mp3', bytes: null })).toBe(false);
    expect(isJunk({ relPath: 'Music/x/a.MP3', bytes: 5_000_000 })).toBe(false);
  });
});

describe('chooseIndexHit (what is safe to reuse)', () => {
  const wanted = { artist: 'Bishop Briggs', title: 'White Flag' };

  it('takes the plain studio file and prefers the exact title, then the bigger file', () => {
    const best = chooseIndexHit(
      [
        hit({ relPath: 'Music/a/small.mp3', bytes: 3_000_000, title: 'White Flag' }),
        hit({ relPath: 'Music/a/big.mp3', bytes: 9_000_000, title: 'White Flag' }),
        hit({ relPath: 'Music/a/other-title.mp3', bytes: 12_000_000, title: 'White Flag (2018 Mix)' }),
      ],
      wanted,
    );
    expect(best?.relPath).toBe('Music/a/big.mp3');
  });

  it.each(['Live at Wembley', 'Bootleg 2019', 'Demo', 'Karaoke Version', 'Remix', 'Acoustic'])(
    'never reuses a "%s" version for the studio song',
    (suffix) => {
      expect(chooseIndexHit([hit({ title: `White Flag (${suffix})` })], wanted)).toBeNull();
      expect(chooseIndexHit([hit({ album: suffix, title: 'White Flag' })], wanted)).toBeNull();
    },
  );

  it('does reuse a live file when the live version is what was asked for', () => {
    const live = { artist: 'Queen', title: 'Live and Let Die' };
    expect(chooseIndexHit([hit({ artist: 'Queen', title: 'Live and Let Die' })], live)).not.toBeNull();
    expect(chooseIndexHit([hit({ title: 'White Flag (Live)' })], { ...wanted, title: 'White Flag (Live)' })).not.toBeNull();
  });

  it('never returns junk, and nothing for an empty list', () => {
    expect(chooseIndexHit([hit({ relPath: 'Music/a/._White Flag.mp3', bytes: 4096 })], wanted)).toBeNull();
    expect(chooseIndexHit([], wanted)).toBeNull();
  });
});

describe('replaceMediaIndex / lookupMediaIndex (SQL is exercised against a real Postgres separately)', () => {
  const client = { query: vi.fn(), release: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    poolMock.connect.mockResolvedValue(client);
    client.query.mockResolvedValue({ rows: [] });
  });
  const item = (n: number, over: Partial<IndexItem> = {}): IndexItem => ({
    store: 'fritz', relPath: `Music/SoundReel/Artist - Song ${n}.mp3`, artist: 'Artist', title: `Song ${n}`, album: null,
    durationS: null, bytes: 4_000_000, ...over,
  });

  it('swaps the index inside one transaction, dropping junk and duplicates, in chunks', async () => {
    const items = [
      ...Array.from({ length: 1200 }, (_, i) => item(i)),
      item(5), // duplicate path
      item(9999, { relPath: 'Music/x/._junk.mp3' }),
      item(9998, { artist: '' }),
    ];
    const n = await replaceMediaIndex('fritz', items);
    expect(n).toBe(1200);
    const sqls = client.query.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toBe('DELETE');
    expect(sqls.filter((s) => s === 'INSERT')).toHaveLength(3); // 500 + 500 + 200
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the connection when an insert fails', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (String(sql).trim().startsWith('INSERT')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(replaceMediaIndex('fritz', [item(1)])).rejects.toThrow('boom');
    expect(client.query.mock.calls.some((c) => String(c[0]).trim() === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('looks songs up by their normalized key and maps bigint sizes', async () => {
    poolMock.query.mockResolvedValue([
      { store: 'fritz', rel_path: 'Music/x/a.mp3', artist: 'A', title: 'B', album: null, duration_s: null, bytes: '123', norm_key: 'a|b' },
    ]);
    const hits = await lookupMediaIndex('A', 'B (Live)');
    expect(poolMock.query.mock.calls[0][1]).toEqual(['a|b']);
    expect(hits[0]).toMatchObject({ relPath: 'Music/x/a.mp3', bytes: 123, normKey: 'a|b' });
  });
});
