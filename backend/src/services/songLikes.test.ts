import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../utils/db', () => ({ query: m.query }));

import { MAX_SONG_KEY, likeTime, likedKeys, listLikes, normalizeSongKey, putLike, removeLike } from './songLikes';

// A like (ADR-0028, contract docs/mondrop-likes.md): «questo brano mi piace», of ONE person, kept on the server. The rules that decide what a key is and what
// the moment of a like is are pure; the queries are checked on their SQL here and on a real Postgres in songLikes.int.test.ts (LIKES_INT=1).

const NOW = new Date('2026-11-10T20:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the song key of a like', () => {
  it('is the key as the app sends it, trimmed', () => {
    expect(normalizeSongKey('daft punk::one more time')).toBe('daft punk::one more time');
    expect(normalizeSongKey('  bishop briggs::white flag \n')).toBe('bishop briggs::white flag');
  });

  it('is never empty: nothing, spaces only, or not a string are no key', () => {
    for (const bad of ['', '   ', '\n\t', undefined, null, 42, {}, ['a::b']]) expect(normalizeSongKey(bad)).toBeNull();
  });

  it('is at most 500 characters, the same limit as a song put in a playlist (counted after the trim)', () => {
    expect(MAX_SONG_KEY).toBe(500);
    expect(normalizeSongKey('k'.repeat(500))).toBe('k'.repeat(500));
    expect(normalizeSongKey('k'.repeat(501))).toBeNull();
    expect(normalizeSongKey(`${'k'.repeat(500)}      `)).toBe('k'.repeat(500));
  });

  it('is kept exactly: no case, accent or punctuation is touched (a key is an identity, never a spelling)', () => {
    expect(normalizeSongKey('Beyoncé::Halo (Live)')).toBe('Beyoncé::Halo (Live)');
  });
});

describe('the moment of a like', () => {
  it('is «now» when the app says nothing', () => {
    expect(likeTime(undefined, NOW)).toEqual(NOW);
    expect(likeTime(null, NOW)).toEqual(NOW);
  });

  it('is the moment the person gave it on the phone, when the like goes out later (offline)', () => {
    expect(likeTime('2026-11-10T17:58:00.000Z', NOW)).toEqual(new Date('2026-11-10T17:58:00.000Z'));
    expect(likeTime('2026-11-10T19:58:00+02:00', NOW)).toEqual(new Date('2026-11-10T17:58:00.000Z'));
    expect(likeTime('2026-11-10T17:58:00Z', NOW)).toEqual(new Date('2026-11-10T17:58:00.000Z'));
  });

  it('never in the future: the earlier of the two (a phone with a wrong clock cannot put a like on top forever)', () => {
    expect(likeTime('2026-11-10T20:00:00.001Z', NOW)).toEqual(NOW);
    expect(likeTime('2031-01-01T00:00:00.000Z', NOW)).toEqual(NOW);
    expect(likeTime('2026-11-10T20:00:00.000Z', NOW)).toEqual(NOW);
  });

  it('is ignored when it is not a date: «now» (a bad value is never an error, and never a strange moment)', () => {
    for (const bad of ['banana', '', '12', '2026', '2026-11-10', 'yesterday', 1794340000000, {}, true, ['2026-11-10T17:00:00Z'], '2026-13-45T25:61:00Z']) {
      expect(likeTime(bad, NOW)).toEqual(NOW);
    }
  });
});

describe('listLikes', () => {
  it('asks for the likes of ONE person, the most recent first and, at the same moment, by key (so two pages never swap)', async () => {
    m.query.mockResolvedValueOnce([
      { song_key: 'b::y', liked_at: new Date('2026-11-10T19:00:00.000Z') },
      { song_key: 'a::x', liked_at: new Date('2026-11-09T19:00:00.000Z') },
    ]);
    const out = await listLikes('mike');
    const [sql, params] = m.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM song_likes/);
    expect(String(sql)).toMatch(/WHERE user_id = \$1/);
    expect(String(sql)).toMatch(/ORDER BY liked_at DESC, song_key COLLATE "C" ASC/);
    expect(params).toEqual(['mike']);
    expect(out).toEqual([
      { songKey: 'b::y', likedAt: '2026-11-10T19:00:00.000Z' },
      { songKey: 'a::x', likedAt: '2026-11-09T19:00:00.000Z' },
    ]);
  });

  it('a person with no like has an empty list', async () => {
    m.query.mockResolvedValueOnce([]);
    expect(await listLikes('sara')).toEqual([]);
  });
});

describe('likedKeys', () => {
  it('are the keys of ONE person, the most recently liked first (what the playlist «Mi piace» reads)', async () => {
    m.query.mockResolvedValueOnce([{ song_key: 'b::y' }, { song_key: 'a::x' }]);
    expect(await likedKeys('mike')).toEqual(['b::y', 'a::x']);
    const [sql, params] = m.query.mock.calls[0];
    expect(String(sql)).toMatch(/WHERE user_id = \$1/);
    expect(String(sql)).toMatch(/ORDER BY liked_at DESC, song_key COLLATE "C" ASC/);
    expect(params).toEqual(['mike']);
  });
});

