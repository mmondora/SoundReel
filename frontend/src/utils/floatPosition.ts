// The floating Player (look and feel P4, ADR-0026, docs/ui-prefs.md): its place is saved as two fractions of the FREE area (0..1; (1, 1) is the
// bottom right corner), so the same choice fits any window. The free area is the page (right of the menu, under the top bar) less the size of
// the pill and a margin all around, so a pill is never cut and never touches an edge. These are the pure rules; the component only measures.

export interface Area { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Fraction { x: number; y: number }
export interface Origin { left: number; top: number }

/** Pixels between the pill and the edge of the area, at 0 and at 1. */
export const FLOAT_MARGIN = 12;
/** An arrow moves the pill by this much of the free area; with Shift, the big step. */
export const KEY_STEP = 0.02;
export const KEY_STEP_BIG = 0.1;

/** In 0..1; a value that is not a finite number is the bottom right edge (where the pill starts), minus infinity is the start. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** What is saved: 0..1 with three decimals (no noise in the database). */
export function roundFraction(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

/** The room the pill can move in, along one axis. */
const room = (total: number, size: number): number => Math.max(0, total - size - 2 * FLOAT_MARGIN);

/** Fractions → the top left corner of the pill in pixels. */
export function pillOrigin(pos: Fraction, area: Area, size: Size): Origin {
  return {
    left: area.left + FLOAT_MARGIN + clamp01(pos.x) * room(area.width, size.width),
    top: area.top + FLOAT_MARGIN + clamp01(pos.y) * room(area.height, size.height),
  };
}

/** A corner held inside the free area, in pixels: while the pill is dragged it follows the pointer to the pixel until an edge stops it. */
export function clampOrigin(origin: Origin, area: Area, size: Size): Origin {
  const first = pillOrigin({ x: 0, y: 0 }, area, size);
  const last = pillOrigin({ x: 1, y: 1 }, area, size);
  return {
    left: Math.min(last.left, Math.max(first.left, origin.left)),
    top: Math.min(last.top, Math.max(first.top, origin.top)),
  };
}

/** Where the pill was dropped (its top left corner) → fractions, on the area at most: a drop beyond an edge lands on the edge. */
export function fractionFromOrigin(origin: Origin, area: Area, size: Size): Fraction {
  const roomX = room(area.width, size.width);
  const roomY = room(area.height, size.height);
  return {
    x: roundFraction(roomX === 0 ? 1 : (origin.left - area.left - FLOAT_MARGIN) / roomX),
    y: roundFraction(roomY === 0 ? 1 : (origin.top - area.top - FLOAT_MARGIN) / roomY),
  };
}

/** The place after a key, or null when the key moves nothing: arrows by a step (Shift: a big one), Home and End to the corners. */
export function nudge(pos: Fraction, key: string, shift: boolean): Fraction | null {
  const step = shift ? KEY_STEP_BIG : KEY_STEP;
  switch (key) {
    case 'ArrowLeft': return { x: roundFraction(pos.x - step), y: pos.y };
    case 'ArrowRight': return { x: roundFraction(pos.x + step), y: pos.y };
    case 'ArrowUp': return { x: pos.x, y: roundFraction(pos.y - step) };
    case 'ArrowDown': return { x: pos.x, y: roundFraction(pos.y + step) };
    case 'Home': return { x: 0, y: 0 };
    case 'End': return { x: 1, y: 1 };
    default: return null;
  }
}
