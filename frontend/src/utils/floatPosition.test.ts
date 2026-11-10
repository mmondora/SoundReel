import { describe, expect, it } from 'vitest';
import { FLOAT_MARGIN, KEY_STEP, KEY_STEP_BIG, clampOrigin, fractionFromOrigin, nudge, pillOrigin, roundFraction } from './floatPosition';

// The floating Player (look and feel P4, ADR-0026): its place is saved as two fractions of the free area (0..1; (1, 1) is the bottom right
// corner), so the same choice fits any window. These are the pure rules: fractions → pixels, pixels → fractions (clamped), keys.

const AREA = { left: 232, top: 64, width: 1208, height: 760 };       // the page: right of the menu, under the top bar
const SIZE = { width: 360, height: 72 };
const M = FLOAT_MARGIN;

describe('pillOrigin: fractions → the corner of the pill, in pixels', () => {
  it('the numbers: a 12 pixel margin, so (0, 0) is at 244 × 76 and (1, 1) at 1068 × 740 on this page', () => {
    expect(FLOAT_MARGIN).toBe(12);
    expect(pillOrigin({ x: 0, y: 0 }, AREA, SIZE)).toEqual({ left: 244, top: 76 });
    expect(pillOrigin({ x: 1, y: 1 }, AREA, SIZE)).toEqual({ left: 1068, top: 740 });
  });

  it('(0, 0) is the top left corner of the area, a margin in', () => {
    expect(pillOrigin({ x: 0, y: 0 }, AREA, SIZE)).toEqual({ left: 232 + M, top: 64 + M });
  });

  it('(1, 1) is the bottom right corner, a margin in: the pill touches nothing', () => {
    expect(pillOrigin({ x: 1, y: 1 }, AREA, SIZE)).toEqual({ left: 232 + 1208 - 360 - M, top: 64 + 760 - 72 - M });
  });

  it('(0.5, 0.5) is the middle of the free area', () => {
    const { left, top } = pillOrigin({ x: 0.5, y: 0.5 }, AREA, SIZE);
    expect(left).toBeCloseTo(232 + M + 0.5 * (1208 - 360 - 2 * M));
    expect(top).toBeCloseTo(64 + M + 0.5 * (760 - 72 - 2 * M));
  });

  it('a window smaller than the pill puts it at the start of the area, never outside', () => {
    expect(pillOrigin({ x: 1, y: 1 }, { left: 0, top: 0, width: 300, height: 50 }, SIZE)).toEqual({ left: M, top: M });
  });

  it('a fraction out of range (an old or wrong saved value) is read as the edge', () => {
    expect(pillOrigin({ x: 7, y: -3 }, AREA, SIZE)).toEqual(pillOrigin({ x: 1, y: 0 }, AREA, SIZE));
    expect(pillOrigin({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, AREA, SIZE)).toEqual(pillOrigin({ x: 1, y: 1 }, AREA, SIZE));
  });
});

describe('fractionFromOrigin: where the pill was dropped → fractions, clamped to the area', () => {
  it('is the inverse of pillOrigin', () => {
    for (const pos of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.25, y: 0.75 }, { x: 0.5, y: 0.1 }]) {
      const back = fractionFromOrigin(pillOrigin(pos, AREA, SIZE), AREA, SIZE);
      expect(back.x).toBeCloseTo(pos.x, 3);
      expect(back.y).toBeCloseTo(pos.y, 3);
    }
  });

  it('a drop beyond an edge lands on that edge (never a fraction below 0 or above 1)', () => {
    expect(fractionFromOrigin({ left: -500, top: -500 }, AREA, SIZE)).toEqual({ x: 0, y: 0 });
    expect(fractionFromOrigin({ left: 99999, top: 99999 }, AREA, SIZE)).toEqual({ x: 1, y: 1 });
    expect(fractionFromOrigin({ left: 99999, top: -1 }, AREA, SIZE)).toEqual({ x: 1, y: 0 });
  });

  it('an area with no room left (the pill is as big as it) gives the corner, not a division by zero', () => {
    const tiny = { left: 0, top: 0, width: 300, height: 40 };
    expect(fractionFromOrigin({ left: 50, top: 10 }, tiny, SIZE)).toEqual({ x: 1, y: 1 });
  });

  it('writes the fractions with three decimals (no noise in what is saved)', () => {
    const out = fractionFromOrigin({ left: 232 + M + 123.456789, top: 64 + M + 98.7654321 }, AREA, SIZE);
    expect(out.x).toBe(Math.round(out.x * 1000) / 1000);
    expect(out.y).toBe(Math.round(out.y * 1000) / 1000);
  });
});

