import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({
  pool: { query: vi.fn() },
}));

import { pool } from '../utils/db';
import {
  addSongToPlaylist,
  createDynamicPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistSongDates,
  listPlaylists,
  removeSongFromPlaylist,
  renamePlaylist,
  reorderPlaylistSongs,
  updatePlaylistRule,
} from './playlists';
import { PRESETS } from './dynamicRules';

const mockedQuery = vi.mocked(pool.query);

describe('playlists service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listPlaylists maps counts', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{
        id: 'p1', name: 'Road', created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z', song_count: 3,
      }],
      rowCount: 1,
    } as never);

    const list = await listPlaylists();
    expect(list).toEqual([{
      id: 'p1', name: 'Road', songCount: 3, kind: 'static',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    }]);
  });

  it('createPlaylist rejects empty name', async () => {
    await expect(createPlaylist('  ')).rejects.toThrow('name_required');
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('createPlaylist inserts playlist and optional songs', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{
          id: 'uuid', name: 'Mix', created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z', song_count: 2,
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [
          { song_key: 'a::one', position: 0 },
          { song_key: 'b::two', position: 1 },
        ],
        rowCount: 2,
      } as never);

    const detail = await createPlaylist('Mix', ['a::one', 'b::two', 'a::one']);
    expect(detail.name).toBe('Mix');
    expect(detail.songKeys).toEqual(['a::one', 'b::two']);
  });

  it('getPlaylist returns null when missing', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await getPlaylist('missing')).toBeNull();
  });

  it('getPlaylistSongDates gives the date each song was put in the playlist, by song key (ISO, UTC)', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        { song_key: 'a::x', added_at: new Date('2026-11-05T10:00:00.000Z') },
        { song_key: 'b::y', added_at: '2026-11-06T08:30:00.000Z' },
      ],
      rowCount: 2,
    } as never);
    const dates = await getPlaylistSongDates('p1');
    expect(dates.get('a::x')).toBe('2026-11-05T10:00:00.000Z');
    expect(dates.get('b::y')).toBe('2026-11-06T08:30:00.000Z');
    expect(dates.size).toBe(2);
    const [sql, params] = mockedQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/FROM playlist_songs/);
    expect(params).toEqual(['p1']);                      // that playlist and no other
  });

  it('getPlaylistSongDates of an empty playlist is an empty map', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect((await getPlaylistSongDates('p1')).size).toBe(0);
  });

  it('renamePlaylist updates name', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{
          id: 'p1', name: 'New', created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-03T00:00:00Z', song_count: 0,
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const detail = await renamePlaylist('p1', 'New');
    expect(detail?.name).toBe('New');
  });

  it('deletePlaylist returns false when missing', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await deletePlaylist('x')).toBe(false);
  });

  it('addSongToPlaylist returns null when playlist missing', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await addSongToPlaylist('gone', 'a::b')).toBeNull();
  });

  it('removeSongFromPlaylist deletes membership', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ kind: 'static' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{
          id: 'p1', name: 'Mix', created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z', song_count: 0,
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const detail = await removeSongFromPlaylist('p1', 'a::b');
    expect(detail?.songKeys).toEqual([]);
  });

  it('reorderPlaylistSongs keeps unknown keys at the end', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ kind: 'static' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          { song_key: 'a', position: 0 },
          { song_key: 'b', position: 1 },
          { song_key: 'c', position: 2 },
        ],
        rowCount: 3,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [{
          id: 'p1', name: 'Mix', created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z', song_count: 3,
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [
          { song_key: 'c', position: 0 },
          { song_key: 'a', position: 1 },
          { song_key: 'b', position: 2 },
        ],
        rowCount: 3,
      } as never);

    const detail = await reorderPlaylistSongs('p1', ['c', 'a']);
    expect(detail?.songKeys).toEqual(['c', 'a', 'b']);
  });

  describe('dynamic playlists (ADR-0008)', () => {
    const summaryRow = (over: Record<string, unknown> = {}) => ({
      id: 'd1', name: 'Notte', owner_user: 'mike', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', song_count: 0,
      kind: 'dynamic', rule: PRESETS.find((p) => p.id === 'night')!.rule, ...over,
    });

    it('listPlaylists tells static from dynamic and explains a rule in words', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [summaryRow(), summaryRow({ id: 's1', name: 'Auto', kind: 'static', rule: null, song_count: 4 })], rowCount: 2 } as never);
      const out = await listPlaylists();
      expect(out[0]).toMatchObject({ id: 'd1', kind: 'dynamic', ruleSummary: 'Più ascoltate · 22:00–06:00 · ultimi 90 giorni · max 50' });
      expect(out[0].rule).toMatchObject({ order: 'most_played', window: { from: '22:00', to: '06:00' } });
      expect(out[1]).toMatchObject({ id: 's1', kind: 'static', songCount: 4 });
      expect(out[1].rule).toBeUndefined();
    });

    it('a stored rule that no longer parses degrades to a dynamic playlist without a summary (never a crash)', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [summaryRow({ rule: { order: 'loudest' } })], rowCount: 1 } as never);
      const [p] = await listPlaylists();
      expect(p.kind).toBe('dynamic');
      expect(p.rule).toBeUndefined();
      expect(p.ruleSummary).toBeUndefined();
    });

    it.each([
      ['addSongToPlaylist', () => addSongToPlaylist('d1', 'a::b')],
      ['removeSongFromPlaylist', () => removeSongFromPlaylist('d1', 'a::b')],
      ['reorderPlaylistSongs', () => reorderPlaylistSongs('d1', ['a::b'])],
    ])('%s refuses a dynamic playlist before touching anything', async (_n, run) => {
      mockedQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never) // it exists
        .mockResolvedValueOnce({ rows: [{ kind: 'dynamic' }], rowCount: 1 } as never); // …and is dynamic
      await expect(run()).rejects.toThrow('playlist_is_dynamic');
      expect(mockedQuery).toHaveBeenCalledTimes(2); // no insert, delete or update happened
    });

    it('createDynamicPlaylist stores kind and the rule as JSON for its owner', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // insert
        .mockResolvedValueOnce({ rows: [summaryRow({ id: 'new' })], rowCount: 1 } as never) // summary
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // songs
      const rule = PRESETS.find((p) => p.id === 'night')!.rule;
      const out = await createDynamicPlaylist('  Notte  ', rule, 'Mike');
      const [sql, params] = mockedQuery.mock.calls[0] as unknown as [string, unknown[]];
      expect(sql).toMatch(/INSERT INTO playlists \(id, name, owner_user, kind, rule\)/);
      expect(sql).toMatch(/'dynamic'/);
      expect([params[1], params[2], JSON.parse(String(params[3]))]).toEqual(['Notte', 'mike', rule]);
      expect(out).toMatchObject({ kind: 'dynamic', ownerUser: 'mike' });
      await expect(createDynamicPlaylist('  ', rule, 'mike')).rejects.toThrow('name_required');
    });

    it('updatePlaylistRule: not yours → null, a static playlist → not_dynamic, otherwise the updated playlist', async () => {
      const rule = PRESETS.find((p) => p.id === 'morning')!.rule;
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // ownership check fails
      expect(await updatePlaylistRule('d1', rule, 'sara')).toBeNull();

      mockedQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // UPDATE … AND kind = 'dynamic' matched nothing
      expect(await updatePlaylistRule('s1', rule, 'mike')).toBe('not_dynamic');

      mockedQuery
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [summaryRow({ rule })], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      const out = await updatePlaylistRule('d1', rule, 'mike');
      expect(out).not.toBe('not_dynamic');
      expect(out && out !== 'not_dynamic' && out.ruleSummary).toBe('Più ascoltate · 07:00–08:00 · ultimi 30 giorni · max 50');
    });
  });
});
