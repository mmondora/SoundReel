import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/db', () => ({ query: queryMock }));

import { isCounted, MAX_BATCH, recordPlayEvents, validatePlayEvent } from './playEvents';

const NOW = Date.parse('2026-11-08T08:00:00Z');
const ev = (over: Record<string, unknown> = {}) => ({
  id: '6F1C2D6E-1111-4222-8333-444455556666', songKey: 'bishop briggs::white flag', startedAt: '2026-11-08T06:12:03Z',
  tzOffsetMin: 60, listenedMs: 183_000, durationMs: 231_000, completed: true, origin: 'local', playlistId: 'p1', ...over,
});

beforeEach(() => queryMock.mockReset());

describe('what counts as a play (decided here, not in the apps)', () => {
  it.each([
    [29_999, 231_000, false], [30_000, 231_000, true], [115_499, 231_000, true], // 30 s wins for a normal song
    [13_999, 28_000, false], [14_000, 28_000, true], // a 28 s jingle needs half of it (14 s)
    [29_999, null, false], [30_000, null, true], [0, 231_000, false], [1_000, 0, false],
  ])('listened %i ms of %s ms → counted %s', (listened, duration, counted) => {
    expect(isCounted(listened, duration)).toBe(counted);
  });
});

describe('validatePlayEvent', () => {
  it('accepts the contract example and derives the hour a person actually heard it', () => {
    const v = validatePlayEvent(ev(), NOW);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.event).toMatchObject({
      startedAt: '2026-11-08T06:12:03.000Z',
      localStartedAt: '2026-11-08T07:12:03.000', // 06:12 UTC + 60 min = 07:12 on the wall clock, no zone
      counted: true, origin: 'local', playlistId: 'p1',
    });
  });

  it('uses the offset sent with the event, not the server timezone (summer vs winter, other countries)', () => {
    const summer = validatePlayEvent(ev({ startedAt: '2026-07-01T22:30:00Z', tzOffsetMin: 120 }), Date.parse('2026-07-02T00:00:00Z'));
    expect(summer.ok && summer.event.localStartedAt).toBe('2026-07-02T00:30:00.000');
    const west = validatePlayEvent(ev({ tzOffsetMin: -300 }), NOW);
    expect(west.ok && west.event.localStartedAt).toBe('2026-11-08T01:12:03.000');
  });

  it('applies defaults (origin local, not completed, no duration, no playlist)', () => {
    const v = validatePlayEvent({ id: 'abcdefgh-1', songKey: 'a::b', startedAt: '2026-11-08T06:00:00Z', tzOffsetMin: 0, listenedMs: 40_000 }, NOW);
    expect(v.ok && v.event).toMatchObject({ origin: 'local', completed: false, durationMs: null, playlistId: null, counted: true });
  });

  it.each([
    ['id', { id: 'x' }, 'invalid_id'],
    ['id with a slash', { id: 'abc/def/ghi' }, 'invalid_id'],
    ['songKey empty', { songKey: '  ' }, 'invalid_songKey'],
    ['songKey huge', { songKey: 'x'.repeat(301) }, 'invalid_songKey'],
    ['startedAt garbage', { startedAt: 'yesterday' }, 'invalid_startedAt'],
    ['startedAt too old', { startedAt: '2024-01-01T00:00:00Z' }, 'invalid_startedAt'],
    ['startedAt in the future', { startedAt: '2026-11-12T00:00:00Z' }, 'invalid_startedAt'],
    ['tz out of range', { tzOffsetMin: 900 }, 'invalid_tzOffsetMin'],
    ['tz not an integer', { tzOffsetMin: 60.5 }, 'invalid_tzOffsetMin'],
    ['negative listened', { listenedMs: -1 }, 'invalid_listenedMs'],
    ['listened longer than a day', { listenedMs: 90_000_000 }, 'invalid_listenedMs'],
    ['listened as a string', { listenedMs: '183000' }, 'invalid_listenedMs'],
    ['duration negative', { durationMs: -5 }, 'invalid_durationMs'],
    ['completed not boolean', { completed: 'yes' }, 'invalid_completed'],
    ['unknown origin', { origin: 'carplay' }, 'invalid_origin'],
    ['playlist id huge', { playlistId: 'p'.repeat(101) }, 'invalid_playlistId'],
  ])('rejects %s', (_name, over, reason) => {
    const v = validatePlayEvent(ev(over), NOW);
    expect(v).toMatchObject({ ok: false, reason });
  });

  it('survives garbage instead of throwing', () => {
    for (const junk of [null, undefined, 7, 'x', [], {}]) expect(validatePlayEvent(junk, NOW).ok).toBe(false);
  });
});

describe('recordPlayEvents', () => {
  it('stores the valid events in one statement, scoped to the user and device, and reports the rest', async () => {
    queryMock.mockResolvedValue([{ id: 'a', counted: true }, { id: 'b', counted: false }]);
    const out = await recordPlayEvents(
      'mike', 'iPhone di Michele',
      { events: [ev({ id: 'aaaaaaaa-1' }), ev({ id: 'bbbbbbbb-2', listenedMs: 5_000 }), ev({ id: 'cccccccc-3' }), ev({ id: 'x', listenedMs: -1 })] },
      NOW,
    );
    expect(out).toEqual({ ok: true, counted: 1, result: { accepted: 2, duplicates: 1, rejected: [{ id: 'x', reason: 'invalid_id' }] } });
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(user_id, id\) DO NOTHING/);
    expect(params[0]).toBe('mike');
    expect(params[2]).toEqual(['iPhone di Michele', 'iPhone di Michele', 'iPhone di Michele']); // one device per row
    expect(params[1]).toEqual(['aaaaaaaa-1', 'bbbbbbbb-2', 'cccccccc-3']);
    expect(params[12]).toEqual([true, false, true]); // counted is derived here
  });

  it('a batch with nothing valid never touches the database', async () => {
    const out = await recordPlayEvents('mike', 'web', { events: [{ id: 'x' }] }, NOW);
    expect(out).toMatchObject({ ok: true, result: { accepted: 0, duplicates: 0, rejected: [{ id: 'x', reason: 'invalid_id' }] } });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('refuses a body without events and a batch over the limit', async () => {
    expect(await recordPlayEvents('mike', 'web', {}, NOW)).toEqual({ ok: false, status: 400, error: 'events_required' });
    expect(await recordPlayEvents('mike', 'web', { events: 'x' }, NOW)).toEqual({ ok: false, status: 400, error: 'events_required' });
    expect(await recordPlayEvents('mike', 'web', null, NOW)).toEqual({ ok: false, status: 400, error: 'events_required' });
    const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ev({ id: `id-${String(i).padStart(8, '0')}` }));
    expect(await recordPlayEvents('mike', 'web', { events: big }, NOW)).toEqual({ ok: false, status: 413, error: 'too_many_events' });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
