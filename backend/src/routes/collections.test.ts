import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The routes are tested with the REAL rules (services/collectionsView) and stand-in sources and store: what is asked is who the user is and what they
// ask, what comes back is what the rules make of the sources. The real sources have their own tests (collectionsViewData.test.ts, and the integration
// test on a real Postgres); the real store has its own too.
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));
vi.mock('../services/collectionsViewData', () => ({
  realViewSources: () => { throw new Error('the real sources must not be used by a test'); },
  entryVisibleTo: () => { throw new Error('the real database must not be used by a test'); },
}));
vi.mock('../services/collectionsStore', () => ({
  PgCollectionsStore: class { constructor() { throw new Error('the real store must not be used by a test'); } },
}));

import { registerCollectionsRoutes, type CollectionsRouteDeps } from './collections';
import { logError } from '../utils/logger';
import type { EntryFact, MemberRow, MemberRef, ThemeRow, ViewSources } from '../services/collectionsView';

// far from the real clock, so a route that forgot to use the injected one gives itself away
const NOW = new Date('2030-03-10T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

const fact = (id: string, days = 1): EntryFact => ({ id, createdAt: ago(days), thumbnailUrl: `https://img.example/${id}.jpg` });
const theme = (id: string, over: Partial<ThemeRow> = {}): ThemeRow => ({ id, name: `Tema ${id}`, nameBy: 'auto', groupLabel: null, parentId: null, state: 'active', createdAt: ago(60), ...over });
const mrow = (id: string, days: number, over: Partial<MemberRow> = {}): MemberRow => ({
  id, sourceUrl: `https://www.instagram.com/reel/${id}/`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed', createdAt: ago(days),
  summary: `Riassunto ${id}`, songCount: 0, filmCount: 0, noteCount: 0, tags: [], score: 0.5, source: 'auto', ...over,
});

/** What the sources know of ONE user. */
interface Known {
  themes?: ThemeRow[];
  members?: Record<string, MemberRow[]>;
  types?: Partial<Record<'type:music' | 'type:films' | 'type:software' | 'type:places' | 'type:books', MemberRow[]>>;
  failing?: boolean;
}

interface Harness {
  deps: CollectionsRouteDeps;
  asked: Array<{ source: string; userId: string }>;
  store: Record<'rename' | 'merge' | 'hide' | 'unhide' | 'addEntry' | 'removeEntry', ReturnType<typeof vi.fn>>;
  entryVisible: ReturnType<typeof vi.fn>;
  rebuildPreview: ReturnType<typeof vi.fn>;
}

function harness(perUser: Record<string, Known>, opts: { withRebuild?: boolean; visibleEntries?: string[] } = {}): Harness {
  const asked: Array<{ source: string; userId: string }> = [];
  const known = (userId: string): Known => perUser[userId] ?? {};
  const note = (source: string, userId: string): void => {
    asked.push({ source, userId });
    if (known(userId).failing) throw new Error('db down');
  };
  const memberRows = (userId: string, ref: MemberRef): MemberRow[] => {
    const k = known(userId);
    if (ref.kind === 'theme') return k.members?.[ref.id] ?? [];
    if (ref.kind === 'type') return k.types?.[ref.type] ?? [];
    return [];
  };
  const sources: ViewSources = {
    typeEntries: async (userId) => {
      note('typeEntries', userId);
      const out: Partial<Record<'type:music' | 'type:films' | 'type:software' | 'type:places' | 'type:books', EntryFact[]>> = {};
      for (const [type, rows] of Object.entries(known(userId).types ?? {})) out[type as 'type:music'] = (rows ?? []).map((r) => fact(r.id));
      return out;
    },
    placeEntries: async (userId) => { note('placeEntries', userId); return []; },
    themeRows: async (userId) => { note('themeRows', userId); return known(userId).themes ?? []; },
    themeMembers: async (userId) => {
      note('themeMembers', userId);
      return Object.fromEntries(Object.entries(known(userId).members ?? {}).map(([id, rows]) => [id, rows.map((r) => fact(r.id))]));
    },
    members: async (userId, ref) => { note('members', userId); return memberRows(userId, ref); },
    placesOf: async () => [],
    venuesOf: async () => [],
    chipThemes: async () => [],
    chipPlaces: async () => [],
    songs: async (userId) => { note('songs', userId); return [{ key: 'a::one', at: ago(1) }]; },
  };
  const store = {
    rename: vi.fn(async () => true), merge: vi.fn(async () => true), hide: vi.fn(async () => true),
    unhide: vi.fn(async () => true), addEntry: vi.fn(async () => true), removeEntry: vi.fn(async () => true),
  };
  const entryVisible = vi.fn(async (_userId: string, entryId: string) => (opts.visibleEntries ?? ['e1', 'e2']).includes(entryId));
  const rebuildPreview = vi.fn(async () => [{ id: 'c1', name: 'Vino', size: 7, state: 'active', memberIds: ['e1'] }]);
  return {
    deps: { sources, store, entryVisible, rebuildPreview: opts.withRebuild === false ? undefined : rebuildPreview, now: () => NOW },
    asked, store, entryVisible, rebuildPreview,
  };
}

const app = (h: Harness) => {
  const a = Fastify();
  registerCollectionsRoutes(a, h.deps);
  return a;
};
const MIKE = { 'remote-user': 'mike' };
const ADMIN = { 'remote-user': 'mike', 'remote-groups': 'users,admins' };

/** Mike has a few collections: an active theme with five posts, a hidden one, one under observation, a merged one, and the music. */
const MIKE_WORLD: Known = {
  themes: [theme('vino', { name: 'Vino', groupLabel: 'Cibo e bevande' }), theme('hid', { state: 'hidden', name: 'Nascosta' }), theme('obs', { state: 'watching', name: 'Osservata' }), theme('mer', { state: 'merged', parentId: 'vino' }), theme('casa', { name: 'Casa' })],
  members: {
    vino: ['a', 'b', 'c', 'd', 'e'].map((id, i) => mrow(id, i + 1)),
    hid: [mrow('h1', 1), mrow('h2', 2)],
    obs: [mrow('o1', 1)],
    mer: [mrow('m1', 1)],
    casa: [mrow('k1', 3), mrow('k2', 4)],
  },
  types: { 'type:music': [mrow('s1', 1, { songCount: 2 }), mrow('s2', 2, { songCount: 1 })] },
};

let h: Harness;
beforeEach(() => {
  vi.clearAllMocks();
  h = harness({ mike: MIKE_WORLD, sara: { themes: [theme('sara-theme')], members: { 'sara-theme': [mrow('x1', 1)] } } });
});

const ids = (res: { json: () => { collections: Array<{ id: string }> } }): string[] => res.json().collections.map((c) => c.id);

describe('GET /api/collections', () => {
  it('answers the active collections of the user, the types first, already in order', async () => {
    const res = await app(h).inject({ method: 'GET', url: '/api/collections', headers: MIKE });
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(['type:music', 'vino', 'casa']);
    expect(res.json().collections[0]).toMatchObject({ id: 'type:music', name: 'Musica', kind: 'type', group: 'Tipi', views: ['play', 'list'], defaultView: 'play' });
    expect(Object.keys(res.json())).toEqual(['collections']);
    // «New» is judged by the clock of the server (the one given), not by the machine's
    expect(res.json().collections.find((c: { id: string }) => c.id === 'vino').isNew).toBe(false);
  });

  it('is never cached', async () => {
    const res = await app(h).inject({ method: 'GET', url: '/api/collections', headers: MIKE });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers an empty list for a user with nothing, not an error', async () => {
    const res = await app(h).inject({ method: 'GET', url: '/api/collections', headers: { 'remote-user': 'archi' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ collections: [] });
  });

  it('?state=active is the same as no state', async () => {
    expect(ids(await app(h).inject({ method: 'GET', url: '/api/collections?state=active', headers: MIKE }))).toEqual(['type:music', 'vino', 'casa']);
  });

  it('?state=hidden answers the ones the user hid, to bring them back', async () => {
    const res = await app(h).inject({ method: 'GET', url: '/api/collections?state=hidden', headers: MIKE });
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(['hid']);
  });

  it('?state=watching is for the administrator only', async () => {
    const ok = await app(h).inject({ method: 'GET', url: '/api/collections?state=watching', headers: ADMIN });
    expect(ok.statusCode).toBe(200);
    expect(ids(ok)).toEqual(['obs']);
    const no = await app(h).inject({ method: 'GET', url: '/api/collections?state=watching', headers: MIKE });
    expect(no.statusCode).toBe(403);
    expect(no.json()).toEqual({ error: 'admin_only' });
    expect(no.headers['cache-control']).toBe('no-store');
  });

  it('the administrator group without a user does not make an administrator, and an anonymous visitor is not one', async () => {
    for (const headers of [{}, { 'remote-groups': 'admins' }]) {
      const res = await app(h).inject({ method: 'GET', url: '/api/collections?state=watching', headers });
      expect(res.statusCode).toBe(403);
    }
  });

  it('refuses a state it does not know, and a state given twice', async () => {
    for (const url of ['/api/collections?state=bogus', '/api/collections?state=', '/api/collections?state=hidden&state=active', '/api/collections?state=HIDDEN']) {
      const res = await app(h).inject({ method: 'GET', url, headers: MIKE });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_query:state' });
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('the administrator sees no more than anyone: their own collections, never another user\'s', async () => {
    const res = await app(h).inject({ method: 'GET', url: '/api/collections', headers: ADMIN });
    expect(ids(res)).toEqual(['type:music', 'vino', 'casa']);
    expect(h.asked.every((a) => a.userId === 'mike')).toBe(true);
  });

  it('a source failing is a 500 with a fixed message (the cause goes to the log, never to the client), and it is not cached', async () => {
    const broken = harness({ mike: { ...MIKE_WORLD, failing: true } });
    const res = await app(broken).inject({ method: 'GET', url: '/api/collections', headers: MIKE });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'collections_failed' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.json())).not.toContain('db down');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('GET /api/collections'), expect.anything());
  });
});

describe('who the user is: the Authelia user and nothing else', () => {
  it.each([
    ['mike', { 'remote-user': 'mike' }, 'mike'],
    ['sara written in capitals', { 'remote-user': 'SARA' }, 'sara'],
    ['an anonymous visitor', {}, 'anonymous'],
    ['a user the family does not know', { 'remote-user': 'stranger' }, 'anonymous'],
  ])('%s', async (_label, headers, expected) => {
    const res = await app(h).inject({ method: 'GET', url: '/api/collections', headers });
    expect(res.statusCode).toBe(200);
    expect(h.asked.length).toBeGreaterThan(0);
    expect(h.asked.every((a) => a.userId === expected)).toBe(true);
  });

  it('never reads a user from the query or another header: a request as Michele is Michele\'s whatever it names', async () => {
    const res = await app(h).inject({
      method: 'GET',
      url: '/api/collections?user=sara&userId=sara&owner=sara&as=sara&isAdmin=true&admin=1',
      headers: { ...MIKE, 'x-soundreel-user': 'sara', 'x-user': 'sara', 'x-forwarded-user': 'sara' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.asked.every((a) => a.userId === 'mike')).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain('sara');
  });

  it('answers each person with their own collections and not with another person\'s', async () => {
    const mine = await app(h).inject({ method: 'GET', url: '/api/collections', headers: MIKE });
    const hers = await app(h).inject({ method: 'GET', url: '/api/collections', headers: { 'remote-user': 'sara' } });
    expect(ids(mine)).toContain('vino');
    expect(ids(hers)).toEqual(['sara-theme']);
  });

  it('a collection of one user is not there for another: the id of Michele\'s theme is a 404 for Sara, never a 403', async () => {
    const res = await app(h).inject({ method: 'GET', url: '/api/collections/vino', headers: { 'remote-user': 'sara' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'collection_not_found' });
  });
});

describe('GET /api/collections/:id', () => {
  const get = (url: string, headers: Record<string, string> = MIKE) => app(h).inject({ method: 'GET', url, headers });

  it('answers the collection with everything its page draws', async () => {
    const res = await get('/api/collections/vino');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['collection', 'entries', 'facets', 'total', 'venues', 'why']);
    expect(body.collection).toMatchObject({ id: 'vino', name: 'Vino', kind: 'theme', group: 'Cibo e bevande', count: 5 });
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(body.entries[0]).toHaveProperty('collections', []);
    expect(body.total).toBe(5);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('takes the id from the path, decoded: a type has a colon (`type%3Amusic`) and still is the type', async () => {
    const res = await get('/api/collections/type%3Amusic');
    expect(res.statusCode).toBe(200);
    expect(res.json().collection.id).toBe('type:music');
    expect(res.json().songKeys).toEqual(['a::one']);
  });

  it('works with the colon written as it is', async () => {
    expect((await get('/api/collections/type:music')).statusCode).toBe(200);
  });

  it('a page of 40 by default, and the limit and the offset ask for another', async () => {
    const big = harness({ mike: { themes: [theme('big')], members: { big: Array.from({ length: 150 }, (_, i) => mrow(`p${String(i).padStart(3, '0')}`, i + 1)) } } });
    const a = app(big);
    const one = (await a.inject({ method: 'GET', url: '/api/collections/big', headers: MIKE })).json();
    expect(one.entries).toHaveLength(40);
    expect(one.total).toBe(150);
    const all = (await a.inject({ method: 'GET', url: '/api/collections/big?limit=100', headers: MIKE })).json();
    expect(all.entries).toHaveLength(100);
    const second = (await a.inject({ method: 'GET', url: '/api/collections/big?limit=2&offset=1', headers: MIKE })).json();
    expect(second.entries.map((e: { id: string }) => e.id)).toEqual(['p001', 'p002']);
    const last = (await a.inject({ method: 'GET', url: '/api/collections/big?offset=149', headers: MIKE })).json();
    expect(last.entries).toHaveLength(1);
  });

  it('passes the filters on: a platform, a month, free words, a place', async () => {
    const w = harness({ mike: { themes: [theme('t')], members: { t: [mrow('a', 5, { sourcePlatform: 'tiktok', summary: 'Un barolo' }), mrow('b', 90, { sourcePlatform: 'instagram', summary: 'Un chianti' })] } } });
    const a = app(w);
    const idsOf = async (qs: string) => (await a.inject({ method: 'GET', url: `/api/collections/t?${qs}`, headers: MIKE })).json().entries.map((e: { id: string }) => e.id);
    expect(await idsOf('fonte=tiktok')).toEqual(['a']);
    expect(await idsOf('q=chianti')).toEqual(['b']);
    expect(await idsOf(`quando=${ago(5).slice(0, 7)}`)).toEqual(['a']);
    expect(await idsOf(`quando=${ago(90).slice(0, 7)}`)).toEqual(['b']);
    expect(await idsOf('dove=Atlantide')).toEqual([]);
  });

  it('an empty filter is no filter: `?quando=&dove=&fonte=&q=` is the whole collection', async () => {
    const res = await get('/api/collections/vino?quando=&dove=&fonte=&q=');
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(5);
  });

  it.each([
    ['limit=0', 'limit'], ['limit=101', 'limit'], ['limit=abc', 'limit'], ['limit=1.5', 'limit'], ['limit=-3', 'limit'], ['limit=', 'limit'], ['limit=5&limit=6', 'limit'],
    ['offset=-1', 'offset'], ['offset=x', 'offset'], ['offset=1.5', 'offset'], ['offset=', 'offset'],
    ['quando=2026-13', 'quando'], ['quando=2026-00', 'quando'], ['quando=2026-1', 'quando'], ['quando=26-01', 'quando'], ['quando=2026-01-05', 'quando'], ['quando=gennaio', 'quando'],
    [`q=${'x'.repeat(201)}`, 'q'], [`dove=${'x'.repeat(101)}`, 'dove'], [`fonte=${'x'.repeat(101)}`, 'fonte'], ['dove=a&dove=b', 'dove'], ['fonte=a&fonte=b', 'fonte'], ['q=a&q=b', 'q'],
  ])('refuses ?%s with invalid_query:%s', async (qs, field) => {
    const res = await get(`/api/collections/vino?${qs}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: `invalid_query:${field}` });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('takes the edges of what is allowed: limit 1 and 100, offset 0, a month, the longest words', async () => {
    for (const qs of ['limit=1', 'limit=100', 'offset=0', 'quando=2026-01', 'quando=2026-12', `q=${'x'.repeat(200)}`, `dove=${'x'.repeat(100)}`, `fonte=${'x'.repeat(100)}`]) {
      expect((await get(`/api/collections/vino?${qs}`)).statusCode, qs).toBe(200);
    }
  });

  it.each(['/api/collections/nobody', '/api/collections/type:podcasts', '/api/collections/place:atlantide', '/api/collections/mer', '/api/collections/type:books'])('%s is a 404 «collection_not_found»', async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'collection_not_found' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a hidden theme can still be opened by its owner', async () => {
    expect((await get('/api/collections/hid')).statusCode).toBe(200);
  });

  it('a theme under observation is a 404 for everyone but the administrator', async () => {
    expect((await get('/api/collections/obs')).statusCode).toBe(404);
    expect((await get('/api/collections/obs', ADMIN)).statusCode).toBe(200);
  });

  it('is asked for the user who asked, and the filters never name another', async () => {
    await get('/api/collections/vino?user=sara', { 'remote-user': 'mike' });
    expect(h.asked.every((a) => a.userId === 'mike')).toBe(true);
  });

  it('a source failing is a 500 with a fixed message, and it is logged', async () => {
    const broken = harness({ mike: { ...MIKE_WORLD, failing: true } });
    const res = await app(broken).inject({ method: 'GET', url: '/api/collections/vino', headers: MIKE });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'collections_failed' });
    expect(JSON.stringify(res.json())).not.toContain('db down');
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

describe('the corrections: only the themes of the user, and only for a user the family knows', () => {
  const post = (url: string, payload?: unknown, headers: Record<string, string> = MIKE, method: 'POST' | 'DELETE' = 'POST') =>
    app(h).inject({ method, url, headers, payload: payload as never });

  describe('rename', () => {
    it('renames and answers the collection as it is now; the name is the one the user wrote (spaces tidied)', async () => {
      h.store.rename.mockImplementation(async () => {
        h.deps.sources.themeRows = async () => [theme('vino', { name: 'Vini d\'Italia', nameBy: 'user', groupLabel: 'Cibo e bevande' })];
        return true;
      });
      const res = await post('/api/collections/vino/rename', { name: '  Vini   d\'Italia ' });
      expect(res.statusCode).toBe(200);
      expect(h.store.rename).toHaveBeenCalledWith('mike', 'vino', 'Vini d\'Italia');
      expect(res.json().collection).toMatchObject({ id: 'vino', name: 'Vini d\'Italia' });
      expect(Object.keys(res.json())).toEqual(['collection']);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it.each([
      ['an empty name', { name: '' }], ['only spaces', { name: '   ' }], ['61 characters', { name: 'x'.repeat(61) }],
      ['a hash', { name: 'Vini #1' }], ['an at', { name: '@vini' }], ['a double quote', { name: 'Vini "buoni"' }], ['an asterisk', { name: 'Vini*' }],
      ['a control character', { name: 'Vini\u0007' }], ['a newline', { name: 'Vini\nbuoni' }], ['not a string', { name: 12 }], ['no name', {}], ['no body', undefined], ['a list', ['Vini']],
    ])('refuses %s with invalid_name and changes nothing', async (_label, payload) => {
      const res = await post('/api/collections/vino/rename', payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_name' });
      expect(h.store.rename).not.toHaveBeenCalled();
    });

    it('takes a name of exactly 60 characters', async () => {
      expect((await post('/api/collections/vino/rename', { name: 'x'.repeat(60) })).statusCode).toBe(200);
    });

    it('takes accents, apostrophes and punctuation that is not one of the forbidden signs', async () => {
      expect((await post('/api/collections/vino/rename', { name: 'Caffè & dolci, d\'autore (2026)' })).statusCode).toBe(200);
    });

    it('is «not_editable» on a type or a place, whatever the name: they are computed', async () => {
      for (const id of ['type:music', 'type:films', 'place:milano', 'type:whatever']) {
        const res = await post(`/api/collections/${encodeURIComponent(id)}/rename`, { name: 'Valid' });
        expect(res.statusCode, id).toBe(400);
        expect(res.json()).toEqual({ error: 'not_editable' });
      }
      expect((await post('/api/collections/type:music/rename', { name: '#' })).json()).toEqual({ error: 'not_editable' });
      expect(h.store.rename).not.toHaveBeenCalled();
    });

    it('is a 404 for a theme that is not the user\'s (the store is not even asked), or that the store refuses', async () => {
      const none = await post('/api/collections/sara-theme/rename', { name: 'Mine now' });
      expect(none.statusCode).toBe(404);
      expect(none.json()).toEqual({ error: 'collection_not_found' });
      expect(h.store.rename).not.toHaveBeenCalled();
      h.store.rename.mockResolvedValueOnce(false);
      const refused = await post('/api/collections/vino/rename', { name: 'Vini' });
      expect(refused.statusCode).toBe(404);
    });

    it('a merged theme is no collection: 404', async () => {
      expect((await post('/api/collections/mer/rename', { name: 'Nuovo' })).statusCode).toBe(404);
    });

    it('is for the user who asked, never another named in the body or the query', async () => {
      await post('/api/collections/vino/rename?user=sara', { name: 'Vini', user: 'sara', userId: 'sara' });
      expect(h.store.rename).toHaveBeenCalledWith('mike', 'vino', 'Vini');
    });
  });

  describe('merge', () => {
    it('merges into another active theme and answers the collection it went into, as it is now', async () => {
      const res = await post('/api/collections/vino/merge', { targetId: 'casa' });
      expect(res.statusCode).toBe(200);
      expect(h.store.merge).toHaveBeenCalledWith('mike', 'vino', 'casa');
      expect(res.json().collection).toMatchObject({ id: 'casa', name: 'Casa' });
    });

    it.each([
      ['no target', {}], ['an empty target', { targetId: '' }], ['a target that is not text', { targetId: 5 }], ['no body', undefined],
      ['itself', { targetId: 'vino' }], ['a type', { targetId: 'type:music' }], ['a place', { targetId: 'place:milano' }], ['a hidden theme', { targetId: 'hid' }], ['a theme under observation', { targetId: 'obs' }],
    ])('refuses %s with invalid_target', async (_label, payload) => {
      const res = await post('/api/collections/vino/merge', payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_target' });
      expect(h.store.merge).not.toHaveBeenCalled();
    });

    it('is a 404 when the target is not the user\'s, or is merged already, or does not exist', async () => {
      for (const targetId of ['sara-theme', 'mer', 'nobody']) {
        const res = await post('/api/collections/vino/merge', { targetId });
        expect(res.statusCode, targetId).toBe(404);
        expect(res.json()).toEqual({ error: 'collection_not_found' });
      }
      expect(h.store.merge).not.toHaveBeenCalled();
    });

    it('is a 404 when the theme to merge is not the user\'s', async () => {
      expect((await post('/api/collections/sara-theme/merge', { targetId: 'casa' })).statusCode).toBe(404);
    });

    it('is «not_editable» for a type or a place as the one to merge', async () => {
      expect((await post('/api/collections/type:music/merge', { targetId: 'casa' })).json()).toEqual({ error: 'not_editable' });
      expect((await post('/api/collections/place:milano/merge', { targetId: 'casa' })).json()).toEqual({ error: 'not_editable' });
    });

    it('is a 404 when the store refuses', async () => {
      h.store.merge.mockResolvedValueOnce(false);
      expect((await post('/api/collections/vino/merge', { targetId: 'casa' })).statusCode).toBe(404);
    });
  });

  describe.each([['hide', 'hide'], ['unhide', 'unhide']] as const)('%s', (route, method) => {
    it('answers ok and the store does it for the user', async () => {
      const res = await post(`/api/collections/${route === 'hide' ? 'vino' : 'hid'}/${route}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(h.store[method]).toHaveBeenCalledWith('mike', route === 'hide' ? 'vino' : 'hid');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('is «not_editable» for a type or a place', async () => {
      for (const id of ['type:music', 'place:milano']) {
        const res = await post(`/api/collections/${encodeURIComponent(id)}/${route}`);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'not_editable' });
      }
      expect(h.store[method]).not.toHaveBeenCalled();
    });

    it('is a 404 for a theme that is not the user\'s, a merged one, one that does not exist, or one the store refuses', async () => {
      for (const id of ['sara-theme', 'mer', 'nobody']) expect((await post(`/api/collections/${id}/${route}`)).statusCode, id).toBe(404);
      expect(h.store[method]).not.toHaveBeenCalled();
      h.store[method].mockResolvedValueOnce(false);
      expect((await post(`/api/collections/${route === 'hide' ? 'vino' : 'hid'}/${route}`)).statusCode).toBe(404);
    });
  });

  describe.each([['POST', 'addEntry'], ['DELETE', 'removeEntry']] as const)('%s …/entries/:entryId', (httpMethod, storeMethod) => {
    it('puts a post in (or takes it out) and answers ok', async () => {
      const res = await post('/api/collections/vino/entries/e1', undefined, MIKE, httpMethod);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(h.store[storeMethod]).toHaveBeenCalledWith('mike', 'vino', 'e1');
      expect(h.entryVisible).toHaveBeenCalledWith('mike', 'e1');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('is a 404 «entry_not_found» for a post the user cannot read', async () => {
      const res = await post('/api/collections/vino/entries/secret', undefined, MIKE, httpMethod);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'entry_not_found' });
      expect(h.store[storeMethod]).not.toHaveBeenCalled();
    });

    it('is «not_editable» for a type or a place, before anything is read', async () => {
      for (const id of ['type:music', 'place:milano']) {
        const res = await post(`/api/collections/${encodeURIComponent(id)}/entries/e1`, undefined, MIKE, httpMethod);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'not_editable' });
      }
      expect(h.entryVisible).not.toHaveBeenCalled();
    });

    it('is a 404 «collection_not_found» for a theme that is not the user\'s, merged, or missing: before the post is looked at', async () => {
      for (const id of ['sara-theme', 'mer', 'nobody']) {
        const res = await post(`/api/collections/${id}/entries/e1`, undefined, MIKE, httpMethod);
        expect(res.statusCode, id).toBe(404);
        expect(res.json()).toEqual({ error: 'collection_not_found' });
      }
      expect(h.store[storeMethod]).not.toHaveBeenCalled();
    });

    it('is a 404 when the store refuses', async () => {
      h.store[storeMethod].mockResolvedValueOnce(false);
      expect((await post('/api/collections/vino/entries/e1', undefined, MIKE, httpMethod)).statusCode).toBe(404);
    });

    it('asks the store as the user who asked', async () => {
      await post('/api/collections/vino/entries/e1?user=sara', undefined, MIKE, httpMethod);
      expect(h.store[storeMethod]).toHaveBeenCalledWith('mike', 'vino', 'e1');
    });
  });

  it.each([
    ['POST', '/api/collections/vino/rename', { name: 'Vini' }],
    ['POST', '/api/collections/vino/merge', { targetId: 'casa' }],
    ['POST', '/api/collections/vino/hide', undefined],
    ['POST', '/api/collections/hid/unhide', undefined],
    ['POST', '/api/collections/vino/entries/e1', undefined],
    ['DELETE', '/api/collections/vino/entries/e1', undefined],
  ] as const)('%s %s needs a user: a visitor with no Remote-User gets 401 and nothing changes', async (method, url, payload) => {
    const res = await app(h).inject({ method, url, payload: payload as never });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'authentication required' });
    expect(res.headers['cache-control']).toBe('no-store');
    for (const fn of Object.values(h.store)) expect(fn).not.toHaveBeenCalled();
  });

  it('corrects the themes of the user who asks, whoever that is: Sara hides her own theme, and it is hers the store is asked about', async () => {
    const res = await post('/api/collections/sara-theme/hide', undefined, { 'remote-user': 'sara' });
    expect(res.statusCode).toBe(200);
    expect(h.store.hide).toHaveBeenCalledWith('sara', 'sara-theme');
    expect((await post('/api/collections/vino/hide', undefined, { 'remote-user': 'sara' })).statusCode).toBe(404);
  });

  it('a correction that leaves no collection to describe (a theme with no post left) answers 404 instead of an empty answer', async () => {
    const empty = harness({ mike: { themes: [theme('empty')], members: {} } });
    const res = await app(empty).inject({ method: 'POST', url: '/api/collections/empty/rename', headers: MIKE, payload: { name: 'Nuovo' } });
    expect(empty.store.rename).toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'collection_not_found' });
  });

  it('a failure of the store is a 500 with a fixed message, logged', async () => {
    h.store.hide.mockRejectedValueOnce(new Error('db down'));
    const res = await post('/api/collections/vino/hide');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'collections_failed' });
    expect(JSON.stringify(res.json())).not.toContain('db down');
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('a store failure on a rename that is not about the name is a 500, not a 400', async () => {
    h.store.rename.mockRejectedValueOnce(new Error('db down'));
    const res = await post('/api/collections/vino/rename', { name: 'Vini' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'collections_failed' });
  });

  it('a name the store refuses with an error (empty after its own cleaning) is a 400, not a 500', async () => {
    h.store.rename.mockRejectedValueOnce(new Error('collection_name_required'));
    const res = await post('/api/collections/vino/rename', { name: 'ok' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_name' });
  });
});

describe('POST /api/admin/collections/rebuild', () => {
  const rebuild = (url = '/api/admin/collections/rebuild?dry=1', headers: Record<string, string> = ADMIN, hh: Harness = h) =>
    app(hh).inject({ method: 'POST', url, headers });

  it('answers the preview of the administrator\'s own collections, and writes nothing', async () => {
    const res = await rebuild();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ collections: [{ id: 'c1', name: 'Vino', size: 7, state: 'active', memberIds: ['e1'] }] });
    expect(h.rebuildPreview).toHaveBeenCalledWith('mike');
    expect(res.headers['cache-control']).toBe('no-store');
    for (const fn of Object.values(h.store)) expect(fn).not.toHaveBeenCalled();
  });

  it('is for administrators only: a family user and a visitor get 403 and the preview is not run', async () => {
    for (const headers of [MIKE, {}, { 'remote-groups': 'admins' }]) {
      const res = await rebuild('/api/admin/collections/rebuild?dry=1', headers);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'admin_only' });
    }
    expect(h.rebuildPreview).not.toHaveBeenCalled();
  });

  it('is a preview only: without dry=1 it is a 400 (the pass that writes is a script, run by hand)', async () => {
    for (const url of ['/api/admin/collections/rebuild', '/api/admin/collections/rebuild?dry=0', '/api/admin/collections/rebuild?dry=true', '/api/admin/collections/rebuild?dry=']) {
      const res = await rebuild(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_query:dry' });
    }
    expect(h.rebuildPreview).not.toHaveBeenCalled();
  });

  it('checks that it is an administrator BEFORE it says anything about dry', async () => {
    const res = await rebuild('/api/admin/collections/rebuild', MIKE);
    expect(res.statusCode).toBe(403);
  });

  it('says 503 «rebuild_unavailable» while the engine is not wired in', async () => {
    const without = harness({ mike: MIKE_WORLD }, { withRebuild: false });
    const res = await rebuild('/api/admin/collections/rebuild?dry=1', ADMIN, without);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'rebuild_unavailable' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('previews for the administrator who asks, whoever that is', async () => {
    await rebuild('/api/admin/collections/rebuild?dry=1', { 'remote-user': 'archi', 'remote-groups': 'admins' });
    expect(h.rebuildPreview).toHaveBeenCalledWith('archi');
  });

  it('never previews for another user: the query does not choose', async () => {
    await rebuild('/api/admin/collections/rebuild?dry=1&user=sara&userId=sara');
    expect(h.rebuildPreview).toHaveBeenCalledWith('mike');
  });

  it('a failure of the engine is a 500 with a fixed message, logged', async () => {
    h.rebuildPreview.mockRejectedValueOnce(new Error('model down'));
    const res = await rebuild();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'collections_failed' });
    expect(JSON.stringify(res.json())).not.toContain('model down');
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

describe('what the routes are not', () => {
  it('has no other verb on the list and the page, and nothing that names another user', async () => {
    const a = app(h);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await a.inject({ method, url: '/api/collections', headers: MIKE, payload: {} })).statusCode, method).toBe(404);
    }
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect((await a.inject({ method, url: '/api/collections/vino', headers: MIKE, payload: {} })).statusCode, method).toBe(404);
    }
    expect((await a.inject({ method: 'GET', url: '/api/users/sara/collections', headers: MIKE })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/collections/vino/rename', headers: MIKE })).statusCode).toBe(404);
  });
});

describe('the server', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
  const route = fs.readFileSync(path.resolve(__dirname, './collections.ts'), 'utf8');

  it('registers the routes (a route nobody registers is no route), once', () => {
    expect(server).toContain("import { registerCollectionsRoutes } from './routes/collections';");
    expect(server.match(/registerCollectionsRoutes\(app\)/g)).toHaveLength(1);
  });

  it('registers them after /api/me, where the Authelia routes are, and not among the routers that bypass Authelia', () => {
    const lines = server.split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle) && !l.includes('import'));
    expect(at('registerCollectionsRoutes(app)')).toBeGreaterThan(at('registerMeRoute(app)'));
    expect(at('registerCollectionsRoutes(app)')).toBeGreaterThan(at('registerMondropRoutes(app)'));
    expect(at('registerCollectionsRoutes(app)')).toBeGreaterThan(at('registerShareRoute(app)'));
  });

  it('the route file says why it must stay behind Authelia, and no path lives under the bypass prefixes', () => {
    expect(route).toContain('auth-family');
    expect(route).not.toMatch(/app\.(get|post|put|patch|delete)(<[^>]*>)?\(\s*['"`]\/api\/(mondrop|share)/);
    expect(route).toContain("'/api/collections'");
    expect(route).toContain("'/api/admin/collections/rebuild'");
  });

  it('the preview of the rebuild is the real engine\'s: the route plugs it in with the real sources (server.ts only registers the routes)', () => {
    expect(route).toContain('rebuildPreview(userId, realEngineDeps())');
    expect(route).toContain("from '../services/collectionsEngine'");
    expect(route).toContain("from '../services/collectionsEngineData'");
    expect(server).not.toContain('rebuildPreview');
  });
});
