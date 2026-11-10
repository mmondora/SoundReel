import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The same fake of the four statements as in the service test: the route is tested together with the rules and without a database. */
const db = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  log: [] as string[],
  broken: false,
}));

vi.mock('../utils/db', () => {
  const run = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    db.log.push(sql);
    if (db.broken) throw new Error('database down');
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT prefs FROM user_prefs WHERE user_id = $1')) {
      const id = String(params[0]);
      return { rows: db.rows.has(id) ? [{ prefs: db.rows.get(id) }] : [] };
    }
    if (sql.startsWith('INSERT INTO user_prefs')) {
      db.rows.set(String(params[0]), JSON.parse(String(params[1])));
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM user_prefs WHERE user_id = $1')) {
      db.rows.delete(String(params[0]));
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  return {
    query: async (text: string, params?: unknown[]) => (await run(text, params)).rows,
    withClient: async (fn: (client: { query: typeof run }) => Promise<unknown>) => fn({ query: run }),
  };
});
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import { defaultUiPrefs } from '../services/uiPrefs';
import { logWarning } from '../utils/logger';
import { registerUiPrefsRoutes } from './uiPrefs';

const app = () => {
  const a = Fastify();
  registerUiPrefsRoutes(a);
  return a;
};
const as = (user: string) => ({ 'remote-user': user });
const sections = (order: readonly string[] = ['resume', 'songs', 'playlists', 'collections', 'films']) => order.map((id) => ({ id, visible: true }));

beforeEach(() => {
  db.rows.clear();
  db.log.length = 0;
  db.broken = false;
  vi.clearAllMocks();
});

