/**
 * The likes of the songs against a REAL Postgres (ADR-0028). Skipped unless `LIKES_INT=1`: it needs a throw-away database that already has `init.sql` and the
 * migrations applied (the test also applies migration 025 itself, twice, in a schema of its own), and the usual `DB_*` variables pointing at it (never production):
 *
 *   LIKES_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=collections_check DB_USER=postgres DB_PASSWORD=… npx vitest run --no-file-parallelism src/services/songLikes.int.test.ts
 *
 * What the unit tests cannot see: the primary key that makes a like one per person and song, the FIRST date that survives a second PUT, the order of the list, a
 * person that never sees another's likes, the unique index that makes the playlist «Mi piace» one per person even when two likes arrive together, the foreign key that
 * lets a deleted playlist leave its theme without a playlist (so it is never made again), and the list of playlists the apps read with that playlist in it.
 *
 * The same file also proves, on the same database, the swipe «Togli dalla playlist» (`removeSongFromPlaylist`, what `DELETE /api/mondrop/playlists/:id/songs/:songKey` calls): only the owner of a
 * STATIC playlist, idempotent, a key that has a `%` in it, the other songs untouched.
 *
 * Everything the tests make belongs to a user (or a playlist) that begins with `ltest_` and is removed by that prefix; the test refuses the database called `soundreel`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../utils/db';

const on = process.env.LIKES_INT === '1';
if (on && (!process.env.DB_NAME || process.env.DB_NAME === 'soundreel')) {
  throw new Error('LIKES_INT=1 needs a scratch DB_NAME (never the real one)');
}

// the journal and the library are not what is tested here: two songs of the journal and one that exists only as a file
const m = vi.hoisted(() => ({ getUserSongs: vi.fn(), libraryOnlySong: vi.fn(), listReadySongKeys: vi.fn() }));
vi.mock('./userSongs', () => ({ getUserSongs: m.getUserSongs }));
vi.mock('./libraryOnlySongs', () => ({ libraryOnlySong: m.libraryOnlySong }));
vi.mock('./songFiles', () => ({ listReadySongKeys: m.listReadySongKeys }));

import { PgAutoPlaylistStore } from './autoPlaylistStore';
import { resolveDynamicSongKeys } from './dynamicPlaylists';
import { LIKED_THEME_KEY, ensureLikedPlaylist, likedRule } from './likedPlaylist';
import { addSongToPlaylist, createDynamicPlaylist, createPlaylist, deletePlaylist, getPlaylist, listPlaylists, removeSongFromPlaylist, sharePlaylist } from './playlists';
import { resolveSummaries } from './playlistResolver';
import { likedKeys, listLikes, putLike, removeLike } from './songLikes';

const d = on ? describe : describe.skip;

const MIKE = 'ltest_mike';
const SARA = 'ltest_sara';
const at = (iso: string) => new Date(iso);
const journalSong = (key: string) => ({ songKey: key, title: key.split('::')[1], artist: key.split('::')[0], mentions: [{ entryId: `e-${key}`, createdAt: '2026-10-01T00:00:00Z' }], meta: { genres: [], downloaded: false } });

async function wipe(): Promise<void> {
  await pool.query("DELETE FROM song_likes WHERE user_id LIKE 'ltest\\_%'");
  await pool.query("DELETE FROM auto_playlist_themes WHERE owner_user LIKE 'ltest\\_%'");
  await pool.query("DELETE FROM playlist_songs WHERE playlist_id IN (SELECT id FROM playlists WHERE owner_user LIKE 'ltest\\_%')");
  await pool.query("DELETE FROM playlists WHERE owner_user LIKE 'ltest\\_%'");
}

d('the likes on a real database', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // the migration is idempotent: the runner applies it at every boot, so applying it here is what the server does
    await pool.query(readFileSync(path.join(__dirname, '..', 'db', 'migrations', '025_song_likes.sql'), 'utf8'));
    await wipe();
    m.getUserSongs.mockResolvedValue(new Map([['a::alpha', journalSong('a::alpha')], ['b::bravo', journalSong('b::bravo')]]));
    m.libraryOnlySong.mockImplementation(async (key: string) => (key === 'f::file-only' ? { ...journalSong(key), libraryOnly: true, meta: undefined, mentions: [] } : undefined));
    m.listReadySongKeys.mockResolvedValue(new Set());
  });

  afterAll(async () => {
    if (on) await wipe();
    await pool.end();
  });

  describe('the table', () => {
    it('applies twice (the runner re-applies every migration at each boot), makes the table and the index, and nothing else', async () => {
      const client = await pool.connect();
      const schema = `ltest_mig_${Date.now()}`;
      try {
        const migration = readFileSync(path.join(__dirname, '..', 'db', 'migrations', '025_song_likes.sql'), 'utf8');
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`SET search_path TO ${schema}`);
        await client.query(migration);
        await client.query(migration);
        const tables = await client.query<{ table_name: string }>('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [schema]);
        expect(tables.rows.map((r) => r.table_name)).toEqual(['song_likes']);
        const indexes = await client.query<{ indexname: string }>('SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname', [schema]);
        expect(indexes.rows.map((r) => r.indexname)).toEqual(['idx_song_likes_user_time', 'song_likes_pkey']);
      } finally {
        await client.query('RESET search_path');
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        client.release();
      }
    });
  });

  describe('putLike, listLikes, removeLike', () => {
    it('is one row per person and song: the second PUT is a no-op that keeps the FIRST date, whatever date it brings', async () => {
      const first = await putLike(MIKE, 'a::alpha', at('2026-11-01T10:00:00Z'));
      expect(first).toEqual({ created: true, likedAt: at('2026-11-01T10:00:00Z') });
      const later = await putLike(MIKE, 'a::alpha', at('2026-11-09T10:00:00Z'));
      expect(later).toEqual({ created: false, likedAt: at('2026-11-01T10:00:00Z') });
      const earlier = await putLike(MIKE, 'a::alpha', at('2026-10-01T10:00:00Z'));
      expect(earlier).toEqual({ created: false, likedAt: at('2026-11-01T10:00:00Z') });
      expect(await listLikes(MIKE)).toEqual([{ songKey: 'a::alpha', likedAt: '2026-11-01T10:00:00.000Z' }]);
    });

    it('lists the most recent first and, at the same moment, by key; the same key of two people is two likes', async () => {
      await putLike(MIKE, 'b::bravo', at('2026-11-05T10:00:00Z'));
      await putLike(MIKE, 'a::alpha', at('2026-11-05T10:00:00Z'));
      await putLike(MIKE, 'c::charlie', at('2026-11-09T10:00:00Z'));
      await putLike(MIKE, 'z::zulu', at('2026-11-01T10:00:00Z'));
      await putLike(SARA, 'a::alpha', at('2026-11-07T10:00:00Z'));
      expect((await listLikes(MIKE)).map((l) => l.songKey)).toEqual(['c::charlie', 'a::alpha', 'b::bravo', 'z::zulu']);
      expect(await likedKeys(MIKE)).toEqual(['c::charlie', 'a::alpha', 'b::bravo', 'z::zulu']);
      expect(await likedKeys(SARA)).toEqual(['a::alpha']);
    });

    it('never shows a person the likes of another, and removing is the person\'s own: Sara removing a key she has not liked touches nothing of Mike\'s', async () => {
      await putLike(MIKE, 'a::alpha', at('2026-11-05T10:00:00Z'));
      expect(await listLikes(SARA)).toEqual([]);
      expect(await removeLike(SARA, 'a::alpha')).toBe(false);
      expect((await listLikes(MIKE)).map((l) => l.songKey)).toEqual(['a::alpha']);
    });

    it('removes a like and is idempotent: the second removal says it was not there, with no error', async () => {
      await putLike(MIKE, 'a::alpha', at('2026-11-05T10:00:00Z'));
      expect(await removeLike(MIKE, 'a::alpha')).toBe(true);
      expect(await removeLike(MIKE, 'a::alpha')).toBe(false);
      expect(await listLikes(MIKE)).toEqual([]);
      // and a like given again after a removal is a new one with its own date
      expect(await putLike(MIKE, 'a::alpha', at('2026-11-10T10:00:00Z'))).toEqual({ created: true, likedAt: at('2026-11-10T10:00:00Z') });
    });

    it('keeps a key exactly: accents, case, quotes and a long key (500 characters) are stored and read back as they went in', async () => {
      const keys = ['Beyoncé::Halo (Live)', "guns n' roses::don't cry", '日'.repeat(500), 'K'.repeat(500)];
      for (const [i, key] of keys.entries()) await putLike(MIKE, key, at(`2026-11-0${i + 1}T10:00:00Z`));
      expect((await likedKeys(MIKE)).sort()).toEqual([...keys].sort());
    });

    it('two PUTs of the same like at the same time make ONE row (the primary key decides) and only one of them is new', async () => {
      const [a, b] = await Promise.all([putLike(MIKE, 'a::alpha', at('2026-11-05T10:00:00Z')), putLike(MIKE, 'a::alpha', at('2026-11-06T10:00:00Z'))]);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(a.likedAt).toEqual(b.likedAt);
      expect(await listLikes(MIKE)).toHaveLength(1);
    });
  });

  describe('the playlist «Mi piace»', () => {
    const store = new PgAutoPlaylistStore();

    const likedRows = async (owner: string) =>
      (await pool.query<{ id: string; name: string; kind: string; origin: string; auto_kind: string; theme_key: string; source_entry_id: string | null; rule: unknown }>(
        'SELECT id, name, kind, origin, auto_kind, theme_key, source_entry_id, rule FROM playlists WHERE owner_user = $1 AND theme_key = $2', [owner, LIKED_THEME_KEY],
      )).rows;

    it('is made at the first like: dynamic, automatic, a theme with no post behind it, the rule «the songs I like», and registered', async () => {
      const out = await ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-10T20:00:00Z') });
      expect(out.status).toBe('made');
      const rows = await likedRows(MIKE);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'Mi piace', kind: 'dynamic', origin: 'auto', auto_kind: 'theme', theme_key: 'liked', source_entry_id: null });
      expect(rows[0].rule).toEqual(likedRule());
      const themes = await pool.query('SELECT theme_key, title, playlist_id FROM auto_playlist_themes WHERE owner_user = $1', [MIKE]);
      expect(themes.rows).toEqual([{ theme_key: 'liked', title: 'Mi piace', playlist_id: rows[0].id }]);
    });

    it('is ONE per person even when two likes arrive together: the unique index decides, the loser gets the winner back', async () => {
      const [a, b] = await Promise.all([ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-10T20:00:00Z') }), ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-10T20:00:00Z') })]);
      expect(await likedRows(MIKE)).toHaveLength(1);
      expect((a as { id: string }).id).toBe((b as { id: string }).id);
      expect([a.status, b.status].sort()).toEqual(expect.arrayContaining(['made']));
      // and a third like, later, finds it
      expect((await ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-11T08:00:00Z') })).status).toBe('there');
      expect(await likedRows(MIKE)).toHaveLength(1);
    });

    it('is each person\'s own', async () => {
      await ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-10T20:00:00Z') });
      await ensureLikedPlaylist(store, { owner: SARA, at: at('2026-11-10T20:01:00Z') });
      expect(await likedRows(MIKE)).toHaveLength(1);
      expect(await likedRows(SARA)).toHaveLength(1);
      expect((await likedRows(MIKE))[0].id).not.toBe((await likedRows(SARA))[0].id);
    });

    it('is never made again when the person deletes it: the theme stays in the registry with no playlist, and the other person is not touched', async () => {
      await ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-10T20:00:00Z') });
      const sara = await ensureLikedPlaylist(store, { owner: SARA, at: at('2026-11-10T20:00:00Z') });
      const [mine] = await likedRows(MIKE);
      expect(await deletePlaylist(mine.id, MIKE)).toBe(true);
      const themes = await pool.query('SELECT playlist_id FROM auto_playlist_themes WHERE owner_user = $1 AND theme_key = $2', [MIKE, 'liked']);
      expect(themes.rows).toEqual([{ playlist_id: null }]);
      expect(await ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-12T08:00:00Z') })).toEqual({ status: 'skipped', reason: 'deleted' });
      expect(await likedRows(MIKE)).toHaveLength(0);
      expect((await likedRows(SARA))[0].id).toBe((sara as { id: string }).id);
    });

    it('holds the likes of the person, the most recently liked first, and counts them: a journal song, a file-only song, and none that is gone', async () => {
      await ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-10T20:00:00Z') });
      await putLike(MIKE, 'a::alpha', at('2026-11-01T10:00:00Z'));
      await putLike(MIKE, 'f::file-only', at('2026-11-02T10:00:00Z'));
      await putLike(MIKE, 'gone::song', at('2026-11-03T10:00:00Z'));
      await putLike(MIKE, 'b::bravo', at('2026-11-04T10:00:00Z'));
      await putLike(SARA, 'a::alpha', at('2026-11-09T10:00:00Z'));
      expect(await resolveDynamicSongKeys(likedRule(), { userId: MIKE }, at('2026-11-10T21:00:00Z'))).toEqual(['b::bravo', 'f::file-only', 'a::alpha']);
      expect(await resolveDynamicSongKeys(likedRule(), { userId: SARA }, at('2026-11-10T21:00:00Z'))).toEqual(['a::alpha']);
    });

    it('is in the list the apps read, dynamic, with its rule in words and the number of songs of the person (what an old app draws, and what the site draws)', async () => {
      await ensureLikedPlaylist(store, { owner: MIKE, at: at('2026-11-10T20:00:00Z') });
      await putLike(MIKE, 'a::alpha', at('2026-11-01T10:00:00Z'));
      await putLike(MIKE, 'b::bravo', at('2026-11-04T10:00:00Z'));
      const viewer = { userId: MIKE, isAdmin: false };
      const list = await resolveSummaries(await listPlaylists(viewer), viewer);
      const mine = list.filter((p) => p.name === 'Mi piace');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ kind: 'dynamic', origin: 'auto', autoKind: 'theme', ruleSummary: 'Piaciuti di recente · max 200', songCount: 2 });
      // another person does not see it in her list
      const saraViewer = { userId: SARA, isAdmin: false };
      expect((await resolveSummaries(await listPlaylists(saraViewer), saraViewer)).filter((p) => p.name === 'Mi piace')).toEqual([]);
    });
  });

  describe('taking a song out of a playlist (the swipe «Togli dalla playlist»)', () => {
    const keysOf = async (id: string): Promise<string[]> => (await getPlaylist(id))?.songKeys ?? [];

    it('takes the song out of the playlist of its owner, keeps the others in their order, and says what is left', async () => {
      const made = await createPlaylist('ltest Rap', ['a::one', 'b::two', 'c::three'], MIKE);
      const after = await removeSongFromPlaylist(made.id, 'b::two', MIKE);
      expect(after?.songKeys).toEqual(['a::one', 'c::three']);
      expect(await keysOf(made.id)).toEqual(['a::one', 'c::three']);
    });

    it('is idempotent: taking out a song that is not there changes nothing and is no error', async () => {
      const made = await createPlaylist('ltest Rap', ['a::one'], MIKE);
      expect((await removeSongFromPlaylist(made.id, 'zzz::not there', MIKE))?.songKeys).toEqual(['a::one']);
      expect((await removeSongFromPlaylist(made.id, 'a::one', MIKE))?.songKeys).toEqual([]);
      expect((await removeSongFromPlaylist(made.id, 'a::one', MIKE))?.songKeys).toEqual([]);
    });

    it('is only for the owner: another person, a person it is only shared with, and a playlist that does not exist all get null (the route says 404), and nothing is taken out', async () => {
      const made = await createPlaylist('ltest Rap', ['a::one', 'b::two'], MIKE);
      await sharePlaylist(made.id, [SARA], MIKE);
      expect(await removeSongFromPlaylist(made.id, 'a::one', SARA)).toBeNull();
      expect(await removeSongFromPlaylist(made.id, 'a::one', 'ltest_nobody')).toBeNull();
      expect(await removeSongFromPlaylist('ltest-no-such-playlist', 'a::one', MIKE)).toBeNull();
      expect(await keysOf(made.id)).toEqual(['a::one', 'b::two']);
    });

    it('is only for a STATIC playlist: a dynamic one is a rule and refuses («playlist_is_dynamic», the route says 409), even for its owner', async () => {
      const dynamic = await createDynamicPlaylist('ltest Dyn', likedRule(), MIKE);
      await expect(removeSongFromPlaylist(dynamic.id, 'a::one', MIKE)).rejects.toThrow('playlist_is_dynamic');
    });

    it('takes out a key that has a «%» or an apostrophe in it exactly as it is stored (no decoding on the way)', async () => {
      const keys = ['100% pure::love', 'ac%41dc::back in black', "guns n' roses::don't cry", 'beyoncé::halo (50% live)'];
      const made = await createPlaylist('ltest Odd keys', keys, MIKE);
      for (const key of keys) await removeSongFromPlaylist(made.id, key, MIKE);
      expect(await keysOf(made.id)).toEqual([]);
    });

    it('a song put in with the POST (trimmed) is the one the DELETE takes out, the key being trimmed the same way', async () => {
      const made = await createPlaylist('ltest Rap', [], MIKE);
      await addSongToPlaylist(made.id, '  a::one  ', MIKE);
      expect(await keysOf(made.id)).toEqual(['a::one']);
      expect((await removeSongFromPlaylist(made.id, 'a::one', MIKE))?.songKeys).toEqual([]);
    });
  });
});