describe('clampOrigin: the corner of the pill held inside the free area, in pixels (the pill follows the pointer exactly until the edge)', () => {
  it('a corner inside the area is left as it is, to the pixel', () => {
    expect(clampOrigin({ left: 500.5, top: 300.25 }, AREA, SIZE)).toEqual({ left: 500.5, top: 300.25 });
  });

  it('a corner beyond an edge is put on that edge (a margin in)', () => {
    expect(clampOrigin({ left: -50, top: -50 }, AREA, SIZE)).toEqual({ left: 232 + M, top: 64 + M });
    expect(clampOrigin({ left: 99999, top: 99999 }, AREA, SIZE)).toEqual(pillOrigin({ x: 1, y: 1 }, AREA, SIZE));
    expect(clampOrigin({ left: 99999, top: -1 }, AREA, SIZE)).toEqual({ left: pillOrigin({ x: 1, y: 1 }, AREA, SIZE).left, top: 64 + M });
  });

  it('an area with no room gives the start of the area', () => {
    expect(clampOrigin({ left: 400, top: 400 }, { left: 0, top: 0, width: 300, height: 50 }, SIZE)).toEqual({ left: M, top: M });
  });
});

describe('the keyboard', () => {
  it('an arrow moves 2 % of the free area, with Shift 10 %, and stops at the edges', () => {
    expect(KEY_STEP).toBe(0.02);
    expect(KEY_STEP_BIG).toBe(0.1);
    expect(nudge({ x: 0.5, y: 0.5 }, 'ArrowLeft', false)).toEqual({ x: 0.48, y: 0.5 });
    expect(nudge({ x: 0.5, y: 0.5 }, 'ArrowRight', false)).toEqual({ x: 0.52, y: 0.5 });
    expect(nudge({ x: 0.5, y: 0.5 }, 'ArrowUp', false)).toEqual({ x: 0.5, y: 0.48 });
    expect(nudge({ x: 0.5, y: 0.5 }, 'ArrowDown', false)).toEqual({ x: 0.5, y: 0.52 });
    expect(nudge({ x: 0.5, y: 0.5 }, 'ArrowDown', true)).toEqual({ x: 0.5, y: 0.6 });
    expect(nudge({ x: 0.01, y: 0.99 }, 'ArrowLeft', false)).toEqual({ x: 0, y: 0.99 });
    expect(nudge({ x: 0.99, y: 0.99 }, 'ArrowRight', true)).toEqual({ x: 1, y: 0.99 });
    expect(nudge({ x: 0.5, y: 1 }, 'ArrowDown', false)).toEqual({ x: 0.5, y: 1 });
  });

  it('Home and End go to the top left and bottom right corners; another key moves nothing (null)', () => {
    expect(nudge({ x: 0.3, y: 0.3 }, 'Home', false)).toEqual({ x: 0, y: 0 });
    expect(nudge({ x: 0.3, y: 0.3 }, 'End', false)).toEqual({ x: 1, y: 1 });
    expect(nudge({ x: 0.3, y: 0.3 }, 'a', false)).toBeNull();
    expect(nudge({ x: 0.3, y: 0.3 }, 'Enter', false)).toBeNull();
  });

  it('repeated steps add up without floating-point noise', () => {
    let pos = { x: 0.1, y: 0.1 };
    for (let i = 0; i < 7; i += 1) pos = nudge(pos, 'ArrowRight', false) ?? pos;
    expect(pos.x).toBe(0.24);
  });
});

describe('roundFraction', () => {
  it('keeps three decimals and stays in 0..1', () => {
    expect(roundFraction(0.123456)).toBe(0.123);
    expect(roundFraction(-2)).toBe(0);
    expect(roundFraction(9)).toBe(1);
    expect(roundFraction(Number.NaN)).toBe(1);
  });
});
