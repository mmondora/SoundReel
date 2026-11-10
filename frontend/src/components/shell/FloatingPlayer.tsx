import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { useUiPrefs } from '../../hooks/useUiPrefs';
import { useLanguage } from '../../i18n';
import { clampOrigin, fractionFromOrigin, nudge, pillOrigin, type Area, type Fraction, type Origin, type Size } from '../../utils/floatPosition';
import { Controls, NowPlaying, OpenPlayerLink } from './playerParts';

// The floating Player (look and feel P4, spec 2026-11-10-web-look-and-feel-rethink-design.md L3, Michele: «si, ma spostabile»): a small pill over the
// page that is dragged by its grip or moved with the arrow keys. Its place is saved on the server as two fractions of the free area (docs/ui-prefs.md:
// `player.float`, 0..1, (1, 1) the bottom right corner), so the same choice fits any window; the pixels are worked out here, from the page and the
// pill as they are NOW (`utils/floatPosition.ts`), so a smaller window never leaves it outside. It only shows and drives the player: it starts nothing.

/** A moment after the last key, the place is saved (one request for a run of arrows, not one for each). */
export const KEY_SAVE_DELAY_MS = 600;
/** Under this many pixels a press is a click, not the start of a drag. */
const DRAG_SLOP = 3;

const NO_AREA: Area = { left: 0, top: 0, width: 0, height: 0 };
const NO_SIZE: Size = { width: 0, height: 0 };

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Origin;
  moved: boolean;
}

export function FloatingPlayer({ areaRef }: { areaRef: RefObject<HTMLElement | null> }) {
  const { t } = useLanguage();
  const { prefs, update } = useUiPrefs();
  // the place the server has: it is only here that a start place is needed, and it is the corner where the player begins (docs/ui-prefs.md)
  const saved: Fraction = prefs?.player.float ?? { x: 1, y: 1 };
  const [pos, setPos] = useState<Fraction>(saved);
  const [area, setArea] = useState<Area>(NO_AREA);
  const [size, setSize] = useState<Size>(NO_SIZE);
  const [measured, setMeasured] = useState(false);
  /** While the pill is dragged it follows the pointer in pixels (no rounding); the fractions are worked out when it is dropped. */
  const [live, setLive] = useState<Origin | null>(null);
  const pillRef = useRef<HTMLElement>(null);
  const drag = useRef<Drag | null>(null);
  const posRef = useRef<Fraction>(pos);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const updateRef = useRef(update);
  updateRef.current = update;

  /** The page and the pill as they are now (the window may have changed since the last time). */
  const measure = useCallback((): { area: Area; size: Size } => {
    const a = areaRef.current?.getBoundingClientRect();
    const s = pillRef.current?.getBoundingClientRect();
    const nextArea = a ? { left: a.left, top: a.top, width: a.width, height: a.height } : NO_AREA;
    const nextSize = s ? { width: s.width, height: s.height } : NO_SIZE;
    setArea(nextArea);
    setSize(nextSize);
    setMeasured(true);
    return { area: nextArea, size: nextSize };
  }, [areaRef]);

  useLayoutEffect(() => { measure(); }, [measure]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // the server's place wins when nobody is moving the pill (a refused move gives the old place back; another device may have moved it)
  useEffect(() => {
    if (drag.current || saveTimer.current !== undefined) return;
    posRef.current = saved;
    setPos(saved);
  }, [saved.x, saved.y]);        // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(() => {
    saveTimer.current = undefined;
    void updateRef.current({ player: { float: posRef.current } });
  }, []);

  // a move that is still waiting when the pill goes away is saved, not lost
  useEffect(() => () => {
    if (saveTimer.current !== undefined) {
      clearTimeout(saveTimer.current);
      flush();
    }
  }, [flush]);

  const place = (next: Fraction) => {
    posRef.current = next;
    setPos(next);
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const now = measure();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: pillOrigin(posRef.current, now.area, now.size),
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    d.moved = true;
    const origin = clampOrigin({ left: d.origin.left + dx, top: d.origin.top + dy }, area, size);
    posRef.current = fractionFromOrigin(origin, area, size);
    setLive(origin);
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>, keep: boolean) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setLive(null);
    if (keep && d.moved) {
      setPos(posRef.current);
      void update({ player: { float: posRef.current } });
    } else if (!keep) {
      place(saved);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nudge(posRef.current, event.key, event.shiftKey);
    if (!next) return;
    event.preventDefault();                               // the arrows move the pill, they do not scroll the page
    if (next.x === posRef.current.x && next.y === posRef.current.y) return;
    place(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, KEY_SAVE_DELAY_MS);
  };

  const origin = live ?? pillOrigin(pos, area, size);
  return (
    <section
      ref={pillRef}
      className="shell-float"
      aria-label={t.shellPlayerLabel}
      style={{ left: origin.left, top: origin.top, visibility: measured ? 'visible' : 'hidden' }}
    >
      <button
        type="button"
        className="shell-float-grip"
        aria-label={t.floatMove}
        title={t.floatMove}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finishDrag(e, true)}
        onPointerCancel={(e) => finishDrag(e, false)}
        onKeyDown={onKeyDown}
      >
        <svg className="shell-ic" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" />
        </svg>
      </button>
      <NowPlaying />
      <Controls />
      <OpenPlayerLink />
    </section>
  );
}
