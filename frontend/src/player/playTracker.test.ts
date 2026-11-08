import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_SESSION_MS, PlayTracker, localTzOffsetMin, newEventId } from './playTracker';
import type { PlayEvent } from '../types';

function setup(extra: { tz?: (at: number) => number } = {}) {
  let time = Date.parse('2026-11-08T06:00:00Z');
  const events: PlayEvent[] = [];
  let n = 0;
  const tracker = new PlayTracker({
    onEvent: (e) => events.push(e),
    now: () => time,
    uuid: () => `id-${++n}`,
    tzOffsetMin: extra.tz ?? (() => 60),
  });
  const advance = (ms: number) => { time += ms; };
  return { tracker, events, advance, at: () => time };
}

const SONG = { songKey: 'bishop briggs::white flag', playlistId: 'p1' };

afterEach(() => vi.restoreAllMocks());

describe('PlayTracker: what counts as listened time', () => {
  it('counts only the time the media is playing; pauses add nothing', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    tracker.playing();
    advance(10_000);
    tracker.paused();
    advance(60_000); // paused for a minute
    tracker.playing();
    advance(5_000);
    tracker.ended();
    expect(events).toHaveLength(1);
    expect(events[0].listenedMs).toBe(15_000);
  });

  it('buffering (not playing) does not count; a seek neither adds nor removes time', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    tracker.playing();
    advance(4_000);
    tracker.paused(); // buffering
    advance(8_000);
    tracker.playing();
    advance(1_000); // a seek forward happens here: nothing to do, the clock just keeps running
    advance(2_000);
    tracker.finish();
    expect(events[0].listenedMs).toBe(7_000);
  });

  it('calling playing() twice or paused() without playing changes nothing', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    tracker.paused();
    tracker.playing();
    advance(3_000);
    tracker.playing();
    advance(3_000);
    tracker.paused();
    tracker.paused();
    tracker.ended();
    expect(events[0].listenedMs).toBe(6_000);
  });

  it('listenedMs() is live while playing', () => {
    const { tracker, advance } = setup();
    tracker.setSong(SONG);
    tracker.playing();
    advance(2_500);
    expect(tracker.listenedMs()).toBe(2_500);
    tracker.paused();
    advance(10_000);
    expect(tracker.listenedMs()).toBe(2_500);
  });
});

describe('PlayTracker: one event per session, at least 3 s', () => {
  it('a session under 3 s produces no event; exactly 3 s does', () => {
    expect(MIN_SESSION_MS).toBe(3000);
    const a = setup();
    a.tracker.setSong(SONG);
    a.tracker.playing();
    a.advance(2_999);
    a.tracker.ended();
    expect(a.events).toHaveLength(0);

    const b = setup();
    b.tracker.setSong(SONG);
    b.tracker.playing();
    b.advance(3_000);
    b.tracker.ended();
    expect(b.events).toHaveLength(1);
  });

  it('a song that never played produces nothing, however long it stayed loaded', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    advance(10 * 60_000);
    tracker.setSong(null);
    expect(events).toHaveLength(0);
  });

  it('switching song ends the previous session (not completed); the new one starts clean', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    tracker.playing();
    advance(20_000);
    tracker.setSong({ songKey: 'daft punk::one more time', playlistId: null });
    tracker.playing();
    advance(4_000);
    tracker.setSong(null);
    expect(events.map((e) => [e.songKey, e.listenedMs, e.completed, e.playlistId])).toEqual([
      ['bishop briggs::white flag', 20_000, false, 'p1'],
      ['daft punk::one more time', 4_000, false, null],
    ]);
  });

  it('starting the same song over is a new session; a replay after the end too (repeat one)', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    tracker.playing();
    advance(5_000);
    tracker.ended();
    tracker.playing(); // repeat one: the same song plays again
    advance(6_000);
    tracker.ended();
    expect(events.map((e) => [e.listenedMs, e.completed])).toEqual([[5_000, true], [6_000, true]]);
    expect(events[0].id).not.toBe(events[1].id);
  });

  it('completed is true only for a natural end', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    tracker.playing();
    advance(9_000);
    tracker.finish();
    tracker.playing();
    advance(9_000);
    tracker.ended();
    expect(events.map((e) => e.completed)).toEqual([false, true]);
  });

  it('finish() (page hidden for good) closes the running session; a later restore starts a new one', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    tracker.playing();
    advance(8_000);
    tracker.finish();
    expect(events).toHaveLength(1);
    tracker.playing();
    advance(4_000);
    tracker.finish();
    expect(events).toHaveLength(2);
  });
});

describe('PlayTracker: the event', () => {
  it('has the §1 shape: fresh id, ISO UTC start of the first playing, tz offset, duration, origin web, playlist', () => {
    const { tracker, events, advance, at } = setup();
    tracker.setSong({ ...SONG, durationMs: 231_000 });
    advance(30_000); // loaded but not playing yet
    const startedAt = at();
    tracker.playing();
    advance(183_000);
    tracker.ended();
    expect(events[0]).toEqual({
      id: 'id-1',
      songKey: 'bishop briggs::white flag',
      startedAt: new Date(startedAt).toISOString(),
      tzOffsetMin: 60,
      listenedMs: 183_000,
      durationMs: 231_000,
      completed: true,
      origin: 'web',
      playlistId: 'p1',
    });
    expect(events[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('uses the offset in force when the song STARTED (minutes east of UTC)', () => {
    const seen: number[] = [];
    const { tracker, advance, at } = setup({ tz: (ms) => { seen.push(ms); return 120; } });
    tracker.setSong(SONG);
    tracker.playing();
    const started = at();
    advance(5_000);
    tracker.ended();
    expect(seen).toEqual([started]);
  });

  it('the default tz offset is -getTimezoneOffset(): minutes EAST of UTC, so +60 for Italy in winter', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-60); // JS says -60 for UTC+1
    expect(localTzOffsetMin(Date.now())).toBe(60);
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(300); // New York winter: UTC-5
    expect(localTzOffsetMin(Date.now())).toBe(-300);
  });

  it('duration can arrive after the start; an unusable duration is null', () => {
    const { tracker, events, advance } = setup();
    tracker.setSong(SONG);
    tracker.playing();
    tracker.setDuration(Number.NaN);
    tracker.setDuration(0);
    advance(4_000);
    tracker.setDuration(200_000.4);
    tracker.ended();
    expect(events[0].durationMs).toBe(200_000);

    const b = setup();
    b.tracker.setSong(SONG);
    b.tracker.playing();
    b.advance(4_000);
    b.tracker.setDuration(null);
    b.tracker.ended();
    expect(b.events[0].durationMs).toBeNull();
  });

  it('a throwing listener never reaches the player', () => {
    const tracker = new PlayTracker({ onEvent: () => { throw new Error('boom'); }, now: (() => { let t = 0; return () => (t += 5_000); })() });
    tracker.setSong(SONG);
    tracker.playing();
    tracker.paused();
    expect(() => tracker.ended()).not.toThrow();
  });
});

describe('newEventId', () => {
  it('is a fresh UUID v4 every time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newEventId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('falls back when crypto.randomUUID is not available', () => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) });
    expect(newEventId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    vi.stubGlobal('crypto', undefined);
    expect(newEventId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    vi.unstubAllGlobals();
  });
});
