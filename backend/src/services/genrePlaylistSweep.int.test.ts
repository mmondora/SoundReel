/**
 * The daily genre-playlist sweep against a REAL Postgres (ADR-0024, spec §3.A.14). Skipped unless `AUTOPL_INT=1`: it needs a throw-away database that
 * already has `init.sql` and the migrations applied, and the usual `DB_*` variables pointing at it (never production): see `autoPlaylistStore.int.test.ts`.
 *
 *   AUTOPL_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=autopl_check DB_USER=postgres DB_PASSWORD=… npx vitest run --no-file-parallelism src/services/genrePlaylistSweep.int.test.ts
 *
 * What the unit tests cannot see: the unique index that makes two sweeps (or a sweep and a post) make ONE playlist, the row the sweep writes (dynamic, the
 * rule, no source post), the foreign key that turns a deleted playlist into a remembered deletion, the real library count and the real rule agreeing
 * (the playlist shows what the sweep counted), the owners that come from the entries, and the message in the Posta.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../utils/db';
import { PgAutoPlaylistStore } from './autoPlaylistStore';
import { processEntry, type AutoPlaylistDeps } from './autoPlaylists';
import { countGenreSongs } from './autoPlaylistWiring';
import { genreRule, genreThemeKey } from './genreThemes';
import { ensureGenrePlaylists, genreThemes, runGenreSweep, type GenreSweepDeps } from './genrePlaylistSweep';
import { listLibraryOwners, realGenreSweepDeps } from './genrePlaylistSweepWiring';
import { invalidateDynamicPlaylists, resolveDetail } from './playlistResolver';
import { deletePlaylist, getPlaylist, listPlaylists } from './playlists';
import { songKey } from './songMeta';
import { invalidateUserSongs } from './userSongs';
import type { Entry } from '../types';

const on = process.env.AUTOPL_INT === '1';
const d = on ? describe : describe.skip;

d('the genre-playlist sweep on a real database', () => {
  const store = new PgAutoPlaylistStore();
  const NOW = new Date('2026-11-11T03:00:00.000Z');
  const keyOf = (word: string): string => genreThemes().find((t) => t.word === word)!.key;
  let library: Record<string, number>;
  let said: Array<{ userId: string; title: string; body: string; entryId: string | null }>;

  const deps = (over: Partial<GenreSweepDeps> = {}): GenreSweepDeps => ({
    store,
    countGenreSongs: async (_owner, genres) => library[genreThemeKey(genres)] ?? 0,
    announce: async (item) => { said.push(item); },
    now: () => NOW,
    ...over,
  });

  beforeEach(async () => {
    library = {};
    said = [];
    invalidateUserSongs();
    invalidateDynamicPlaylists();
    await pool.query(`DELETE FROM inbox_items`);
    await pool.query(`DELETE FROM auto_playlist_runs`);
    await pool.query(`DELETE FROM auto_playlist_themes`);
    await pool.query(`DELETE FROM playlist_songs`);
    await pool.query(`DELETE FROM playlists`);
    await pool.query(`DELETE FROM song_meta`);
    await pool.query(`DELETE FROM entries`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertEntry(id: string, owner: string, songs: Array<[string, string]>, createdAt = '2026-11-01T10:00:00Z'): Promise<void> {
    const results = {
      songs: songs.map(([artist, title]) => ({ title, artist, album: null, source: 'ai_analysis', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false })),
      films: [], notes: [], links: [], tags: [], summary: 's',
    };
    await pool.query(
      `INSERT INTO entries (id, source_url, source_platform, input_channel, status, results, action_log, owner_user, created_at) VALUES ($1, $2, 'instagram', 'telegram', 'completed', $3::jsonb, '[]'::jsonb, $4, $5)`,
      [id, `https://www.instagram.com/reel/${id}/`, JSON.stringify(results), owner, createdAt],
    );
  }

  const withGenres = (artist: string, title: string, genres: string[]) => pool.query(`INSERT INTO song_meta (song_key, genres) VALUES ($1, $2)`, [songKey(artist, title), genres]);

  it('writes the playlist of a genre as the engine writes it: dynamic, automatic, the rule, the key, NO source post, the date of the sweep; the theme is registered', async () => {
    library = { [keyOf('Latina')]: 8 };
    const out = await ensureGenrePlaylists('mike', deps());
    expect(out.created).toBe(1);
    const id = out.items.find((i) => i.theme.word === 'Latina')!.playlistId!;
    const row = (await pool.query(`SELECT name, owner_user, kind, rule, origin, auto_kind, theme_key, source_entry_id, created_at FROM playlists WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ name: 'Latina da ascoltare', owner_user: 'mike', kind: 'dynamic', rule: genreRule(['Latina']), origin: 'auto', auto_kind: 'theme', theme_key: keyOf('Latina'), source_entry_id: null });
    expect(new Date(row.created_at).toISOString()).toBe(NOW.toISOString());
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlist_songs WHERE playlist_id = $1`, [id])).rows[0].n).toBe(0);
    expect(await store.listThemes('mike')).toEqual([{ themeKey: keyOf('Latina'), title: 'Latina da ascoltare', playlistId: id }]);
    const [read] = await listPlaylists({ userId: 'mike' });
    expect(read).toMatchObject({ kind: 'dynamic', origin: 'auto', autoKind: 'theme', rule: genreRule(['Latina']), ruleSummary: 'Aggiunte di recente · Latina · max 200' });
  });

  it('a second run changes nothing: the same playlist, no new row, no new message', async () => {
    library = { [keyOf('Latina')]: 8, [keyOf('Metal')]: 2 };
    await ensureGenrePlaylists('mike', deps());
    const before = (await pool.query(`SELECT id, created_at, updated_at FROM playlists ORDER BY id`)).rows;
    said.length = 0;
    const again = await ensureGenrePlaylists('mike', deps({ now: () => new Date(NOW.getTime() + 86_400_000) }));
    expect(again.created).toBe(0);
    expect(said).toEqual([]);
    expect((await pool.query(`SELECT id, created_at, updated_at FROM playlists ORDER BY id`)).rows).toEqual(before);
  });

  it('two sweeps at the same moment make ONE playlist and ONE message (the unique index decides; the other says «already there»)', async () => {
    library = { [keyOf('Latina')]: 8 };
    const [a, b] = await Promise.all([ensureGenrePlaylists('mike', deps()), ensureGenrePlaylists('mike', deps())]);
    expect(a.created + b.created).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlists`)).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM auto_playlist_themes`)).rows[0].n).toBe(1);
    expect(said).toHaveLength(1);
  });

  it('a playlist the user DELETES leaves the theme without a playlist: the next sweep says «deleted» and does not make it again', async () => {
    library = { [keyOf('Latina')]: 8 };
    const first = await ensureGenrePlaylists('mike', deps());
    const id = first.items.find((i) => i.theme.word === 'Latina')!.playlistId!;
    expect(await deletePlaylist(id)).toBe(true);
    expect(await store.listThemes('mike')).toEqual([{ themeKey: keyOf('Latina'), title: 'Latina da ascoltare', playlistId: null }]);
    said.length = 0;
    const again = await ensureGenrePlaylists('mike', deps());
    expect(again.created).toBe(0);
    expect(again.items.find((i) => i.theme.word === 'Latina')).toMatchObject({ action: 'skip', reason: 'deleted_by_user' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlists`)).rows[0].n).toBe(0);
    expect(said).toEqual([]);
  });

  it('a post of the theme that goes by AFTER the sweep joins the playlist and adds nothing; one that went by BEFORE made it and the sweep leaves it alone', async () => {
    library = { [keyOf('Latina')]: 8, [keyOf('Blues')]: 4 };
    // the sweep first: Latina
    await ensureGenrePlaylists('mike', deps({ countGenreSongs: async (_o, genres) => (genreThemeKey(genres) === keyOf('Latina') ? 8 : 0) }));
    const engine: AutoPlaylistDeps = {
      store,
      getEntry: async () => null,
      title: async (source) => ({ aboutMusic: true, title: source.songs.length > 1 ? 'Latina da ascoltare' : 'Blues da ascoltare', kind: 'theme', existingTheme: null }),
      language: async () => 'it',
      countGenreSongs: async (_o, genres) => library[genreThemeKey(genres)] ?? 0,
      announce: async () => undefined,
    };
    const song = (title: string) => ({ title, artist: 'Various', album: null, source: 'ai_analysis', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });
    const post = (id: string, titles: string[]): Entry =>
      ({ id, sourceUrl: `https://x/${id}`, ownerUser: 'mike', caption: 'c', createdAt: '2026-11-12T10:00:00Z', results: { songs: titles.map(song), films: [], notes: [], links: [], tags: [], summary: 's' } }) as unknown as Entry;
    const afterSweep = await processEntry(post('p1', ['Uno', 'Due']), engine);
    expect(afterSweep).toMatchObject({ status: 'done', created: false, added: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlists WHERE theme_key = $1`, [keyOf('Latina')])).rows[0].n).toBe(1);
    // the post first: Blues; the sweep then finds it there
    const blues = await processEntry(post('p2', ['Tre']), { ...engine, title: async () => ({ aboutMusic: true, title: 'Blues da ascoltare', kind: 'theme', existingTheme: null }) });
    expect(blues).toMatchObject({ status: 'done', created: true });
    const bluesId = (blues as { playlistId: string }).playlistId;
    const again = await ensureGenrePlaylists('mike', deps());
    expect(again.items.find((i) => i.theme.word === 'Blues')).toMatchObject({ action: 'skip', reason: 'has_playlist', playlistId: bluesId });
    expect((await pool.query(`SELECT count(*)::int AS n FROM playlists WHERE theme_key = $1`, [keyOf('Blues')])).rows[0].n).toBe(1);
  });

  it('the posts that WAITED for the genre are done with the playlist the sweep makes', async () => {
    await store.saveRun('w1', 'mike', { status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: keyOf('Metal') });
    await store.saveRun('w2', 'mike', { status: 'waiting', playlistId: null, reason: 'needs_two_songs', themeKey: keyOf('Punk') });
    library = { [keyOf('Metal')]: 2, [keyOf('Punk')]: 1 };
    const out = await ensureGenrePlaylists('mike', deps());
    const id = out.items.find((i) => i.theme.word === 'Metal')!.playlistId!;
    expect(await store.getRun('w1', 'mike')).toEqual({ status: 'done', playlistId: id, reason: null });
    expect(await store.getRun('w2', 'mike')).toMatchObject({ status: 'waiting', themeKey: keyOf('Punk') });
  });

  it('each owner has his own playlists, even for the same genre', async () => {
    library = { [keyOf('Latina')]: 8 };
    await ensureGenrePlaylists('mike', deps());
    await ensureGenrePlaylists('sara', deps());
    expect((await pool.query(`SELECT owner_user FROM playlists ORDER BY owner_user`)).rows.map((r) => r.owner_user)).toEqual(['mike', 'sara']);
  });

  it('the owners are the users who have entries, never «anonymous» and never an empty name', async () => {
    await insertEntry('e1', 'mike', [['A', 'a']]);
    await insertEntry('e2', 'sara', [['B', 'b']]);
    await insertEntry('e3', 'mike', [['C', 'c']]);
    await insertEntry('e4', 'anonymous', [['D', 'd']]);
    await insertEntry('e5', '', [['E', 'e']]);
    expect(await listLibraryOwners()).toEqual(['mike', 'sara']);
  });

  it('END TO END with the real library count, the real rule and the real inbox: the playlist shows exactly the songs the sweep counted, and the owner finds a message with no post', async () => {
    await insertEntry('e1', 'mike', [['Enrique', 'Bailando'], ['Don Omar', 'Danza Kuduro']], '2026-11-01T10:00:00Z');
    await insertEntry('e2', 'mike', [['Luis Fonsi', 'Despacito'], ['Daft Punk', 'One More Time']], '2026-11-05T10:00:00Z');
    await withGenres('Enrique', 'Bailando', ['Latina']);
    await withGenres('Don Omar', 'Danza Kuduro', ['Latina']);
    await withGenres('Luis Fonsi', 'Despacito', ['Pop']);                      // Pop has one song only: no playlist for it
    await withGenres('Daft Punk', 'One More Time', ['Elettronica']);           // Elettronica has one song only
    expect(await countGenreSongs('mike', ['Latina'])).toBe(2);
    const result = await runGenreSweep(realGenreSweepDeps());
    expect(result).toMatchObject({ owners: 1, created: 1, failed: 0 });
    const lists = await listPlaylists({ userId: 'mike' });
    expect(lists.map((p) => p.name)).toEqual(['Latina da ascoltare']);
    const detail = await resolveDetail((await getPlaylist(lists[0].id))!, { userId: 'mike' });
    expect(detail.songKeys.slice().sort()).toEqual([songKey('Don Omar', 'Danza Kuduro'), songKey('Enrique', 'Bailando')].sort());
    expect(detail.songCount).toBe(2);
    const inbox = (await pool.query(`SELECT user_id, kind, level, title, body, entry_id FROM inbox_items`)).rows;
    expect(inbox).toEqual([{ user_id: 'mike', kind: 'auto_playlist', level: 'info', title: 'Nuova playlist: Latina da ascoltare', body: '2 brani', entry_id: null }]);
    // a day later, nothing new
    invalidateUserSongs();
    expect(await runGenreSweep(realGenreSweepDeps())).toMatchObject({ created: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM inbox_items`)).rows[0].n).toBe(1);
  });

  it('a library with one song of a genre makes no playlist (a playlist has two songs), and a second song makes it the next day', async () => {
    await insertEntry('e1', 'mike', [['Enrique', 'Bailando']]);
    await withGenres('Enrique', 'Bailando', ['Latina']);
    expect(await runGenreSweep(realGenreSweepDeps())).toMatchObject({ created: 0 });
    await insertEntry('e2', 'mike', [['Don Omar', 'Danza Kuduro']], '2026-11-06T10:00:00Z');
    await withGenres('Don Omar', 'Danza Kuduro', ['Latina']);
    invalidateUserSongs();
    expect(await runGenreSweep(realGenreSweepDeps())).toMatchObject({ created: 1 });
    expect((await listPlaylists({ userId: 'mike' })).map((p) => p.name)).toEqual(['Latina da ascoltare']);
  });

  it('a manual playlist (origin user) is never touched, even one called like a genre', async () => {
    await pool.query(`INSERT INTO playlists (id, name, owner_user, kind, origin) VALUES ('mine', 'Latina da ascoltare', 'mike', 'static', 'user')`);
    await pool.query(`INSERT INTO playlist_songs (playlist_id, song_key, position) VALUES ('mine', 'z::1', 0)`);
    library = { [keyOf('Latina')]: 8 };
    await ensureGenrePlaylists('mike', deps());
    const mine = (await pool.query(`SELECT name, kind, origin, theme_key FROM playlists WHERE id = 'mine'`)).rows[0];
    expect(mine).toEqual({ name: 'Latina da ascoltare', kind: 'static', origin: 'user', theme_key: null });
    expect((await pool.query(`SELECT song_key FROM playlist_songs WHERE playlist_id = 'mine'`)).rows).toEqual([{ song_key: 'z::1' }]);
  });
});
