import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route is tested with the REAL rules (services/webHome) and stand-in sources: what is asked is who the viewer is, what comes back is
// what the rules make of the sources. The real sources have their own wiring test (services/webHomeData.test.ts).
const sources = vi.hoisted(() => ({
  made: 0,
  failToMake: false,
  deps: null as unknown as import('../services/webHome').WebHomeDeps,
}));
vi.mock('../services/webHomeData', () => ({
  realWebHomeDeps: () => {
    if (sources.failToMake) throw new Error('cannot make the sources');
    sources.made++;
    return sources.deps;
  },
}));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import { registerWebHomeRoute } from './webHome';
import { logError, logWarning } from '../utils/logger';
import type { WebHomeDeps } from '../services/webHome';
import type { AggregatedSong, EntrySummaryRow } from '../types';

const row = (id: string): EntrySummaryRow => ({
  id, sourceUrl: `https://www.instagram.com/reel/${id}/`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed',
  createdAt: '2026-03-01T10:00:00.000Z', summary: 'Un post', songCount: 1, filmCount: 0, noteCount: 0, tags: [],
});
const aSong = (key: string): AggregatedSong => ({
  songKey: key, title: key, artist: 'Artist', album: null, youtubeUrl: null, spotifyUrl: null,
  mentions: [{ entryId: 'e1', createdAt: '2026-03-01T10:00:00.000Z', sourceUrl: null, sourcePlatform: 'instagram' }], meta: null, inLibrary: false,
});

/** Sources that answer for the viewer they are given and write down who that was. */
function stand(over: Partial<WebHomeDeps> = {}): { deps: WebHomeDeps; viewers: Array<{ userId: string; isAdmin: boolean }> } {
  const viewers: Array<{ userId: string; isAdmin: boolean }> = [];
  const note = <T>(value: T) => (viewer: { userId: string; isAdmin: boolean }): Promise<T> => {
    viewers.push(viewer);
    return Promise.resolve(value);
  };
  const deps: WebHomeDeps = {
    posts: async (viewer) => { viewers.push(viewer); return { items: [row(`post-of-${viewer.userId}`)], total: 1 }; },
    songs: note([aSong('a::one')]),
    films: note([]),
    playlists: note([]),
    resolvePlaylists: async (list) => list,
    ...over,
  };
  return { deps, viewers };
}

const app = () => {
  const a = Fastify();
  registerWebHomeRoute(a);
  return a;
};
const get = (headers: Record<string, string> = {}, url = '/api/home') => app().inject({ method: 'GET', url, headers });

beforeEach(() => {
  vi.clearAllMocks();
  sources.made = 0;
  sources.failToMake = false;
  sources.deps = stand().deps;
});

