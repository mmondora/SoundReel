import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../utils/db', () => ({ query: m.query }));

import { registerLogsRoutes } from './logs';

const app = () => {
  const a = Fastify();
  registerLogsRoutes(a);
  return a;
};
const sql = (): string => String(m.query.mock.calls[0][0]).replace(/\s+/g, ' ');
const params = (): unknown[] => m.query.mock.calls[0][1] as unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  m.query.mockResolvedValue([
    { id: 1, ts: new Date('2026-11-08T10:00:00Z'), level: 'info', category: 'playlist', entry_id: null, message: 'mike ha creato la playlist «Road trip»', data: { action: 'create' } },
  ]);
});

describe('GET /api/logs', () => {
  it('answers with the latest lines as before (limit 200, newest first)', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/logs' });
    expect(res.json()).toEqual([
      { id: 1, ts: '2026-11-08T10:00:00.000Z', level: 'info', category: 'playlist', entryId: null, message: 'mike ha creato la playlist «Road trip»', data: { action: 'create' } },
    ]);
    expect(sql()).toContain('ORDER BY ts DESC LIMIT $1');
    expect(params()).toEqual([200]);
  });

  it('filters on the server by one or several categories (the activity trail: playlist, sync, download, device)', async () => {
    await app().inject({ method: 'GET', url: '/api/logs?category=playlist,%20sync,,download&limit=50' });
    expect(sql()).toContain('category = ANY($1::text[])');
    expect(params()).toEqual([['playlist', 'sync', 'download'], 50]);
  });

  it('and by time, combined with the other filters', async () => {
    await app().inject({ method: 'GET', url: '/api/logs?category=device&since=2026-11-08T09:00:00Z&level=info' });
    expect(sql()).toContain('category = ANY($1::text[]) AND ts >= $2 AND level = $3');
    expect(params()).toEqual([['device'], new Date('2026-11-08T09:00:00Z'), 'info', 200]);
  });

  it('refuses a time it cannot read instead of ignoring it', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/logs?since=yesterday' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_since' });
    expect(m.query).not.toHaveBeenCalled();
  });

  it('never puts the category into the SQL text: it is a bound array parameter', async () => {
    await app().inject({ method: 'GET', url: '/api/logs?category=a%27%3Bb' });
    expect(sql()).not.toContain('a;b');
    expect(params()[0]).toEqual(["a';b"]);
  });
});
