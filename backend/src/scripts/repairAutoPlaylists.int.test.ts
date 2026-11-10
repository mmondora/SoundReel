/**
 * The repair of the automatic playlists against a REAL Postgres (ADR-0024). Skipped unless `AUTOPL_INT=1` (a throw-away database with `init.sql`
 * and the migrations applied, `DB_*` pointing at it, never production): see `autoPlaylistStore.int.test.ts`.
 *
 * What the unit tests cannot see: the transactions, the order that keeps a taken-apart theme from reading as «deleted by the user», the runs
 * that wait or follow a merge, and that a playlist made BY HAND is never touched.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../utils/db';
import { PgAutoPlaylistStore } from '../services/autoPlaylistStore';
import { processEntry, type AutoPlaylistDeps } from '../services/autoPlaylists';
import { themeKey } from '../services/autoPlaylistTitle';
import { genreRule } from '../services/genreThemes';
import { getPlaylist, listPlaylists } from '../services/playlists';
import type { Entry } from '../types';
import { pgRepairDeps, repairAutoPlaylists, type PgLike } from './repairAutoPlaylists';

const on = process.env.AUTOPL_INT === '1';
const d = on ? describe : describe.skip;

d('repairAutoPlaylists on a real database', () => {
  const store = new PgAutoPlaylistStore();
  const library: Record<string, number> = { 'R&B/Soul': 30, Folk: 3, 'Hip-Hop/Rap': 40 };
  const lines: string[] = [];
  const deps = () => pgRepairDeps(pool as unknown as PgLike, { countGenreSongs: async (_o, genres) => genres.reduce((n, g) => n + (library[g] ?? 0), 0), say: (l) => lines.push(l) });

  /** A playlist as the OLD engine (2.20.1) made it: static, automatic, with the songs of the posts. */
  async function seedAuto(id: string, name: string, themeKey: string | null, songs: string[], opts: { kind?: 'theme' | 'one_off'; owner?: string } = {}): Promise<void> {
    const kind = opts.kind ?? 'theme';
    const owner = opts.owner ?? 'mike';
    await pool.query(
      `INSERT INTO playlists (id, name, owner_user, kind, origin, auto_kind, theme_key, source_entry_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'static', 'auto', $4, $5, $6, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z')`,
      [id, name, owner, kind, themeKey, `src-${id}`],
    );
    for (const [i, key] of songs.entries()) await pool.query(`INSERT INTO playlist_songs (playlist_id, song_key, position) VALUES ($1, $2, $3)`, [id, key, i]);
    if (kind === 'theme' && themeKey) await pool.query(`INSERT INTO auto_playlist_themes (owner_user, theme_key, title, playlist_id) VALUES ($1, $2, $3, $4)`, [owner, themeKey, name, id]);
    await pool.query(`INSERT INTO auto_playlist_runs (entry_id, owner_user, status, playlist_id) VALUES ($1, $2, 'done', $3)`, [`src-${id}`, owner, id]);
  }

  beforeEach(async () => {
    lines.length = 0;
    await pool.query(`DELETE FROM auto_playlist_runs`);
    await pool.query(`DELETE FROM auto_playlist_themes`);
    await pool.query(`DELETE FROM playlist_songs`);
    await pool.query(`DELETE FROM playlists`);
    await pool.query(`DELETE FROM entries`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedLibrary(): Promise<void> {
    await seedAuto('soul', 'Soul da ascoltare', 'ascoltare soul', ['a::1', 'b::2']);
    await seedAuto('folk', 'Folk da ascoltare', 'ascoltare folk', ['c::3']);
    await seedAuto('lofi', 'Lo-fi da ascoltare', themeKey('Lo-fi da ascoltare'), ['d::4']);
    await seedAuto('synth', 'Synthwave da ascoltare', 'ascoltare synthwave', ['e::5', 'f::6', 'g::7']);
    await seedAuto('hip', 'Hip hop da ascoltare', 'ascoltare hip hop', ['h::8', 'i::9', 'j::10']);
    await seedAuto('rap', 'Rap da ascoltare', 'ascoltare rap', ['k::11', 'l::12']);
    await seedAuto('xmas', 'Le 5 musiche di Natale', null, ['m::13'], { kind: 'one_off' });
    // a playlist made BY HAND with one song: nobody's business but the user's
    await pool.query(`INSERT INTO playlists (id, name, owner_user, kind, origin) VALUES ('mine', 'La mia', 'mike', 'static', 'user')`);
    await pool.query(`INSERT INTO playlist_songs (playlist_id, song_key, position) VALUES ('mine', 'z::99', 0)`);
  }

  it('the preview writes nothing at all', async () => {
    await seedLibrary();
    const before = JSON.stringify([
      (await pool.query(`SELECT * FROM playlists ORDER BY id`)).rows,
      (await pool.query(`SELECT * FROM playlist_songs ORDER BY playlist_id, song_key`)).rows,
      (await pool.query(`SELECT * FROM auto_playlist_runs ORDER BY entry_id`)).rows,
      (await pool.query(`SELECT * FROM auto_playlist_themes ORDER BY theme_key`)).rows,
    ]);
    const summary = await repairAutoPlaylists(deps(), { apply: false });
    expect(summary).toEqual({ total: 7, kept: 1, toDynamic: 3, merged: 1, dismantled: 2 });
    const after = JSON.stringify([
      (await pool.query(`SELECT * FROM playlists ORDER BY id`)).rows,
      (await pool.query(`SELECT * FROM playlist_songs ORDER BY playlist_id, song_key`)).rows,
      (await pool.query(`SELECT * FROM auto_playlist_runs ORDER BY entry_id`)).rows,
      (await pool.query(`SELECT * FROM auto_playlist_themes ORDER BY theme_key`)).rows,
    ]);
    expect(after).toBe(before);
  });

  it('--apply: genre themes become rules, the small ones are taken apart, the doubles are merged, and the one made by hand is NOT touched', async () => {
    await seedLibrary();
    expect(await repairAutoPlaylists(deps(), { apply: true })).toEqual({ total: 7, kept: 1, toDynamic: 3, merged: 1, dismantled: 2 });

    // Soul and Folk (one song!) and Hip hop: dynamic, the rule of their genre, no songs of their own, same playlist id and same name
    const soul = (await pool.query(`SELECT name, kind, rule, theme_key FROM playlists WHERE id = 'soul'`)).rows[0];
    expect(soul).toEqual({ name: 'Soul da ascoltare', kind: 'dynamic', rule: genreRule(['R&B/Soul']), theme_key: 'genre:R&B/Soul' });
    expect((await pool.query(`SELECT kind, theme_key FROM playlists WHERE id = 'folk'`)).rows[0]).toEqual({ kind: 'dynamic', theme_key: 'genre:Folk' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlist_songs WHERE playlist_id IN ('soul','folk','hip')`)).rows[0].n).toBe(0);
    // the theme registry follows (same playlist, the key of the genre), and nothing reads as «deleted by the user»
    expect(await store.listThemes('mike')).toEqual(
      expect.arrayContaining([
        { themeKey: 'genre:R&B/Soul', title: 'Soul da ascoltare', playlistId: 'soul' },
        { themeKey: 'genre:Folk', title: 'Folk da ascoltare', playlistId: 'folk' },
        { themeKey: 'genre:Hip-Hop/Rap', title: 'Hip hop da ascoltare', playlistId: 'hip' },
        { themeKey: 'ascoltare synthwave', title: 'Synthwave da ascoltare', playlistId: 'synth' },
      ]),
    );
    expect((await store.listThemes('mike')).filter((t) => t.playlistId === null)).toEqual([]);

    // the playlist of ONE song with no tag is gone with its theme; its post waits on the theme; the same for the one-off with one song
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlists WHERE id IN ('lofi','xmas','rap')`)).rows[0].n).toBe(0);
    expect(await store.getRun('src-lofi', 'mike')).toEqual({ status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: themeKey('Lo-fi da ascoltare') });
    expect(await store.listWaiting('mike', themeKey('Lo-fi da ascoltare'))).toEqual(['src-lofi']);
    expect(await store.getRun('src-xmas', 'mike')).toEqual({ status: 'skipped', playlistId: null, reason: 'dismantled_too_small' });
    // «Rap» was merged into «Hip hop»: its post now belongs to that playlist
    expect(await store.getRun('src-rap', 'mike')).toEqual({ status: 'done', playlistId: 'hip', reason: null });
    // Synthwave (three songs, no tag) is as it was
    expect((await getPlaylist('synth'))?.songKeys).toEqual(['e::5', 'f::6', 'g::7']);
    // the one made by hand, with ONE song, is not touched
    expect((await getPlaylist('mine'))?.songKeys).toEqual(['z::99']);
    const mine = (await listPlaylists({ userId: 'mike' })).find((p) => p.id === 'mine');
    expect(mine).toMatchObject({ kind: 'static', songCount: 1 });
    expect(mine).not.toHaveProperty('origin'); // made by hand: no «automatic» label
  });

  it('a second run changes nothing (idempotent)', async () => {
    await seedLibrary();
    await repairAutoPlaylists(deps(), { apply: true });
    lines.length = 0;
    expect(await repairAutoPlaylists(deps(), { apply: true })).toEqual({ total: 4, kept: 4, toDynamic: 0, merged: 0, dismantled: 0 });
  });

  it('a theme taken apart is reborn when a second song comes: the playlist has both, and the post that waited is done', async () => {
    await seedLibrary();
    await repairAutoPlaylists(deps(), { apply: true });
    const song = (title: string, artist: string) => ({ title, artist, album: null, source: 'audio_fingerprint', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });
    const first = { id: 'src-lofi', sourceUrl: 'https://x/1', ownerUser: 'mike', caption: 'x', createdAt: '2026-10-01T10:00:00Z', results: { songs: [song('Four', 'd')], films: [], notes: [], links: [], tags: [], summary: 's' } } as unknown as Entry;
    const second = { id: 'new-lofi', sourceUrl: 'https://x/2', ownerUser: 'mike', caption: 'x', createdAt: '2026-11-10T10:00:00Z', results: { songs: [song('Five', 'n')], films: [], notes: [], links: [], tags: [], summary: 's' } } as unknown as Entry;
    const aDeps: AutoPlaylistDeps = {
      store,
      getEntry: async (id) => (id === first.id ? first : null),
      title: async () => ({ aboutMusic: true, title: 'Lo-fi da ascoltare', kind: 'theme' as const, existingTheme: null }),
      language: async () => 'it',
      countGenreSongs: async () => 0,
      announce: async () => undefined,
    };
    const out = await processEntry(second, aDeps);
    expect(out).toMatchObject({ status: 'done', created: true, added: 2 });
    if (out.status !== 'done') throw new Error('x');
    expect((await getPlaylist(out.playlistId))?.songKeys).toEqual(['n::five', 'd::four']);
    expect(await store.getRun('src-lofi', 'mike')).toEqual({ status: 'done', playlistId: out.playlistId, reason: null });
  });
});