describe('GET /api/me/prefs', () => {
  it('without an Authelia user: the defaults, and the database is not even asked', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/me/prefs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prefs: defaultUiPrefs() });
    expect(db.log).toEqual([]);
  });

  it('is never cached: the same tab may be read again after another device saved', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/me/prefs', headers: as('mike') });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a user the family does not know is no user: the defaults, nothing read', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/me/prefs', headers: as('bob') });
    expect(res.json()).toEqual({ prefs: defaultUiPrefs() });
    expect(db.log).toEqual([]);
  });

  it('answers the COMPLETE document: what the user chose over the defaults (Studio where he chose nothing)', async () => {
    db.rows.set('mike', { views: { inbox: 'wall' }, player: { dock: 'side' } });
    const res = await app().inject({ method: 'GET', url: '/api/me/prefs', headers: as('mike') });
    expect(res.json()).toEqual({
      prefs: { ...defaultUiPrefs(), views: { inbox: 'wall', links: 'studio' }, player: { dock: 'side', float: { x: 1, y: 1 } } },
    });
  });

  it('reads the user from the Authelia header only (any case), never from the query', async () => {
    db.rows.set('mike', { views: { inbox: 'wall' } });
    db.rows.set('sara', { views: { inbox: 'home' } });
    const a = app();
    const viaHeader = await a.inject({ method: 'GET', url: '/api/me/prefs', headers: as('Mike') });
    expect(viaHeader.json().prefs.views.inbox).toBe('wall');
    const withQuery = await a.inject({ method: 'GET', url: '/api/me/prefs?user=sara&userId=sara&user_id=sara', headers: as('mike') });
    expect(withQuery.json().prefs.views.inbox).toBe('wall');
    const noHeader = await a.inject({ method: 'GET', url: '/api/me/prefs?user=sara' });
    expect(noHeader.json()).toEqual({ prefs: defaultUiPrefs() });
  });

  it('a stored value the code does not know does not break the page: that key falls back to its default', async () => {
    db.rows.set('mike', { views: { inbox: 'grid' }, player: { dock: 'top' } });
    const res = await app().inject({ method: 'GET', url: '/api/me/prefs', headers: as('mike') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prefs: defaultUiPrefs() });
  });

  it('a database that is down does not break the page either: the defaults, and the reason is logged', async () => {
    db.broken = true;
    const res = await app().inject({ method: 'GET', url: '/api/me/prefs', headers: as('mike') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prefs: defaultUiPrefs() });
    expect(logWarning).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/me/prefs', () => {
  it('without an Authelia user: 401, and nothing is written', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', payload: { views: { inbox: 'wall' } } });
    expect(res.statusCode).toBe(401);
    expect(db.log).toEqual([]);
    expect(db.rows.size).toBe(0);
  });

  it('a user the family does not know: 401 too', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: as('bob'), payload: { views: { inbox: 'wall' } } });
    expect(res.statusCode).toBe(401);
    expect(db.rows.size).toBe(0);
  });

  it('takes a partial document, merges it and answers the COMPLETE one', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: { views: { inbox: 'wall' } } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ prefs: { ...defaultUiPrefs(), views: { inbox: 'wall', links: 'studio' } } });
    expect(db.rows.get('mike')).toEqual({ views: { inbox: 'wall' } });
  });

  it('two saves add up, as two devices would', async () => {
    const a = app();
    await a.inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: { views: { inbox: 'home' } } });
    const res = await a.inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: { player: { dock: 'float', float: { x: 0.3, y: 0.6 } } } });
    expect(res.json().prefs).toMatchObject({ views: { inbox: 'home' }, player: { dock: 'float', float: { x: 0.3, y: 0.6 } } });
    const again = await a.inject({ method: 'GET', url: '/api/me/prefs', headers: as('mike') });
    expect(again.json().prefs).toEqual(res.json().prefs);
  });

  it('the complete document the server answered can be sent back as it is', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: defaultUiPrefs() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prefs: defaultUiPrefs() });
  });

  it('one user\'s save never changes another\'s', async () => {
    const a = app();
    await a.inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: { views: { inbox: 'wall' } } });
    await a.inject({ method: 'PUT', url: '/api/me/prefs', headers: as('sara'), payload: { views: { inbox: 'home' } } });
    expect(db.rows.get('mike')).toEqual({ views: { inbox: 'wall' } });
    expect(db.rows.get('sara')).toEqual({ views: { inbox: 'home' } });
    expect(db.rows.has('archi')).toBe(false);
  });

  it('an administrator saves his own configuration, not anybody else\'s', async () => {
    await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: { ...as('mike'), 'remote-groups': 'admins' }, payload: { views: { links: 'wall' } } });
    expect([...db.rows.keys()]).toEqual(['mike']);
  });

  it('the user is never taken from the body: a body that names one is refused for the unknown key and nothing is written', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: { user_id: 'sara', views: { inbox: 'wall' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_prefs:user_id' });
    expect(db.rows.size).toBe(0);
  });

  it('nor from the query: a valid body with ?user=sara is saved for the Authelia user and for nobody else', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs?user=sara&user_id=sara', headers: as('mike'), payload: { views: { inbox: 'wall' } } });
    expect(res.statusCode).toBe(200);
    expect([...db.rows.keys()]).toEqual(['mike']);
  });

  const BAD: Array<[string, unknown, string]> = [
    ['an unknown key', { colour: 'red' }, 'invalid_prefs:colour'],
    ['«home» as the view of the Link page', { views: { links: 'home' } }, 'invalid_prefs:views.links'],
    ['a view that does not exist', { views: { inbox: 'grid' } }, 'invalid_prefs:views.inbox'],
    ['sections that are not a permutation of the five', { home: { sections: sections().slice(1) } }, 'invalid_prefs:home.sections'],
    ['a section twice', { home: { sections: sections(['resume', 'resume', 'playlists', 'collections', 'films']) } }, 'invalid_prefs:home.sections.1.id'],
    ['a dock that does not exist', { player: { dock: 'top' } }, 'invalid_prefs:player.dock'],
    ['a float outside 0..1', { player: { float: { x: 1.5 } } }, 'invalid_prefs:player.float.x'],
    ['a body that is a list', [], 'invalid_prefs:body'],
    ['a body that is a string', 'studio', 'invalid_prefs:body'],
  ];

  it.each(BAD)('%s: 400 with the key that is wrong, and nothing is written', async (_name, payload, error) => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: { ...as('mike'), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
    expect(db.log).toEqual([]);
    expect(db.rows.size).toBe(0);
  });

  it('a document over 4 KB: 400 «size»', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: { views: { inbox: 'wall' }, padding: 'x'.repeat(5000) } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_prefs:size' });
    expect(db.rows.size).toBe(0);
  });

  it('no body at all: 400 «body»', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike') });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_prefs:body' });
    expect(db.rows.size).toBe(0);
  });

  it('a body that is not JSON is a 400 and writes nothing', async () => {
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: { ...as('mike'), 'content-type': 'application/json' }, payload: '{bad' });
    expect(res.statusCode).toBe(400);
    expect(db.rows.size).toBe(0);
  });

  it('a database that is down: 500, and the answer says so without leaking why', async () => {
    db.broken = true;
    const res = await app().inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: { views: { inbox: 'wall' } } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'prefs_unavailable' });
    expect(res.body).not.toContain('database down');
  });
});