describe('GET /api/home', () => {
  it('answers the sections of the viewer, ready to draw', async () => {
    const res = await get({ 'remote-user': 'mike' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body)).toEqual(['sections']);
    expect(body.sections.map((s: { id: string }) => s.id)).toEqual(['resume', 'songs']);
    expect(body.sections[0]).toEqual({ id: 'resume', total: 1, items: [row('post-of-mike')] });
    expect(body.sections[1].items[0]).toMatchObject({ songKey: 'a::one', entryId: 'e1' });
  });

  it('is never cached: the same tab asks again after a post arrived', async () => {
    const res = await get({ 'remote-user': 'mike' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('an empty library answers 200 and no section', async () => {
    sources.deps = stand({ posts: async () => ({ items: [], total: 0 }), songs: async () => [] }).deps;
    const res = await get({ 'remote-user': 'mike' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sections: [] });
  });

  it('makes a new set of sources for every request: nothing is shared between two requests', async () => {
    await get({ 'remote-user': 'mike' });
    await get({ 'remote-user': 'sara' });
    expect(sources.made).toBe(2);
  });
});

describe('who the viewer is: the Authelia user and nothing else', () => {
  it.each([
    ['mike', { 'remote-user': 'mike' }, { userId: 'mike', isAdmin: false }],
    ['archi', { 'remote-user': 'archi' }, { userId: 'archi', isAdmin: false }],
    ['a user written in capitals', { 'remote-user': 'SARA' }, { userId: 'sara', isAdmin: false }],
    ['an admin', { 'remote-user': 'mike', 'remote-groups': 'users,admins' }, { userId: 'mike', isAdmin: true }],
    ['a user of the family groups only', { 'remote-user': 'sara', 'remote-groups': 'family' }, { userId: 'sara', isAdmin: false }],
  ])('%s', async (_label, headers, expected) => {
    const { deps, viewers } = stand();
    sources.deps = deps;
    await get(headers);
    expect(viewers.length).toBeGreaterThan(0);
    expect(viewers.every((v) => v.userId === expected.userId && v.isAdmin === expected.isAdmin)).toBe(true);
  });

  it('no Remote-User is the anonymous user, never an admin (the same as the lists of the site: no 401, nothing invented)', async () => {
    const { deps, viewers } = stand();
    sources.deps = deps;
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(viewers.length).toBeGreaterThan(0);
    expect(viewers.every((v) => v.userId === 'anonymous' && v.isAdmin === false)).toBe(true);
    // the admin group without a user does not make an admin
    viewers.length = 0;
    await get({ 'remote-groups': 'admins' });
    expect(viewers.length).toBeGreaterThan(0);
    expect(viewers.every((v) => v.userId === 'anonymous' && v.isAdmin === false)).toBe(true);
  });

  it('a user the family does not know is the anonymous user too', async () => {
    const { deps, viewers } = stand();
    sources.deps = deps;
    await get({ 'remote-user': 'stranger' });
    expect(viewers.length).toBeGreaterThan(0);
    expect(viewers.every((v) => v.userId === 'anonymous' && v.isAdmin === false)).toBe(true);
  });

  it('never reads a user from the query, the body or another header: a request as Michele is Michele\'s whatever it names', async () => {
    const { deps, viewers } = stand();
    sources.deps = deps;
    const res = await get(
      { 'remote-user': 'mike', 'x-soundreel-user': 'sara', 'x-soundreel-key': 'sr_other', 'x-user': 'sara', 'x-forwarded-user': 'sara' },
      '/api/home?user=sara&userId=sara&owner=sara&as=sara&isAdmin=true&admin=1',
    );
    expect(res.statusCode).toBe(200);
    expect(viewers.length).toBeGreaterThan(0);
    expect(viewers.every((v) => v.userId === 'mike' && v.isAdmin === false)).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain('sara');
  });

  it('answers each person with their own sections and not with another person\'s', async () => {
    const { deps } = stand();
    sources.deps = deps;
    const mine = (await get({ 'remote-user': 'mike' })).json();
    const hers = (await get({ 'remote-user': 'sara' })).json();
    expect(mine.sections[0].items[0].id).toBe('post-of-mike');
    expect(hers.sections[0].items[0].id).toBe('post-of-sara');
  });
});

describe('when something fails', () => {
  it('one section failing costs only itself: 200, the others answered, the failure in the log', async () => {
    sources.deps = stand({ songs: async () => { throw new Error('songs broke'); } }).deps;
    const res = await get({ 'remote-user': 'mike' });
    expect(res.statusCode).toBe(200);
    expect(res.json().sections.map((s: { id: string }) => s.id)).toEqual(['resume']);
    expect(logWarning).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it('every section failing is still an answer: 200 and no section', async () => {
    const boom = async () => { throw new Error('boom'); };
    sources.deps = stand({ posts: boom, songs: boom, films: boom, playlists: boom }).deps;
    const res = await get({ 'remote-user': 'mike' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sections: [] });
  });

  it('the Home that cannot be made at all says «home failed», logs it, and is still not cached', async () => {
    sources.failToMake = true;
    const res = await get({ 'remote-user': 'mike' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'home failed' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(logError).toHaveBeenCalledWith('GET /api/home failed', expect.anything());
  });
});

describe('what the route is not', () => {
  it('is a read: no POST, PUT, PATCH or DELETE, and no route that names another user', async () => {
    const a = app();
    const headers = { 'remote-user': 'mike' };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await a.inject({ method, url: '/api/home', headers, payload: {} })).statusCode).toBe(404);
    }
    expect((await a.inject({ method: 'GET', url: '/api/home/sara', headers })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/users/sara/home', headers })).statusCode).toBe(404);
  });
});

describe('the server', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

  it('registers the route (a route nobody registers is no route), once', () => {
    expect(server).toContain("import { registerWebHomeRoute } from './routes/webHome';");
    expect(server.match(/registerWebHomeRoute\(app\)/g)).toHaveLength(1);
  });

  it('registers it after /api/me, where the Authelia routes are, and not among the routers that bypass Authelia', () => {
    const lines = server.split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle) && !l.includes('import'));
    expect(at('registerWebHomeRoute(app)')).toBeGreaterThan(at('registerMeRoute(app)'));
    expect(at('registerWebHomeRoute(app)')).toBeGreaterThan(at('registerMondropRoutes(app)'));
    expect(at('registerWebHomeRoute(app)')).toBeGreaterThan(at('registerShareRoute(app)'));
  });

  it('the route file says why it must stay behind Authelia, and does not live under the bypass prefixes', () => {
    const route = fs.readFileSync(path.resolve(__dirname, './webHome.ts'), 'utf8');
    expect(route).toContain('auth-family');
    expect(route).toContain("'/api/home'");
    expect(route).not.toMatch(/app\.(get|post|put|patch|delete)\('\/api\/(mondrop|share)/);
  });
});
