import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, poolQuery } = vi.hoisted(() => ({ query: vi.fn(), poolQuery: vi.fn() }));
vi.mock('../utils/db', () => ({ query, pool: { query: poolQuery } }));

import { getPlayedSongKeys } from './listeningStats';
import { firstSongKeys } from './playlists';

const sqlOf = (mock: ReturnType<typeof vi.fn>): string => String(mock.mock.calls[0][0]).replace(/\s+/g, ' ');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPlayedSongKeys (what «Nuovi dai tuoi reel» leaves out)', () => {
  it('is the set of the songs this user has a counted play of, nobody else\'s', async () => {
    query.mockResolvedValue([{ song_key: 'a::one' }, { song_key: 'b::two' }]);
    const played = await getPlayedSongKeys('archi');
    expect(played).toBeInstanceOf(Set);
    expect([...played].sort()).toEqual(['a::one', 'b::two']);
    const sql = sqlOf(query);
    expect(sql).toContain('DISTINCT song_key');
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain('counted');
    expect(query.mock.calls[0][1]).toEqual(['archi']);
  });
});

describe('firstSongKeys (the cover mosaic of a playlist)', () => {
  it('asks nothing for no playlist', async () => {
    await expect(firstSongKeys([])).resolves.toEqual(new Map());
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('takes the first songs of every playlist in ONE query, in the playlist\'s own order', async () => {
    poolQuery.mockResolvedValue({
      rows: [
        { playlist_id: 'p1', song_key: 'a' }, { playlist_id: 'p1', song_key: 'b' },
        { playlist_id: 'p2', song_key: 'x' },
      ],
    });
    const keys = await firstSongKeys(['p1', 'p2', 'p3'], 4);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(keys.get('p1')).toEqual(['a', 'b']);
    expect(keys.get('p2')).toEqual(['x']);
    expect(keys.has('p3')).toBe(false);                                // an empty playlist has no entry
    const sql = sqlOf(poolQuery);
    expect(sql).toContain('PARTITION BY playlist_id ORDER BY position ASC, added_at ASC');
    expect(sql).toContain('n <= $2');
    expect(poolQuery.mock.calls[0][1]).toEqual([['p1', 'p2', 'p3'], 4]);
  });

  it('keeps four songs per playlist unless told otherwise', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await firstSongKeys(['p1']);
    expect(poolQuery.mock.calls[0][1]).toEqual([['p1'], 4]);
  });
});
