/**
 * The database side of the automatic playlists, against a REAL Postgres (ADR-0023). Skipped unless `AUTOPL_INT=1`: it needs a throw-away
 * database that already has `init.sql` and the migrations applied, and the usual `DB_*` variables pointing at it (never production):
 *
 *   AUTOPL_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=autopl_check DB_USER=postgres DB_PASSWORD=… npx vitest run src/services/autoPlaylistStore.int.test.ts
 *
 * What the unit tests cannot see: the unique indexes, the positions in front of the others, the read order of a playlist, the foreign keys
 * that make a deleted playlist leave its theme without a playlist.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../utils/db';
import { PgAutoPlaylistStore } from './autoPlaylistStore';
import { MIN_SONGS, processEntry, type AutoPlaylistDeps } from './autoPlaylists';
import { deletePlaylist, getPlaylist, listPlaylists } from './playlists';
import type { Entry } from '../types';

const on = process.env.AUTOPL_INT === '1';
const d = on ? describe : describe.skip;

d('PgAutoPlaylistStore on a real database', () => {
  const store = new PgAutoPlaylistStore();
  const at = (iso: string) => new Date(iso);

  beforeEach(async () => {
    await pool.query(`DELETE FROM auto_playlist_runs`);
    await pool.query(`DELETE FROM auto_playlist_themes`);
    await pool.query(`DELETE FROM playlist_songs`);
    await pool.query(`DELETE FROM playlists`);
    await pool.query(`DELETE FROM entries`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('one playlist per theme, even when asked twice: the second gets the first back', async () => {
    const a = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'e1', createdAt: at('2026-11-01T10:00:00Z') });
    const b = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'e2', createdAt: at('2026-11-02T10:00:00Z') });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlists`)).rows[0].n).toBe(1);
    expect(await store.listThemes('mike')).toEqual([{ themeKey: 'ascoltare jazz', title: 'Jazz da ascoltare', playlistId: a.id }]);
    // another user has his own
    const c = await store.createPlaylist({ owner: 'sara', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'e3', createdAt: at('2026-11-02T10:00:00Z') });
    expect(c.created).toBe(true);
    expect(c.id).not.toBe(a.id);
  });

  it('one playlist per post for a precise title; two posts with the same title are two playlists', async () => {
    const a = await store.createPlaylist({ owner: 'mike', name: 'Le 5 musiche di Natale', kind: 'one_off', themeKey: null, sourceEntryId: 'e1', createdAt: at('2026-11-01T10:00:00Z') });
    const again = await store.createPlaylist({ owner: 'mike', name: 'Le 5 musiche di Natale', kind: 'one_off', themeKey: null, sourceEntryId: 'e1', createdAt: at('2026-11-01T10:00:00Z') });
    const other = await store.createPlaylist({ owner: 'mike', name: 'Le 5 musiche di Natale', kind: 'one_off', themeKey: null, sourceEntryId: 'e2', createdAt: at('2026-11-09T10:00:00Z') });
    expect(again).toEqual({ id: a.id, created: false });
    expect(other.created).toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlists WHERE auto_kind = 'one_off'`)).rows[0].n).toBe(2);
  });

  it('two runs at the same moment make ONE theme (the index decides)', async () => {
    const input = (e: string) => ({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme' as const, themeKey: 'ascoltare jazz', sourceEntryId: e, createdAt: at('2026-11-01T10:00:00Z') });
    const [x, y] = await Promise.all([store.createPlaylist(input('e1')), store.createPlaylist(input('e2'))]);
    expect(x.id).toBe(y.id);
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1);
  });

  it('the playlist is a normal static one, of the user, marked automatic, with the date of the post', async () => {
    const made = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'e1', createdAt: at('2026-11-01T10:00:00Z') });
    const list = await listPlaylists({ userId: 'mike' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: made.id, name: 'Jazz da ascoltare', kind: 'static', ownerUser: 'mike', origin: 'auto', autoKind: 'theme', songCount: 0, createdAt: '2026-11-01T10:00:00.000Z' });
  });

  it('songs go in front of the ones that are there, in the order given, and the playlist READS in that order; never twice', async () => {
    const { id } = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'e1', createdAt: at('2026-11-01T10:00:00Z') });
    expect(await store.addSongs(id, ['a', 'b', 'c'], { front: false, addedAt: at('2026-11-01T10:00:00Z') })).toBe(3);
    expect(await store.addSongs(id, ['d', 'e', 'a'], { front: true, addedAt: at('2026-11-08T10:00:00Z') })).toBe(2);
    expect(await store.addSongs(id, ['d', 'e'], { front: true, addedAt: at('2026-11-09T10:00:00Z') })).toBe(0);
    expect(await store.addSongs(id, ['f'], { front: true, addedAt: at('2026-11-10T10:00:00Z') })).toBe(1);
    expect((await getPlaylist(id))?.songKeys).toEqual(['f', 'd', 'e', 'a', 'b', 'c']);
    expect((await listPlaylists({ userId: 'mike' }))[0].songCount).toBe(6);
  });

  it('adding to an empty playlist in front starts at the top, and a playlist with songs only at negative positions still works', async () => {
    const { id } = await store.createPlaylist({ owner: 'mike', name: 'T', kind: 'theme', themeKey: 't', sourceEntryId: 'e1', createdAt: at('2026-11-01T10:00:00Z') });
    expect(await store.addSongs(id, ['a', 'b'], { front: true, addedAt: at('2026-11-01T10:00:00Z') })).toBe(2);
    expect(await store.addSongs(id, ['c', 'd'], { front: true, addedAt: at('2026-11-02T10:00:00Z') })).toBe(2);
    expect(await store.addSongs(id, ['e'], { front: false, addedAt: at('2026-11-03T10:00:00Z') })).toBe(1);
    expect((await getPlaylist(id))?.songKeys).toEqual(['c', 'd', 'a', 'b', 'e']);
  });

  it('the date of the last change follows the post, never going back', async () => {
    const { id } = await store.createPlaylist({ owner: 'mike', name: 'T', kind: 'theme', themeKey: 't', sourceEntryId: 'e1', createdAt: at('2026-11-01T10:00:00Z') });
    await store.addSongs(id, ['a'], { front: false, addedAt: at('2026-11-08T10:00:00Z') });
    await store.addSongs(id, ['b'], { front: true, addedAt: at('2026-11-02T10:00:00Z') });
    expect((await listPlaylists({ userId: 'mike' }))[0].updatedAt).toBe('2026-11-08T10:00:00.000Z');
  });

  it('a playlist the user deletes leaves its theme WITHOUT a playlist (so it is not made again) and its runs without one', async () => {
    const { id } = await store.createPlaylist({ owner: 'mike', name: 'Jazz da ascoltare', kind: 'theme', themeKey: 'ascoltare jazz', sourceEntryId: 'e1', createdAt: at('2026-11-01T10:00:00Z') });
    await store.saveRun('e1', 'mike', { status: 'done', playlistId: id, reason: null });
    expect(await deletePlaylist(id)).toBe(true);
    expect(await store.listThemes('mike')).toEqual([{ themeKey: 'ascoltare jazz', title: 'Jazz da ascoltare', playlistId: null }]);
    expect(await store.getRun('e1', 'mike')).toEqual({ status: 'done', playlistId: null, reason: null });
  });

  it('runs: saved once per entry and user, updated in place', async () => {
    expect(await store.getRun('e1', 'mike')).toBeNull();
    await store.saveRun('e1', 'mike', { status: 'pending', playlistId: null, reason: 'no_title' });
    expect(await store.getRun('e1', 'mike')).toEqual({ status: 'pending', playlistId: null, reason: 'no_title' });
    await store.saveRun('e1', 'mike', { status: 'skipped', playlistId: null, reason: 'theme_deleted' });
    expect(await store.getRun('e1', 'mike')).toEqual({ status: 'skipped', playlistId: null, reason: 'theme_deleted' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM auto_playlist_runs`)).rows[0].n).toBe(1);
    expect(await store.getRun('e1', 'sara')).toBeNull();
  });

  it('end to end: three posts of a theme and one precise post, through the rules and the real database', async () => {
    const song = (title: string) => ({ title, artist: 'Various', album: null, source: 'ai_analysis', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });
    const entryRow = async (id: string, createdAt: string, titles: string[]): Promise<Entry> => {
      const results = { songs: titles.map(song), films: [], notes: [], links: [], tags: [], summary: 's' };
      await pool.query(
        `INSERT INTO entries (id, source_url, source_platform, input_channel, status, results, action_log, owner_user, created_at) VALUES ($1, $2, 'instagram', 'telegram', 'completed', $3::jsonb, '[]'::jsonb, 'mike', $4)`,
        [id, `https://www.instagram.com/reel/${id}/`, JSON.stringify(results), createdAt],
      );
      return { id, sourceUrl: `https://www.instagram.com/reel/${id}/`, ownerUser: 'mike', caption: 'x', results, createdAt } as unknown as Entry;
    };
    const plans = [
      { aboutMusic: true, title: 'Jazz da ascoltare', kind: 'theme' as const, existingTheme: null },
      { aboutMusic: true, title: 'Jazz da ascoltare', kind: 'theme' as const, existingTheme: 'Jazz da ascoltare' },
      { aboutMusic: true, title: 'Le 5 musiche di Natale', kind: 'one_off' as const, existingTheme: null },
      { aboutMusic: true, title: 'Jazz da ascoltare', kind: 'theme' as const, existingTheme: 'Jazz da ascoltare' },
    ];
    let i = 0;
    const announced: string[] = [];
    const deps: AutoPlaylistDeps = {
      store,
      getEntry: async () => null,
      title: async () => plans[i++],
      language: async () => 'it',
      announce: async (m) => { announced.push(`${m.title} | ${m.body}`); },
    };
    expect(MIN_SONGS).toBe(2);
    const e1 = await entryRow('e1', '2026-11-01T10:00:00Z', ['So What', 'Take Five']);
    const e2 = await entryRow('e2', '2026-11-05T10:00:00Z', ['Naima', 'Autumn Leaves']);
    const e3 = await entryRow('e3', '2026-11-06T10:00:00Z', ['Last Christmas', 'Jingle Bell Rock']);
    const e4 = await entryRow('e4', '2026-11-08T10:00:00Z', ['So What', 'Blue in Green']);
    for (const e of [e1, e2, e3, e4]) expect((await processEntry(e, deps)).status).toBe('done');

    const lists = await listPlaylists({ userId: 'mike' });
    expect(lists.map((p) => p.name).sort()).toEqual(['Jazz da ascoltare', 'Le 5 musiche di Natale']);
    const jazz = lists.find((p) => p.name === 'Jazz da ascoltare')!;
    expect(jazz).toMatchObject({ origin: 'auto', autoKind: 'theme', songCount: 5 });
    // the newest post first, each post in its own order, no song twice
    expect((await getPlaylist(jazz.id))?.songKeys).toEqual(['various::blue in green', 'various::naima', 'various::autumn leaves', 'various::so what', 'various::take five']);
    const xmas = lists.find((p) => p.name === 'Le 5 musiche di Natale')!;
    expect(xmas).toMatchObject({ autoKind: 'one_off', createdAt: '2026-11-06T10:00:00.000Z' });
    expect(announced).toEqual([
      'Nuova playlist: Jazz da ascoltare | 2 brani',
      'Jazz da ascoltare | +2 brani',
      'Nuova playlist: Le 5 musiche di Natale | 2 brani',
      'Jazz da ascoltare | +1 brano',
    ]);
    // a second pass changes nothing
    i = 0;
    for (const e of [e1, e2, e3, e4]) expect(await processEntry(e, deps)).toEqual({ status: 'skipped', reason: 'already_done' });
    expect((await listPlaylists({ userId: 'mike' })).length).toBe(2);
  });
});
