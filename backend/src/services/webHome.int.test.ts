/**
 * The front page of the site against a REAL Postgres (docs/web-home.md). Skipped unless `WEBHOME_INT=1`: it needs a throw-away database that
 * already has `init.sql` and the migrations applied, and the usual `DB_*` variables pointing at it (never production). It DELETES the
 * entries, playlists, song and film metadata of that database:
 *
 *   WEBHOME_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=webhome_check DB_USER=postgres DB_PASSWORD=… npx vitest run --no-file-parallelism src/services/webHome.int.test.ts
 *
 * What the unit tests cannot see: that the visibility really sits in the SQL the four sections read through (own, shared, and for an admin the
 * anonymous ones), that nothing of another user reaches the answer, that a rule's songs are really counted, and the route with the real sources.
 */
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../utils/db';
import { registerWebHomeRoute } from '../routes/webHome';
import { buildWebHome, type WebHomeResponse, type WebHomeSection, type WebHomeViewer } from './webHome';
import { realWebHomeDeps } from './webHomeData';
import { genreRule } from './genreThemes';
import { invalidateDynamicPlaylists } from './playlistResolver';
import { invalidateUserSongs } from './userSongs';
import { songKey } from './songMeta';

const on = process.env.WEBHOME_INT === '1';
const d = on ? describe : describe.skip;

const song = (artist: string, title: string) => ({ title, artist, source: 'ai_analysis' });
const results = (songs: ReturnType<typeof song>[], films: Array<{ title: string; year: string }> = []) =>
  JSON.stringify({ summary: null, tags: [], songs, films, notes: [], links: [] });

async function entry(id: string, owner: string, createdAt: string, songs: ReturnType<typeof song>[], films: Array<{ title: string; year: string }> = []): Promise<void> {
  await pool.query(
    `INSERT INTO entries (id, source_url, source_platform, input_channel, status, results, created_at, owner_user)
     VALUES ($1, $2, 'instagram', 'web', 'completed', $3::jsonb, $4, $5)`,
    [id, `https://www.instagram.com/reel/${id}/`, results(songs, films), createdAt, owner],
  );
}

async function list(id: string, name: string, owner: string, createdAt: string, extra: { kind?: string; rule?: unknown; origin?: string } = {}): Promise<void> {
  await pool.query(
    `INSERT INTO playlists (id, name, owner_user, created_at, updated_at, kind, rule, origin) VALUES ($1, $2, $3, $4, $4, $5, $6::jsonb, $7)`,
    [id, name, owner, createdAt, extra.kind ?? 'static', extra.rule === undefined ? null : JSON.stringify(extra.rule), extra.origin ?? 'user'],
  );
}

const sectionIds = (home: WebHomeResponse) => home.sections.map((s) => s.id);
const sectionOf = (home: WebHomeResponse, id: WebHomeSection['id']) => home.sections.find((s) => s.id === id);
const home = (viewer: WebHomeViewer) => buildWebHome(viewer, realWebHomeDeps());

