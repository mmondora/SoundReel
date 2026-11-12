import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/apiKeyAuth', () => ({ authenticateApiKey: vi.fn() }));
// mondrop.ts (where requireMondrop lives) imports a lot that is irrelevant here
vi.mock('../services/playlists', () => ({ listPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('../services/playlistResolver', () => ({ resolveSummaries: vi.fn(), resolveDetail: vi.fn(), invalidateDynamicPlaylists: vi.fn() }));
vi.mock('../services/offlineManifest', () => ({
  buildPlaylistOfflineManifest: vi.fn(), preparePlaylist: vi.fn(), getTrack: vi.fn(), requestSongDownload: vi.fn(),
  setSongSource: vi.fn(), enqueueSongToSpooty: vi.fn(), resolveSongServing: vi.fn(), ORDER_MONDROP: [], resolveEntryMediaAbs: vi.fn(), buildTracks: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarning: vi.fn() }));
vi.mock('../services/activityLog', async (orig) => ({ ...(await orig<typeof import('../services/activityLog')>()), logActivity: vi.fn() }));
vi.mock('../services/playEvents', () => ({ recordPlayEvents: vi.fn() }));
vi.mock('../services/deviceEvents', () => ({ recordDeviceEvents: vi.fn() }));
vi.mock('../services/userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('../services/songStream', () => ({ serveSong: vi.fn() }));
vi.mock('../utils/db', () => ({ query: vi.fn(), pool: { query: vi.fn() } }));

import { registerMondropReelsRoutes } from './mondropReels';
import { authenticateApiKey } from '../utils/apiKeyAuth';
import { logError } from '../utils/logger';
import type { ReelsDeps } from '../services/mondropReels';
import type { ReelRow } from '../services/reelBreakdown';

// The three routes of the reels (ADR-0033, contract docs/mondrop-reels.md): the Mondrop key like every `/api/mondrop/*` route, and the person is the one of the key and
// nothing else. These tests go through the real service and the real builder, with the reads faked: what comes out is what the app gets.

const KEY = { 'x-soundreel-key': 'sr_test' };
const ID = '8167b826-f8e2-4298-b477-174c41bcc13b';
const OTHER_ID = '4d4d5f3e-e947-4317-b3f0-21ffd5a251d4';
const ADDRESS = 'https://www.instagram.com/reel/TESTCODE123/';

const row = (results: unknown, id = ID): ReelRow => ({ id, createdAt: new Date('2026-11-12T08:01:00.000Z'), platform: 'instagram', thumbnailUrl: `/media/${id}/thumbnail.jpg`, results });

function fakeDeps(over: Partial<ReelsDeps> = {}): ReelsDeps {
  return {
    rows: vi.fn(async () => ({ rows: [row({ summary: 'Di cosa parla.', software: [{ title: 'Notion', tag: 'product' }] })], total: 1 })),
    kindCounts: vi.fn(async () => [{ kind: 'software' as const, count: 1 }]),
    row: vi.fn(async () => row({ summary: 'Di cosa parla.', software: [{ title: 'Notion', tag: 'product' }] })),
    journal: vi.fn(async () => new Map()),
    tracks: vi.fn(async () => []),
    image: vi.fn(async () => null),
    ...over,
  };
}

function appWith(deps: ReelsDeps) {
  const app = Fastify();
  registerMondropReelsRoutes(app, deps);
  return app;
}

let dir: string;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reels-route-'));
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), JPEG);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authenticateApiKey).mockResolvedValue({ owner: { user: 'mike', device: 'iPhone di Michele' } });
});

describe('a valid key is needed, for each of the three', () => {
  it('answers 401 and reads nothing without one', async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null as never);
    const deps = fakeDeps();
    const app = appWith(deps);
    for (const url of ['/api/mondrop/reels', `/api/mondrop/reels/${ID}`, `/api/mondrop/reels/${ID}/image`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
    for (const read of [deps.rows, deps.kindCounts, deps.row, deps.journal, deps.tracks, deps.image]) expect(read).not.toHaveBeenCalled();
  });

  it('are reads: nothing is written, queued or accepted', async () => {
    const app = appWith(fakeDeps());
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      for (const url of ['/api/mondrop/reels', `/api/mondrop/reels/${ID}`, `/api/mondrop/reels/${ID}/image`]) {
        const res = await app.inject({ method, url, headers: KEY, payload: {} });
        expect(res.statusCode).toBe(404);
      }
    }
  });
});