describe('DELETE /api/me/prefs', () => {
  it('takes the user\'s choices away and answers the defaults', async () => {
    const a = app();
    await a.inject({ method: 'PUT', url: '/api/me/prefs', headers: as('mike'), payload: { views: { inbox: 'wall' } } });
    const res = await a.inject({ method: 'DELETE', url: '/api/me/prefs', headers: as('mike') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prefs: defaultUiPrefs() });
    expect(db.rows.has('mike')).toBe(false);
  });

  it('touches only the Authelia user\'s row', async () => {
    db.rows.set('mike', { views: { inbox: 'wall' } });
    db.rows.set('sara', { views: { inbox: 'home' } });
    await app().inject({ method: 'DELETE', url: '/api/me/prefs?user=mike', headers: as('sara') });
    expect(db.rows.has('mike')).toBe(true);
    expect(db.rows.has('sara')).toBe(false);
  });

  it('without an Authelia user: 401, and nothing is deleted', async () => {
    db.rows.set('mike', { views: { inbox: 'wall' } });
    const res = await app().inject({ method: 'DELETE', url: '/api/me/prefs' });
    expect(res.statusCode).toBe(401);
    expect(db.rows.has('mike')).toBe(true);
    expect(db.log).toEqual([]);
  });

  it('a database that is down: 500', async () => {
    db.broken = true;
    const res = await app().inject({ method: 'DELETE', url: '/api/me/prefs', headers: as('mike') });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'prefs_unavailable' });
  });
});

describe('what the route is not', () => {
  it('there is no POST or PATCH, and no route that names another user', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/api/me/prefs', headers: as('mike'), payload: {} })).statusCode).toBe(404);
    expect((await a.inject({ method: 'PATCH', url: '/api/me/prefs', headers: as('mike'), payload: {} })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/me/prefs/sara', headers: as('mike') })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/users/sara/prefs', headers: as('mike') })).statusCode).toBe(404);
  });
});

describe('the server', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

  it('registers the routes (a route nobody registers is no route), once', () => {
    expect(server).toContain("import { registerUiPrefsRoutes } from './routes/uiPrefs';");
    expect(server.match(/registerUiPrefsRoutes\(app\)/g)).toHaveLength(1);
  });

  it('registers them after /api/me, where the Authelia routes are, and not among the routers that bypass Authelia', () => {
    const lines = server.split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle) && !l.includes('import'));
    expect(at('registerUiPrefsRoutes(app)')).toBeGreaterThan(at('registerMeRoute(app)'));
    expect(at('registerUiPrefsRoutes(app)')).toBeGreaterThan(at('registerMondropRoutes(app)'));
  });

  it('the route file says why it must stay behind Authelia', () => {
    const route = fs.readFileSync(path.resolve(__dirname, './uiPrefs.ts'), 'utf8');
    expect(route).toContain('auth-family');
    expect(route).not.toMatch(/app\.(get|put|delete)\('\/api\/(mondrop|share)/);
  });
});