d('the front page of the site on a real database', () => {
  beforeAll(async () => {
    for (const table of ['playlist_shares', 'playlist_songs', 'playlists', 'entry_shares', 'entries', 'song_meta', 'film_meta']) {
      await pool.query(`DELETE FROM ${table}`);
    }
    // mike: two posts of his own; sara: a private post, and one she shared with mike; the anonymous user: one post
    await entry('wh-m1', 'mike', '2026-03-03T10:00:00Z', [song('Alpha', 'One')], [{ title: 'Dune', year: '2021' }]);
    await entry('wh-m2', 'mike', '2026-03-01T10:00:00Z', [song('Beta', 'Two')]);
    await entry('wh-s1', 'sara', '2026-03-04T10:00:00Z', [song('Sara', 'Hers')], [{ title: 'Heat', year: '1995' }]);
    await entry('wh-s2', 'sara', '2026-03-05T10:00:00Z', [song('Shared', 'Song')]);
    await pool.query(`INSERT INTO entry_shares (entry_id, shared_with, shared_by) VALUES ('wh-s2', 'mike', 'sara')`);
    await entry('wh-a1', 'anonymous', '2026-03-02T10:00:00Z', [song('Anon', 'Song')], [{ title: 'Ghost', year: '1990' }]);
    // the song metadata: a cover for Alpha, and a genre that a rule can select
    await pool.query(`INSERT INTO song_meta (song_key, genres, cover_url) VALUES ($1, ARRAY['R&B/Soul'], 'https://img.example/alpha.jpg')`, [songKey('Alpha', 'One')]);
    // playlists: mike's two (one a rule), sara's private one, one of sara's shared with mike, one of the anonymous user
    await list('wh-pm1', 'Mike static', 'mike', '2026-02-01T00:00:00Z');
    await list('wh-pm2', 'Soul da ascoltare', 'mike', '2026-02-02T00:00:00Z', { kind: 'dynamic', rule: genreRule(['R&B/Soul']), origin: 'auto' });
    await list('wh-ps1', 'Sara private', 'sara', '2026-02-03T00:00:00Z');
    await list('wh-ps2', 'Sara shared with Mike', 'sara', '2026-02-04T00:00:00Z');
    await pool.query(`INSERT INTO playlist_shares (playlist_id, shared_with, shared_by) VALUES ('wh-ps2', 'mike', 'sara')`);
    await list('wh-pa1', 'Anon list', 'anonymous', '2026-02-05T00:00:00Z');
    invalidateDynamicPlaylists();
    invalidateUserSongs();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('Michele sees his own posts and the one Sara shared with him, newest first, and nothing private of Sara or of the anonymous user', async () => {
    const h = await home({ userId: 'mike', isAdmin: false });
    expect(sectionIds(h)).toEqual(['resume', 'songs', 'playlists', 'films']);
    const resume = sectionOf(h, 'resume') as Extract<WebHomeSection, { id: 'resume' }>;
    expect(resume.items.map((r) => r.id)).toEqual(['wh-s2', 'wh-m1', 'wh-m2']);
    expect(resume.total).toBe(3);
    const songs = sectionOf(h, 'songs') as Extract<WebHomeSection, { id: 'songs' }>;
    expect(songs.items.map((s) => s.title)).toEqual(['Song', 'One', 'Two']);
    expect(songs.items.map((s) => s.artist)).toEqual(['Shared', 'Alpha', 'Beta']);
    expect(songs.total).toBe(3);
    const films = sectionOf(h, 'films') as Extract<WebHomeSection, { id: 'films' }>;
    expect(films.items.map((f) => f.title)).toEqual(['Dune']);
    const text = JSON.stringify(h);
    for (const secret of ['wh-s1', 'wh-a1', 'Hers', 'Heat', 'Ghost', 'Sara private', 'Anon list']) expect(text).not.toContain(secret);
  });

  it('the cover and the post of a song come from its metadata and its newest post', async () => {
    const songs = sectionOf(await home({ userId: 'mike', isAdmin: false }), 'songs') as Extract<WebHomeSection, { id: 'songs' }>;
    const alpha = songs.items.find((s) => s.title === 'One');
    expect(alpha).toEqual({
      songKey: 'alpha::one', title: 'One', artist: 'Alpha', coverUrl: 'https://img.example/alpha.jpg',
      entryId: 'wh-m1', sourceUrl: 'https://www.instagram.com/reel/wh-m1/', createdAt: '2026-03-03T10:00:00.000Z',
    });
    expect(songs.items.find((s) => s.title === 'Two')?.coverUrl).toBeNull();
  });

  it('the playlists are the ones Michele reads (his and the one shared with him), the newest created first, a rule counted for real', async () => {
    const playlists = sectionOf(await home({ userId: 'mike', isAdmin: false }), 'playlists') as Extract<WebHomeSection, { id: 'playlists' }>;
    expect(playlists.items.map((p) => p.id)).toEqual(['wh-ps2', 'wh-pm2', 'wh-pm1']);
    expect(playlists.total).toBe(3);
    const rule = playlists.items.find((p) => p.id === 'wh-pm2');
    // the rule selects every song of Michele's library with the genre: Alpha's, and no other
    expect(rule).toMatchObject({ kind: 'dynamic', origin: 'auto', songCount: 1, ownerUser: 'mike' });
    expect(rule?.ruleSummary).toContain('R&B/Soul');
    expect(playlists.items.find((p) => p.id === 'wh-ps2')).toMatchObject({ kind: 'static', origin: 'user', ownerUser: 'sara', songCount: 0 });
  });

  it('Sara sees her own and what she shared, never Michele\'s', async () => {
    const h = await home({ userId: 'sara', isAdmin: false });
    expect((sectionOf(h, 'resume') as Extract<WebHomeSection, { id: 'resume' }>).items.map((r) => r.id)).toEqual(['wh-s2', 'wh-s1']);
    expect((sectionOf(h, 'songs') as Extract<WebHomeSection, { id: 'songs' }>).items.map((s) => s.artist)).toEqual(['Shared', 'Sara']);
    expect((sectionOf(h, 'films') as Extract<WebHomeSection, { id: 'films' }>).items.map((f) => f.title)).toEqual(['Heat']);
    expect((sectionOf(h, 'playlists') as Extract<WebHomeSection, { id: 'playlists' }>).items.map((p) => p.id)).toEqual(['wh-ps2', 'wh-ps1']);
    const text = JSON.stringify(h);
    for (const secret of ['wh-m1', 'wh-m2', 'Alpha', 'Beta', 'Dune', 'Mike static', 'Soul da ascoltare', 'wh-a1']) expect(text).not.toContain(secret);
  });

  it('the anonymous user sees only what is anonymous', async () => {
    const h = await home({ userId: 'anonymous', isAdmin: false });
    expect((sectionOf(h, 'resume') as Extract<WebHomeSection, { id: 'resume' }>).items.map((r) => r.id)).toEqual(['wh-a1']);
    expect((sectionOf(h, 'films') as Extract<WebHomeSection, { id: 'films' }>).items.map((f) => f.title)).toEqual(['Ghost']);
    expect((sectionOf(h, 'playlists') as Extract<WebHomeSection, { id: 'playlists' }>).items.map((p) => p.id)).toEqual(['wh-pa1']);
    expect(JSON.stringify(h)).not.toMatch(/wh-m|wh-s|Alpha|Sara/);
  });

  it('an admin sees the anonymous posts, films and playlists too, as the lists of the site show them (and still not Sara\'s private ones)', async () => {
    const h = await home({ userId: 'mike', isAdmin: true });
    const resume = sectionOf(h, 'resume') as Extract<WebHomeSection, { id: 'resume' }>;
    expect(resume.items.map((r) => r.id)).toEqual(['wh-s2', 'wh-m1', 'wh-a1', 'wh-m2']);
    expect(resume.total).toBe(4);
    expect((sectionOf(h, 'films') as Extract<WebHomeSection, { id: 'films' }>).items.map((f) => f.title).sort()).toEqual(['Dune', 'Ghost']);
    expect((sectionOf(h, 'playlists') as Extract<WebHomeSection, { id: 'playlists' }>).items.map((p) => p.id)).toEqual(['wh-pa1', 'wh-ps2', 'wh-pm2', 'wh-pm1']);
    expect(JSON.stringify(h)).not.toMatch(/wh-s1|Hers|Heat|Sara private/);
  });

  it('a member of the family with nothing of their own and nothing shared gets an empty Home, not an error', async () => {
    expect(await home({ userId: 'archi', isAdmin: false })).toEqual({ sections: [] });
  });

  it('the route answers the same, from the Authelia user alone, and never from the query', async () => {
    const app = Fastify();
    registerWebHomeRoute(app);
    const asMike = await app.inject({ method: 'GET', url: '/api/home?user=sara', headers: { 'remote-user': 'mike' } });
    expect(asMike.statusCode).toBe(200);
    expect(asMike.headers['cache-control']).toBe('no-store');
    const body = asMike.json() as WebHomeResponse;
    expect(sectionIds(body)).toEqual(['resume', 'songs', 'playlists', 'films']);
    expect(JSON.stringify(body)).not.toContain('Hers');
    const anonymous = await app.inject({ method: 'GET', url: '/api/home' });
    expect(anonymous.statusCode).toBe(200);
    expect(JSON.stringify(anonymous.json())).not.toContain('Alpha');
    const nobody = await app.inject({ method: 'GET', url: '/api/home', headers: { 'remote-user': 'archi' } });
    expect(nobody.json()).toEqual({ sections: [] });
  });
});
