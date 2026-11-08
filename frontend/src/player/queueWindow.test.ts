import { describe, expect, it } from 'vitest';
import { QUEUE_WINDOW_LIMIT, computeQueueWindow, windowItems } from './queueWindow';

const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

describe('computeQueueWindow', () => {
  it('the limit is 20', () => {
    expect(QUEUE_WINDOW_LIMIT).toBe(20);
  });

  it('an empty queue shows nothing and is not windowed', () => {
    expect(computeQueueWindow(0, 0)).toEqual({ indices: [], total: 0, shown: 0, windowed: false, hiddenPlayed: 0, hiddenAhead: 0 });
    expect(computeQueueWindow(0, 5).indices).toEqual([]);
  });

  it('20 songs or fewer: the whole list, wherever the current song is', () => {
    for (const total of [1, 7, 19, 20]) {
      for (const current of [0, Math.floor(total / 2), total - 1]) {
        const w = computeQueueWindow(total, current);
        expect(w.indices).toEqual(range(0, total));
        expect(w).toMatchObject({ windowed: false, hiddenPlayed: 0, hiddenAhead: 0, shown: total });
      }
    }
  });

  it('exactly 20 is complete, 21 is the first windowed size', () => {
    expect(computeQueueWindow(20, 12).windowed).toBe(false);
    const w = computeQueueWindow(21, 0);
    expect(w.windowed).toBe(true);
    expect(w.indices).toEqual(range(0, 20));
    expect(w).toMatchObject({ shown: 20, hiddenPlayed: 0, hiddenAhead: 1 });
  });

  it('the first shown is the song in play and the played ones drop out of the top as it advances', () => {
    const at0 = computeQueueWindow(57, 0);
    expect(at0.indices[0]).toBe(0);
    expect(at0).toMatchObject({ shown: 20, hiddenPlayed: 0, hiddenAhead: 37 });

    const at14 = computeQueueWindow(57, 14);
    expect(at14.indices).toEqual(range(14, 34));
    expect(at14.indices[0]).toBe(14);
    expect(at14).toMatchObject({ shown: 20, total: 57, hiddenPlayed: 14, hiddenAhead: 23 });

    const at15 = computeQueueWindow(57, 15);
    expect(at15.indices).toEqual(range(15, 35)); // one more played song dropped, one more upcoming appeared
    expect(at15.hiddenPlayed).toBe(15);
  });

  it('near the end the list gets shorter (no repeat): only what is left, current first', () => {
    const w = computeQueueWindow(57, 50);
    expect(w.indices).toEqual(range(50, 57));
    expect(w).toMatchObject({ shown: 7, hiddenPlayed: 50, hiddenAhead: 0 });
    expect(computeQueueWindow(57, 56).indices).toEqual([56]);
  });

  it('repeat on: the tail is completed with the songs that come up again from the start', () => {
    const w = computeQueueWindow(57, 50, { wrap: true });
    expect(w.indices).toEqual([...range(50, 57), ...range(0, 13)]);
    expect(w.shown).toBe(20);
    // 0..12 are shown again as upcoming, so only 13..49 stay hidden as played
    expect(w.hiddenPlayed).toBe(50 - 13);
    expect(w.hiddenAhead).toBe(0);
    expect(w.shown + w.hiddenPlayed + w.hiddenAhead).toBe(57);
  });

  it('repeat on but the window already fits: nothing wraps', () => {
    const w = computeQueueWindow(57, 10, { wrap: true });
    expect(w.indices).toEqual(range(10, 30));
    expect(w.hiddenPlayed).toBe(10);
  });

  it('repeat on at the last song shows it followed by the start of the queue', () => {
    const w = computeQueueWindow(57, 56, { wrap: true });
    expect(w.indices).toEqual([56, ...range(0, 19)]);
    expect(w.hiddenPlayed).toBe(56 - 19);
  });

  it('every index is shown at most once and the three counters add up to the total', () => {
    for (const wrap of [false, true]) {
      for (const total of [21, 22, 40, 57, 200]) {
        for (let current = 0; current < total; current += 1) {
          const w = computeQueueWindow(total, current, { wrap });
          expect(new Set(w.indices).size).toBe(w.indices.length);
          expect(w.indices.length).toBeLessThanOrEqual(20);
          expect(w.indices[0]).toBe(current);
          expect(w.shown + w.hiddenPlayed + w.hiddenAhead).toBe(total);
          expect(w.hiddenPlayed).toBeGreaterThanOrEqual(0);
          expect(w.hiddenAhead).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('a current index outside the queue is clamped', () => {
    expect(computeQueueWindow(57, 999).indices).toEqual([56]);
    expect(computeQueueWindow(57, -3).indices).toEqual(range(0, 20));
    expect(computeQueueWindow(57, Number.NaN).indices).toEqual(range(0, 20));
  });

  it('the limit is configurable (and at least 1)', () => {
    expect(computeQueueWindow(10, 3, { limit: 4 }).indices).toEqual([3, 4, 5, 6]);
    expect(computeQueueWindow(10, 3, { limit: 0 }).indices).toEqual([3]);
  });
});

describe('windowItems', () => {
  it('maps indices back to queue items in display order', () => {
    const queue = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const items = windowItems(queue, computeQueueWindow(30, 25, { wrap: true }));
    expect(items).toEqual(['s25', 's26', 's27', 's28', 's29', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12', 's13', 's14']);
  });
});