describe('putLike', () => {
  it('writes the like and says it is new when the row went in', async () => {
    m.query.mockResolvedValueOnce([{ liked_at: new Date('2026-11-10T20:00:00.000Z') }]);
    const out = await putLike('mike', 'a::x', NOW);
    expect(out).toEqual({ created: true, likedAt: new Date('2026-11-10T20:00:00.000Z') });
    expect(m.query).toHaveBeenCalledTimes(1);
    const [sql, params] = m.query.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO song_likes \(user_id, song_key, liked_at\)/);
    expect(String(sql)).toMatch(/ON CONFLICT \(user_id, song_key\) DO NOTHING/);
    expect(String(sql)).toMatch(/RETURNING liked_at/);
    expect(params).toEqual(['mike', 'a::x', NOW]);
  });

  it('is idempotent: a like that is already there is not touched, its FIRST date stays, and it is not new', async () => {
    m.query.mockResolvedValueOnce([]);                                                         // the insert collided: nothing returned
    m.query.mockResolvedValueOnce([{ liked_at: new Date('2026-11-01T10:00:00.000Z') }]);       // the one that was there
    const out = await putLike('mike', 'a::x', NOW);
    expect(out).toEqual({ created: false, likedAt: new Date('2026-11-01T10:00:00.000Z') });
    const [sql, params] = m.query.mock.calls[1];
    expect(String(sql)).toMatch(/SELECT liked_at FROM song_likes WHERE user_id = \$1 AND song_key = \$2/);
    expect(String(sql)).not.toMatch(/UPDATE|INSERT|DELETE/);
    expect(params).toEqual(['mike', 'a::x']);
  });

  it('a like removed between the two statements (it never happens) is given back as the new one the caller asked for', async () => {
    m.query.mockResolvedValueOnce([]);
    m.query.mockResolvedValueOnce([]);
    expect(await putLike('mike', 'a::x', NOW)).toEqual({ created: false, likedAt: NOW });
  });
});

describe('removeLike', () => {
  it('removes the like of THAT person and says whether it was there', async () => {
    m.query.mockResolvedValueOnce([{ song_key: 'a::x' }]);
    expect(await removeLike('mike', 'a::x')).toBe(true);
    const [sql, params] = m.query.mock.calls[0];
    expect(String(sql)).toMatch(/DELETE FROM song_likes WHERE user_id = \$1 AND song_key = \$2/);
    expect(String(sql)).toMatch(/RETURNING song_key/);
    expect(params).toEqual(['mike', 'a::x']);
  });

  it('is idempotent: removing a like that is not there is fine (false), never an error', async () => {
    m.query.mockResolvedValueOnce([]);
    expect(await removeLike('mike', 'a::x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the SQL
const dbDir = path.join(__dirname, '..', 'db');
const migration = readFileSync(path.join(dbDir, 'migrations', '025_song_likes.sql'), 'utf8');
const initSql = readFileSync(path.join(dbDir, 'init.sql'), 'utf8');

/** The statements of an SQL text, without comments. */
const statements = (sql: string): string[] =>
  sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

describe('the SQL of the likes (migration 025 and its mirror in init.sql)', () => {
  it('is only idempotent statements, additive: a table and an index IF NOT EXISTS, nothing that drops, rewrites or writes rows', () => {
    const all = statements(migration);
    expect(all).toHaveLength(2);
    for (const s of all) expect(s, s).toMatch(/^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS) /);
    expect(all.join(';')).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b|\bUPDATE \w+ SET\b|\bINSERT\b|\bALTER\b/i);
  });

  it('is one row per person and song: the key is (user_id, song_key), and when the like was given is never empty', () => {
    const table = statements(migration).find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS song_likes ')) ?? '';
    expect(table).toMatch(/user_id TEXT NOT NULL/);
    expect(table).toMatch(/song_key TEXT NOT NULL/);
    expect(table).toMatch(/liked_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(table).toMatch(/PRIMARY KEY \(user_id, song_key\)/);
    // no other column: nothing about the song itself (a like is a key and a moment), no «dislike»
    expect([...table.matchAll(/(?:\(\s*|,\s+)(\w+) (?:TEXT|TIMESTAMPTZ)\b/g)].map((x) => x[1])).toEqual(['user_id', 'song_key', 'liked_at']);
  });

  it('has the index the list reads: the likes of a person, the most recent first', () => {
    const index = statements(migration).find((s) => s.startsWith('CREATE INDEX IF NOT EXISTS ')) ?? '';
    expect(index).toMatch(/ON song_likes \(user_id, liked_at DESC\)/);
  });

  it('is the same in init.sql, statement by statement (a database made new and one migrated are the same)', () => {
    const initStatements = statements(initSql);
    for (const s of statements(migration)) expect(initStatements, s).toContain(s);
  });
});
