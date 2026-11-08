import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
const logActivity = vi.hoisted(() => vi.fn());
vi.mock('../utils/db', () => ({ query: queryMock }));
vi.mock('./activityLog', async (orig) => ({ ...(await orig<typeof import('./activityLog')>()), logActivity }));

import { deletionMessage, LOG_SONGS, MAX_SONGS, recordDeviceEvents, validateDeviceEvent } from './deviceEvents';

const NOW = Date.parse('2026-11-08T09:45:00Z');
const song = (n: number, over: Record<string, unknown> = {}) => ({
  songKey: `artist::song ${n}`, title: `Song ${n}`, artist: 'Artist', bytes: 6_291_456, plays: 0, lastPlayedAt: null, ...over,
});
const ev = (over: Record<string, unknown> = {}, details: Record<string, unknown> = {}) => ({
  id: '9A7B1111-2222-4333-8444-555566667777', type: 'delete_songs', at: '2026-11-08T09:40:00Z',
  details: { reason: 'least_played', criteria: { count: 2 }, confirmations: 2, count: 2, bytes: 12_582_912, songs: [song(1), song(2)], ...details },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue([{ id: 1 }]);
});

describe('validateDeviceEvent', () => {
  it('accepts the contract example', () => {
    const v = validateDeviceEvent(ev(), NOW);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.event.details).toMatchObject({ reason: 'least_played', confirmations: 2, count: 2, bytes: 12_582_912, songsDropped: 0 });
  });

  it('derives what is missing from the song list (count, bytes) and never trusts a smaller count than the list', () => {
    const v = validateDeviceEvent(ev({}, { count: undefined, bytes: undefined }), NOW);
    expect(v.ok && v.event.details).toMatchObject({ count: 2, bytes: 12_582_912 });
    const v2 = validateDeviceEvent(ev({}, { count: 1 }), NOW);
    expect(v2.ok && v2.event.details.count).toBe(2);
  });

  it('clamps confirmations to 1…5 and sanitizes song fields', () => {
    const v = validateDeviceEvent(ev({}, { confirmations: 99, songs: [song(1, { bytes: -5, plays: 'x', title: 7, lastPlayedAt: 'not a date' })] }), NOW);
    expect(v.ok && v.event.details.confirmations).toBe(5);
    expect(v.ok && v.event.details.songs[0]).toEqual({ songKey: 'artist::song 1', title: '', artist: 'Artist', bytes: 0, plays: 0, lastPlayedAt: null });
    expect(validateDeviceEvent(ev({}, { confirmations: 0 }), NOW)).toMatchObject({ ok: true });
    const none = validateDeviceEvent(ev({}, { confirmations: undefined }), NOW);
    expect(none.ok && none.event.details.confirmations).toBe(1);
  });

  it('caps a giant list but remembers how many were dropped', () => {
    const songs = Array.from({ length: MAX_SONGS + 5 }, (_, i) => song(i));
    const v = validateDeviceEvent(ev({}, { songs, count: undefined, bytes: undefined }), NOW);
    expect(v.ok && v.event.details.songs).toHaveLength(MAX_SONGS);
    expect(v.ok && v.event.details.songsDropped).toBe(5);
  });

  it.each([
    ['id', { id: 'x' }, {}, 'invalid_id'],
    ['type', { type: 'wipe_phone' }, {}, 'unknown_type'],
    ['at', { at: 'tomorrow' }, {}, 'invalid_at'],
    ['at far in the future', { at: '2026-12-31T00:00:00Z' }, {}, 'invalid_at'],
    ['reason', {}, { reason: 'because' }, 'invalid_reason'],
    ['empty song list', {}, { songs: [] }, 'songs_required'],
    ['song without key', {}, { songs: [{ title: 'x' }] }, 'invalid_song'],
  ])('rejects a bad %s', (_n, top, details, reason) => {
    expect(validateDeviceEvent(ev(top, details), NOW)).toMatchObject({ ok: false, reason });
  });
});

describe('recordDeviceEvents', () => {
  it('stores the event durably, scoped to the user and device, and writes the detailed console line', async () => {
    const out = await recordDeviceEvents('mike', 'iPhone di Michele', { events: [ev()] }, NOW);
    expect(out).toEqual({ ok: true, result: { accepted: 1, duplicates: 0, rejected: [] } });
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(user_id, event_id\) DO NOTHING/);
    expect(params.slice(1, 4)).toEqual(['mike', 'iPhone di Michele', 'delete_songs']);
    expect(JSON.parse(String(params[4])).songs).toHaveLength(2);

    expect(logActivity).toHaveBeenCalledTimes(1);
    const [category, action, message, actor, data] = logActivity.mock.calls[0];
    expect([category, action]).toEqual(['device', 'delete_songs']);
    expect(message).toBe('mike (iPhone di Michele) ha eliminato 2 brani dal telefono (12 MB) — motivo: meno ascoltate · 2 conferme');
    expect(actor).toEqual({ user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' });
    expect(data).toMatchObject({ reason: 'least_played', confirmations: 2, count: 2, bytes: 12_582_912, songsNotShown: 0 });
    expect((data as { songs: unknown[] }).songs).toHaveLength(2);
  });

  it('a resent event is a duplicate: stored once, logged once', async () => {
    queryMock.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([]);
    const out = await recordDeviceEvents('mike', 'iPhone', { events: [ev(), ev()] }, NOW);
    expect(out).toMatchObject({ ok: true, result: { accepted: 1, duplicates: 1 } });
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it('keeps only the first 200 songs in the console line (the full list stays in the table)', async () => {
    const songs = Array.from({ length: LOG_SONGS + 40 }, (_, i) => song(i));
    await recordDeviceEvents('mike', 'iPhone', { events: [ev({}, { songs, count: undefined, bytes: undefined })] }, NOW);
    const data = logActivity.mock.calls[0][4] as { songs: unknown[]; songsNotShown: number };
    expect(data.songs).toHaveLength(LOG_SONGS);
    expect(data.songsNotShown).toBe(40);
    expect(JSON.parse(String((queryMock.mock.calls[0] as [string, unknown[]])[1][4])).songs).toHaveLength(LOG_SONGS + 40);
  });

  it('reports rejects without blocking the valid events; refuses a body without events', async () => {
    const out = await recordDeviceEvents('mike', 'iPhone', { events: [{ id: 'x' }, ev()] }, NOW);
    expect(out).toMatchObject({ ok: true, result: { accepted: 1, rejected: [{ id: 'x', reason: 'invalid_id' }] } });
    expect(await recordDeviceEvents('mike', 'iPhone', {}, NOW)).toEqual({ ok: false, status: 400, error: 'events_required' });
  });
});

describe('deletionMessage', () => {
  it('reads naturally for one song, a block and each reason', () => {
    const actor = { user: 'mike', device: 'iPhone', channel: 'mondrop' } as const;
    const base = { criteria: {}, songs: [], songsDropped: 0 };
    expect(deletionMessage(actor, { ...base, reason: 'manual', confirmations: 1, count: 1, bytes: 5_720_510 })).toBe('mike (iPhone) ha eliminato 1 brano dal telefono (5,5 MB) — motivo: scelta a mano');
    expect(deletionMessage(actor, { ...base, reason: 'free_space', confirmations: 2, count: 40, bytes: 1_300_000_000 })).toContain('40 brani dal telefono (1,2 GB) — motivo: libera spazio · 2 conferme');
  });
});