describe('GET /api/mondrop/reels', () => {
  it('answers the page of the person the key belongs to', async () => {
    const deps = fakeDeps();
    const res = await appWith(deps).inject({ method: 'GET', url: '/api/mondrop/reels', headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      total: 1, limit: 20, offset: 0,
      reels: [{
        id: ID, createdAt: '2026-11-12T08:01:00.000Z', platform: 'instagram', summary: 'Di cosa parla.', imagePath: `/api/mondrop/reels/${ID}/image`,
        counts: [{ kind: 'software', label: 'Software', count: 1, names: ['Notion'] }],
      }],
    });
    expect(deps.rows).toHaveBeenCalledWith('mike', { kind: undefined, limit: 20, offset: 0 });
    expect(deps.kindCounts).not.toHaveBeenCalled();
  });

  it('passes the page, the category and the facets it is asked for', async () => {
    const deps = fakeDeps();
    const res = await appWith(deps).inject({ method: 'GET', url: '/api/mondrop/reels?limit=5&offset=10&kind=book&facets=1', headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(deps.rows).toHaveBeenCalledWith('mike', { kind: 'book', limit: 5, offset: 10 });
    expect(res.json()).toMatchObject({ limit: 5, offset: 10, kinds: [{ kind: 'software', label: 'Software', count: 1 }] });
  });

  it('has the facets only with facets=1 (and true)', async () => {
    for (const [query, expected] of [['', false], ['?facets=0', false], ['?facets=false', false], ['?facets=1', true], ['?facets=true', true]] as const) {
      const res = await appWith(fakeDeps()).inject({ method: 'GET', url: `/api/mondrop/reels${query}`, headers: KEY });
      expect('kinds' in res.json()).toBe(expected);
    }
  });

  it('ignores a user named in the query or in a header: the key decides (a key issued for Michele never reads Sara\'s reels)', async () => {
    const deps = fakeDeps();
    await appWith(deps).inject({ method: 'GET', url: '/api/mondrop/reels?user=sara&owner=archi', headers: { ...KEY, 'x-soundreel-user': 'sara' } });
    expect(deps.rows).toHaveBeenCalledWith('mike', expect.anything());
  });

  it('answers 400 for a parameter that is wrong, naming it, and reads nothing', async () => {
    const wrong: Array<[string, string]> = [
      ['limit=0', 'limit'], ['limit=51', 'limit'], ['limit=abc', 'limit'], ['limit=-3', 'limit'], ['limit=1.5', 'limit'], ['limit=10&limit=20', 'limit'],
      ['offset=-1', 'offset'], ['offset=x', 'offset'], ['offset=1.5', 'offset'], ['offset=2000000', 'offset'], ['offset=1&offset=2', 'offset'],
      ['kind=other', 'kind'], ['kind=zzz', 'kind'], ['kind=Film', 'kind'], ['kind=film&kind=book', 'kind'], ["kind=film'--", 'kind'],
      ['facets=yes', 'facets'], ['facets=2', 'facets'], ['facets=1&facets=1', 'facets'],
    ];
    for (const [query, field] of wrong) {
      const deps = fakeDeps();
      const res = await appWith(deps).inject({ method: 'GET', url: `/api/mondrop/reels?${query}`, headers: KEY });
      expect(res.statusCode, query).toBe(400);
      expect(res.json(), query).toEqual({ error: `invalid_${field}` });
      expect(deps.rows, query).not.toHaveBeenCalled();
    }
  });

  it('reads a blank parameter as not given', async () => {
    const deps = fakeDeps();
    const res = await appWith(deps).inject({ method: 'GET', url: '/api/mondrop/reels?limit=&offset=&kind=&facets=', headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(deps.rows).toHaveBeenCalledWith('mike', { kind: undefined, limit: 20, offset: 0 });
  });

  it('says «reels failed» (and logs it) when the posts cannot be read', async () => {
    const deps = fakeDeps({ rows: vi.fn(async () => { throw new Error('boom'); }) });
    const res = await appWith(deps).inject({ method: 'GET', url: '/api/mondrop/reels', headers: KEY });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'reels_failed' });
    expect(logError).toHaveBeenCalledWith('GET /api/mondrop/reels failed', expect.anything());
  });

  it('keeps the list when only the facets fail', async () => {
    const deps = fakeDeps({ kindCounts: vi.fn(async () => { throw new Error('boom'); }) });
    const res = await appWith(deps).inject({ method: 'GET', url: '/api/mondrop/reels?facets=1', headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json().reels).toHaveLength(1);
    expect('kinds' in res.json()).toBe(false);
  });

  it('never says the address of a post, or any address, whatever the post carried (rule P)', async () => {
    const results = {
      summary: `Vedi ${ADDRESS}`, links: [{ url: ADDRESS }], software: [{ title: 'Notion', url: 'https://notion.so', tag: 'product' }],
      films: [{ title: 'Dune', imdbUrl: 'https://imdb.com/x', posterUrl: 'https://img.test/p.jpg' }],
    };
    const deps = fakeDeps({ rows: vi.fn(async () => ({ rows: [{ ...row(results), thumbnailUrl: 'https://scontent.cdninstagram.com/v/x.jpg' }], total: 1 })) });
    const res = await appWith(deps).inject({ method: 'GET', url: '/api/mondrop/reels?facets=1', headers: KEY });
    expect(res.body).not.toMatch(/https?:\/\//i);
    expect(res.body).not.toMatch(/"(?:sourceUrl|mediaUrl|imdbUrl|url|posterUrl)"/);
    expect(res.json().reels[0].imagePath).toBeNull();                       // an address of someone else's CDN is not passed on
  });
});

describe('GET /api/mondrop/reels/:id', () => {
  it('answers the page of the reel for the person the key belongs to', async () => {
    const deps = fakeDeps();
    const res = await appWith(deps).inject({ method: 'GET', url: `/api/mondrop/reels/${ID}`, headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({ id: ID, summary: 'Di cosa parla.', sections: [{ kind: 'software', title: 'Software', items: [{ title: 'Notion', detail: 'prodotto' }] }], tags: [], insights: [], verdict: null, slides: [] });
    expect(deps.row).toHaveBeenCalledWith('mike', ID);
  });

  it('answers 404, and the same words, for a reel that does not exist and for one the person cannot read', async () => {
    const deps = fakeDeps({ row: vi.fn(async () => null) });
    const res = await appWith(deps).inject({ method: 'GET', url: `/api/mondrop/reels/${OTHER_ID}`, headers: KEY });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('answers 404 for what cannot be an id, without asking anything', async () => {
    for (const id of ['abc', '12345', 'not-a-uuid', `${ID}x`, '%2e%2e', "x'--"]) {
      const deps = fakeDeps();
      const res = await appWith(deps).inject({ method: 'GET', url: `/api/mondrop/reels/${id}`, headers: KEY });
      expect(res.statusCode, id).toBe(404);
      expect(deps.row, id).not.toHaveBeenCalled();
    }
  });

  it('says «reels failed» (and logs it) when the reel cannot be read', async () => {
    const deps = fakeDeps({ row: vi.fn(async () => { throw new Error('boom'); }) });
    const res = await appWith(deps).inject({ method: 'GET', url: `/api/mondrop/reels/${ID}`, headers: KEY });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'reels_failed' });
    expect(logError).toHaveBeenCalledWith('GET /api/mondrop/reels/:id failed', expect.anything());
  });

  it('never says the address of a post, or any address, whatever the post carried (rule P)', async () => {
    const results = {
      summary: `Vedi ${ADDRESS}`, links: [{ url: ADDRESS }], films: [{ title: 'Dune', imdbUrl: 'https://imdb.com/x' }],
      slides: [{ index: 0, imageUrl: '/media/x/0.jpg', summary: `Slide ${ADDRESS}` }], enrichments: { items: [{ label: 'Film: Dune', explanation: `Un film. ${ADDRESS}`, links: [{ url: ADDRESS }] }] },
    };
    const res = await appWith(fakeDeps({ row: vi.fn(async () => row(results)) })).inject({ method: 'GET', url: `/api/mondrop/reels/${ID}`, headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/https?:\/\//i);
    expect(res.body).not.toMatch(/"(?:sourceUrl|mediaUrl|imdbUrl|url|posterUrl)"/);
  });

  it('says the sheet of a film on IMDb as `openUrl` — the one address of the page — and nothing else of the kind (ADR-0033, «Q3 si apri sulla scheda»)', async () => {
    const results = {
      summary: `Vedi ${ADDRESS}`, links: [{ url: ADDRESS }], software: [{ title: 'Notion', url: 'https://notion.so', tag: 'product' }],
      films: [
        { title: 'Dune', year: '2021', imdbUrl: 'https://www.imdb.com/title/tt1160419/?ref_=fn_al_tt_1', posterUrl: 'https://img.test/p.jpg' },
        { title: 'Arrival', imdbUrl: 'https://evil.test/title/tt2543164/' },
      ],
      slides: [{ index: 0, imageUrl: '/media/x/0.jpg', summary: `Slide ${ADDRESS}` }],
    };
    const res = await appWith(fakeDeps({ row: vi.fn(async () => row(results)) })).inject({ method: 'GET', url: `/api/mondrop/reels/${ID}`, headers: KEY });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sections: Array<{ kind: string; items?: unknown[] }> };
    expect(body.sections.find((s) => s.kind === 'film')?.items).toEqual([
      { title: 'Dune', detail: '2021', openUrl: 'https://www.imdb.com/title/tt1160419/' },
      { title: 'Arrival', detail: null },
    ]);
    expect(res.body.match(/https?:\/\/[^"\s]*/gi)).toEqual(['https://www.imdb.com/title/tt1160419/']);
    expect(res.body).not.toContain(ADDRESS);
    expect(res.body).not.toMatch(/"(?:sourceUrl|mediaUrl|imdbUrl|url|posterUrl)"/);
  });

  it('has no address at all in the list of reels, not even the sheet of a film', async () => {
    const results = { films: [{ title: 'Dune', imdbUrl: 'https://www.imdb.com/title/tt1160419/' }], summary: 'Un film.' };
    const res = await appWith(fakeDeps({ rows: vi.fn(async () => ({ rows: [row(results)], total: 1 })) })).inject({ method: 'GET', url: '/api/mondrop/reels', headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/https?:\/\//i);
    expect(res.body).not.toContain('openUrl');
  });
});

describe('GET /api/mondrop/reels/:id/image', () => {
  it('sends the picture, with its type and its size, kept by the phone for a day', async () => {
    const image = vi.fn(async () => ({ absPath: path.join(dir, 'thumbnail.jpg'), size: JPEG.length }));
    const res = await appWith(fakeDeps({ image })).inject({ method: 'GET', url: `/api/mondrop/reels/${ID}/image`, headers: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-length']).toBe(String(JPEG.length));
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.rawPayload.length).toBe(JPEG.length);                                // the body is not empty: a handler that streams has to return the reply
    expect(Buffer.compare(res.rawPayload, JPEG)).toBe(0);
    expect(image).toHaveBeenCalledWith('mike', ID);
  });

  it('answers 404 when the person cannot read the reel or there is no picture', async () => {
    const res = await appWith(fakeDeps({ image: vi.fn(async () => null) })).inject({ method: 'GET', url: `/api/mondrop/reels/${ID}/image`, headers: KEY });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('answers 404 for what cannot be an id, without asking anything', async () => {
    for (const id of ['abc', '..', 'x.jpg', `${ID}x`]) {
      const deps = fakeDeps();
      const res = await appWith(deps).inject({ method: 'GET', url: `/api/mondrop/reels/${id}/image`, headers: KEY });
      expect(res.statusCode, id).toBe(404);
      expect(deps.image, id).not.toHaveBeenCalled();
    }
  });

  it('says «reels failed» (and logs it) when the picture cannot be looked up', async () => {
    const res = await appWith(fakeDeps({ image: vi.fn(async () => { throw new Error('boom'); }) })).inject({ method: 'GET', url: `/api/mondrop/reels/${ID}/image`, headers: KEY });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'reels_failed' });
    expect(logError).toHaveBeenCalledWith('GET /api/mondrop/reels/:id/image failed', expect.anything());
  });
});

// ---------------------------------------------------------------------------------------------------------------- server.ts
const raw = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');
// comments do not count: a registration that is commented out is no registration
const server = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('server.ts and the reels', () => {
  it('registers the routes once, next to the other /api/mondrop ones (they have the key, Traefik bypasses Authelia there), before the routes behind Authelia', () => {
    expect(server).toContain("import { registerMondropReelsRoutes } from './routes/mondropReels';");
    expect(server.match(/registerMondropReelsRoutes\(app\);/g)).toHaveLength(1);
    const at = server.indexOf('registerMondropReelsRoutes(app);');
    expect(at).toBeGreaterThan(server.indexOf('registerMondropRoutes(app);'));
    expect(at).toBeLessThan(server.indexOf('registerMeRoute(app);'));
  });
});
