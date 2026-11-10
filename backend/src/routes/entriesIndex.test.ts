import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The list of posts a page at a time with the filters, and the facets (docs/entries-index.md). The rules of the SQL have their own tests
// (services/entriesIndex.test.ts, and the integration test on a real database): here are the questions the route asks, who the viewer is, and what is
// answered.
const index = vi.hoisted(() => ({ list: vi.fn(), facets: vi.fn() }));
vi.mock('../services/entriesIndex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/entriesIndex')>()),
  listEntrySummariesFiltered: index.list,
  entryFacets: index.facets,
}));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import { entriesIndexFor, registerEntriesIndexRoutes } from './entriesIndex';
import { logError } from '../utils/logger';
import type { EntryFacets } from '../services/entriesIndex';

const VIS = { userId: 'mike', isAdmin: false };
const ROW = { id: 'e1', inputChannel: 'telegram', inputUser: null, category: null, verdict: null };
const FACETS: EntryFacets = {
  platforms: [{ platform: 'instagram', count: 900 }], channels: [{ channel: 'telegram', count: 1500 }], users: [{ user: 'mike', count: 1600 }],
  categories: [{ category: 'tech', count: 12 }], verdicts: [{ verdict: 'vero', count: 5 }], tags: [{ tag: '#vino', count: 15 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  index.list.mockResolvedValue({ items: [ROW], total: 1721 });
  index.facets.mockResolvedValue(FACETS);
});

describe('entriesIndexFor — the page the list of posts asks for', () => {
  it('without anything asked: 200 posts from the first, no filter, and the answer says what it gave', async () => {
    const answer = await entriesIndexFor({}, VIS);
    expect(index.list).toHaveBeenCalledWith(200, 0, VIS, {});
    expect(answer).toEqual({ status: 200, body: { entries: [ROW], total: 1721, limit: 200, offset: 0 } });
  });

  it('the Inbox asks 40 at a time, from where it is, with its filters', async () => {
    const answer = await entriesIndexFor({ view: 'summary', limit: '40', offset: '80', platform: 'tiktok', tag: '#vino' }, VIS);
    expect(index.list).toHaveBeenCalledWith(40, 80, VIS, { platform: 'tiktok', tag: '#vino' });
    expect(answer).toMatchObject({ status: 200, body: { limit: 40, offset: 80 } });
  });

  it('the answer has the keys of the old answer, in the same order', async () => {
    const answer = await entriesIndexFor({}, VIS);
    expect(answer.status === 200 && Object.keys(answer.body)).toEqual(['entries', 'total', 'limit', 'offset']);
  });

  it.each([
    ['too big', '5000', 1000],
    ['the biggest', '1000', 1000],
    ['one over', '1001', 1000],
    ['zero', '0', 1],
    ['negative', '-5', 1],
    ['the smallest', '1', 1],
    ['empty (as the lists of the site read it)', '', 1],
    ['decimal', '40.9', 40],
    ['infinite', 'Infinity', 1000],
  ])('a limit that is %s (%s) is brought into 1–1000, as the other lists do', async (_name, raw, expected) => {
    const answer = await entriesIndexFor({ limit: raw }, VIS);
    expect(index.list.mock.calls[0][0]).toBe(expected);
    expect(answer).toMatchObject({ status: 200, body: { limit: expected } });
  });

  it.each([
    ['negative', '-10', 0],
    ['zero', '0', 0],
    ['decimal', '12.7', 12],
    ['empty', '', 0],
    ['infinite', 'Infinity', Number.MAX_SAFE_INTEGER],
  ])('an offset that is %s is read as %s: never below 0, never a number the database cannot take', async (_name, raw, expected) => {
    const answer = await entriesIndexFor({ offset: raw }, VIS);
    expect(index.list.mock.calls[0][1]).toBe(expected);
    expect(answer).toMatchObject({ status: 200, body: { offset: expected } });
  });

  it.each([
    ['a limit that is not a number', { limit: 'abc' }, 'limit'],
    ['a limit given twice', { limit: ['1', '2'] }, 'limit'],
    ['an offset that is not a number', { offset: 'x' }, 'offset'],
    ['an offset given twice', { offset: ['1', '2'] }, 'offset'],
    ['a filter that is too long', { tag: 'a'.repeat(101) }, 'tag'],
    ['a filter given twice', { platform: ['a', 'b'] }, 'platform'],
  ])('%s is a 400 that names the field, and nothing is asked of the database', async (_name, query, field) => {
    const answer = await entriesIndexFor(query, VIS);
    expect(answer).toEqual({ status: 400, body: { error: `invalid_query:${field}` } });
    expect(index.list).not.toHaveBeenCalled();
  });

  it('when several things are wrong it names the limit first, then the offset, then the filters', async () => {
    expect(await entriesIndexFor({ limit: 'x', offset: 'y', tag: ['z'] }, VIS)).toEqual({ status: 400, body: { error: 'invalid_query:limit' } });
    expect(await entriesIndexFor({ offset: 'y', tag: ['z'] }, VIS)).toEqual({ status: 400, body: { error: 'invalid_query:offset' } });
    expect(await entriesIndexFor({ tag: ['z'] }, VIS)).toEqual({ status: 400, body: { error: 'invalid_query:tag' } });
  });

  it('the viewer is the one it is given and nothing in the query can change it: `user` is a filter on who SENT the post', async () => {
    await entriesIndexFor({ user: 'sara', userId: 'sara', isAdmin: 'true', owner: 'sara' }, { userId: 'mike', isAdmin: false });
    expect(index.list).toHaveBeenCalledWith(200, 0, { userId: 'mike', isAdmin: false }, { user: 'sara' });
  });

  it('a failure of the database is not swallowed here: the route that asks decides what to answer', async () => {
    index.list.mockRejectedValue(new Error('db down'));
    await expect(entriesIndexFor({}, VIS)).rejects.toThrow('db down');
  });
});

const app = () => {
  const a = Fastify();
  registerEntriesIndexRoutes(a);
  return a;
};
const facets = (headers: Record<string, string> = {}, url = '/api/entries/facets') => app().inject({ method: 'GET', url, headers });

describe('GET /api/entries/facets', () => {
  it('answers what the library holds, ready to draw', async () => {
    const res = await facets({ 'remote-user': 'mike' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(FACETS);
  });

  it('is never cached: the facets change when a post arrives', async () => {
    expect((await facets({ 'remote-user': 'mike' })).headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['mike', { 'remote-user': 'mike' }, { userId: 'mike', isAdmin: false }],
    ['a user written in capitals', { 'remote-user': 'SARA' }, { userId: 'sara', isAdmin: false }],
    ['an admin', { 'remote-user': 'mike', 'remote-groups': 'users,admins' }, { userId: 'mike', isAdmin: true }],
    ['a user of the family group only', { 'remote-user': 'sara', 'remote-groups': 'family' }, { userId: 'sara', isAdmin: false }],
    ['nobody (the anonymous user, never an admin, no 401)', {}, { userId: 'anonymous', isAdmin: false }],
    ['the admin group without a user', { 'remote-groups': 'admins' }, { userId: 'anonymous', isAdmin: false }],
  ])('reads the library of %s', async (_name, headers, viewer) => {
    const res = await facets(headers);
    expect(res.statusCode).toBe(200);
    expect(index.facets).toHaveBeenCalledWith(viewer);
  });

  it('the viewer is the Authelia user and nothing else: a user, an admin or a group in the query changes nothing', async () => {
    await facets({ 'remote-user': 'mike' }, '/api/entries/facets?user=sara&userId=sara&isAdmin=true&admin=1&groups=admins&remote-user=sara');
    expect(index.facets).toHaveBeenCalledWith({ userId: 'mike', isAdmin: false });
  });

  it('nor does any other header say who reads: only Remote-User does', async () => {
    await facets({ 'remote-user': 'mike', 'x-user': 'sara', 'x-forwarded-user': 'sara', 'x-remote-user': 'sara', 'x-forwarded-for': 'sara' });
    expect(index.facets).toHaveBeenCalledTimes(1);
    expect(index.facets).toHaveBeenCalledWith({ userId: 'mike', isAdmin: false });
  });

  it('a failure answers 500 with nothing of it in the body, and goes to the log', async () => {
    index.facets.mockRejectedValue(new Error('secret detail: db at 10.0.0.5 is down'));
    const res = await facets({ 'remote-user': 'mike' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'entries_failed' });
    expect(res.body).not.toContain('secret');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('is a read, and only this path: no other method, no path that names another user', async () => {
    const a = app();
    const headers = { 'remote-user': 'mike' };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await a.inject({ method, url: '/api/entries/facets', headers, payload: {} })).statusCode).toBe(404);
    }
    expect((await a.inject({ method: 'GET', url: '/api/entries/facets/sara', headers })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/entries', headers })).statusCode).toBe(404);   // the list itself is not here: routes/entries.ts asks `entriesIndexFor`
  });

  it('is found even where a route with a parameter, /api/entries/:id, was registered first (the static path wins)', async () => {
    const a = Fastify();
    a.get('/api/entries/:id', async () => ({ answered: 'the entry' }));
    registerEntriesIndexRoutes(a);
    const res = await a.inject({ method: 'GET', url: '/api/entries/facets', headers: { 'remote-user': 'mike' } });
    expect(res.json()).toEqual(FACETS);
  });

  it('takes the facets from the deps it is given, when it is given some', async () => {
    const a = Fastify();
    const mine = vi.fn(async () => ({ ...FACETS, tags: [] }));
    registerEntriesIndexRoutes(a, { facets: mine });
    const res = await a.inject({ method: 'GET', url: '/api/entries/facets', headers: { 'remote-user': 'sara' } });
    expect(res.json().tags).toEqual([]);
    expect(mine).toHaveBeenCalledWith({ userId: 'sara', isAdmin: false });
    expect(index.facets).not.toHaveBeenCalled();
  });
});

describe('the server', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
  // the code of the server without its comments, line for line: a registration that is commented out is no registration
  const lines = server
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''));
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle) && !/^\s*import\b/.test(l));

  it('registers the route (a route nobody registers is no route), once, next to the other routes of /api/entries', () => {
    expect(lines.join('\n')).toContain("import { registerEntriesIndexRoutes } from './routes/entriesIndex';");
    // counted in the code, not in its lines: two calls on one line are two registrations
    expect(lines.join('\n').match(/registerEntriesIndexRoutes\(app\)/g)).toHaveLength(1);
    expect(at('registerEntriesIndexRoutes(app)')).toBe(at('registerEntriesRoutes(app)') + 1);
  });

  it('is not among the routers that bypass Authelia', () => {
    expect(at('registerEntriesIndexRoutes(app)')).toBeLessThan(at('registerShareRoute(app)'));
    expect(at('registerEntriesIndexRoutes(app)')).toBeLessThan(at('registerMondropRoutes(app)'));
  });

  it('the route file says why it must stay behind Authelia, and does not live under the bypass prefixes', () => {
    const route = fs.readFileSync(path.resolve(__dirname, './entriesIndex.ts'), 'utf8');
    expect(route).toContain('auth-family');
    expect(route).toContain("'/api/entries/facets'");
    expect(route).not.toMatch(/app\.(get|post|put|patch|delete)\('\/api\/(mondrop|share)/);
  });
});
