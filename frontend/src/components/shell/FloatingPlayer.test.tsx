import '@testing-library/jest-dom';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FloatingPlayer } from './FloatingPlayer';
import { UiPrefsProvider } from '../../hooks/useUiPrefs';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';
import * as api from '../../services/api';
import { fractionFromOrigin, pillOrigin } from '../../utils/floatPosition';
import { applyPrefsPatch } from '../../utils/uiPrefs';
import type { UiPrefs } from '../../types';

// The floating Player (look and feel P4, L3: «si, ma spostabile»): a small pill you drag by its grip or move with the arrow keys; its place is
// saved on the server as two fractions of the free area, so the same choice fits any window. It never starts anything by itself.

const player = {
  current: { songKey: 'kavinsky::nightcall', title: 'Nightcall', artist: 'Kavinsky' } as null | { songKey: string; title: string; artist: string },
  playing: false, currentTime: 83, duration: 258, queueLabel: null as string | null, loading: false, locationOverrides: {}, currentDownload: null,
  toggle: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn(),
};
vi.mock('../../player/PlayerContext', () => ({ usePlayer: () => player }));
vi.mock('../player/SourceSwitch', () => ({ SourceSwitch: () => null }));
vi.mock('../player/PlayingFrom', () => ({ PlayingFrom: () => null }));
vi.mock('../manager/DownloadChip', () => ({ DownloadChip: () => null }));
vi.mock('../LocationBadge', () => ({ LocationBadge: () => null }));
vi.mock('../../services/api', () => ({
  fetchUiPrefs: vi.fn(), saveUiPrefs: vi.fn(), resetUiPrefs: vi.fn(),
  UiPrefsAnonymousError: class UiPrefsAnonymousError extends Error {},
}));

const t = translations.en;
const AREA = { left: 232, top: 64, width: 1208, height: 760 };
const SIZE = { width: 360, height: 72 };
let area = { ...AREA };

const prefs = (float = { x: 1, y: 1 }): UiPrefs => ({
  v: 1, views: { inbox: 'studio', links: 'studio' },
  home: { sections: ['resume', 'songs', 'playlists', 'collections', 'films'].map((id) => ({ id, visible: true })) as UiPrefs['home']['sections'] },
  player: { dock: 'float', float },
});
const fetchPrefs = vi.mocked(api.fetchUiPrefs);
const savePrefs = vi.mocked(api.saveUiPrefs);

function fakeServer(start: UiPrefs): void {
  let doc = start;
  fetchPrefs.mockImplementation(async () => doc);
  savePrefs.mockImplementation(async (patch) => { doc = applyPrefsPatch(doc, patch); return doc; });
}

/** jsdom has no layout: the page and the pill are given the sizes of a 1440 × 824 window. */
function mockLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = this.getAttribute('data-testid') === 'area' ? area : this.classList.contains('shell-float') ? { left: 0, top: 0, ...SIZE } : { left: 0, top: 0, width: 0, height: 0 };
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
  });
}

async function renderPill(float = { x: 1, y: 1 }) {
  fakeServer(prefs(float));
  const areaRef = createRef<HTMLElement>();
  const view = render(
    <LanguageProvider>
      <MemoryRouter>
        <UiPrefsProvider>
          <main ref={areaRef} data-testid="area" />
          <FloatingPlayer areaRef={areaRef} />
        </UiPrefsProvider>
      </MemoryRouter>
    </LanguageProvider>,
  );
  const pill = await screen.findByRole('region', { name: t.shellPlayerLabel });
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
  return { ...view, pill, grip: screen.getByRole('button', { name: t.floatMove }) };
}

const where = (pill: HTMLElement) => ({ left: pill.style.left, top: pill.style.top });
const px = (o: { left: number; top: number }) => ({ left: `${o.left}px`, top: `${o.top}px` });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  area = { ...AREA };
  mockLayout();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the floating Player', () => {
  it('is a region named Player with the song, the controls and the link to the Player page, and starts nothing', async () => {
    const { pill } = await renderPill();
    expect(pill).toHaveTextContent('Nightcall');
    expect(pill).toHaveTextContent('Kavinsky');
    expect(screen.getByRole('button', { name: t.shellPlay })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.shellNext })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.shellPrevious })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t.shellOpenPlayer })).toHaveAttribute('href', '/player');
    expect(player.toggle).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: t.floatMove })).toHaveAttribute('aria-label', t.floatMove);       // a real name, not only the tooltip
  });

  it('sits where the configuration says: (1, 1) is the bottom right corner of the page, (0, 0) the top left, a margin in', async () => {
    const corner = await renderPill({ x: 1, y: 1 });
    expect(where(corner.pill)).toEqual(px(pillOrigin({ x: 1, y: 1 }, AREA, SIZE)));
    corner.unmount();
    const start = await renderPill({ x: 0, y: 0 });
    expect(where(start.pill)).toEqual(px(pillOrigin({ x: 0, y: 0 }, AREA, SIZE)));
    start.unmount();
    const middle = await renderPill({ x: 0.5, y: 0.25 });
    expect(where(middle.pill)).toEqual(px(pillOrigin({ x: 0.5, y: 0.25 }, AREA, SIZE)));
  });
});

describe('dragging by the grip', () => {
  it('follows the pointer while it moves, and the place is saved ONCE, on release, as fractions between 0 and 1', async () => {
    const { pill, grip } = await renderPill({ x: 1, y: 1 });
    const from = pillOrigin({ x: 1, y: 1 }, AREA, SIZE);
    fireEvent.pointerDown(grip, { clientX: 1000, clientY: 700, pointerId: 1, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 900, clientY: 600, pointerId: 1 });
    expect(where(pill)).toEqual(px({ left: from.left - 100, top: from.top - 100 }));
    fireEvent.pointerMove(grip, { clientX: 800, clientY: 500, pointerId: 1 });
    expect(savePrefs).not.toHaveBeenCalled();
    fireEvent.pointerUp(grip, { clientX: 800, clientY: 500, pointerId: 1 });
    const expected = fractionFromOrigin({ left: from.left - 200, top: from.top - 200 }, AREA, SIZE);
    expect(savePrefs).toHaveBeenCalledTimes(1);
    expect(savePrefs).toHaveBeenCalledWith({ player: { float: expected } });
    expect(expected.x).toBeGreaterThan(0);
    expect(expected.x).toBeLessThan(1);
    expect(parseFloat(pill.style.left)).toBeCloseTo(from.left - 200, 0);        // after the drop the place is the saved fraction: within half a pixel
    expect(parseFloat(pill.style.top)).toBeCloseTo(from.top - 200, 0);
  });

  it('a drag beyond the window stops at the edge: the saved place is 0 or 1, never outside', async () => {
    const { pill, grip } = await renderPill({ x: 0.5, y: 0.5 });
    fireEvent.pointerDown(grip, { clientX: 600, clientY: 400, pointerId: 2, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 99999, clientY: -99999, pointerId: 2 });
    const edge = pillOrigin({ x: 1, y: 0 }, AREA, SIZE);
    expect(parseFloat(pill.style.left)).toBeCloseTo(edge.left, 5);          // while it is dragged the pill stops at the edge, in pixels too
    expect(parseFloat(pill.style.top)).toBeCloseTo(edge.top, 5);
    fireEvent.pointerUp(grip, { clientX: 99999, clientY: -99999, pointerId: 2 });
    expect(savePrefs).toHaveBeenCalledWith({ player: { float: { x: 1, y: 0 } } });
  });

  it('a press on the grip that does not move saves nothing (it is just a click)', async () => {
    const { grip } = await renderPill();
    fireEvent.pointerDown(grip, { clientX: 500, clientY: 500, pointerId: 3, button: 0 });
    fireEvent.pointerUp(grip, { clientX: 500, clientY: 500, pointerId: 3 });
    expect(savePrefs).not.toHaveBeenCalled();
  });

  it('a tiny tremble of the hand (under 3 pixels) is not a drag', async () => {
    const { pill, grip } = await renderPill({ x: 1, y: 1 });
    const before = where(pill);
    fireEvent.pointerDown(grip, { clientX: 500, clientY: 500, pointerId: 4, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 501, clientY: 502, pointerId: 4 });
    fireEvent.pointerUp(grip, { clientX: 501, clientY: 502, pointerId: 4 });
    expect(where(pill)).toEqual(before);
    expect(savePrefs).not.toHaveBeenCalled();
  });

  it('only the main mouse button drags', async () => {
    const { pill, grip } = await renderPill();
    const before = where(pill);
    fireEvent.pointerDown(grip, { clientX: 500, clientY: 500, pointerId: 5, button: 2, pointerType: 'mouse' });
    fireEvent.pointerMove(grip, { clientX: 300, clientY: 300, pointerId: 5 });
    fireEvent.pointerUp(grip, { clientX: 300, clientY: 300, pointerId: 5 });
    expect(where(pill)).toEqual(before);
    expect(savePrefs).not.toHaveBeenCalled();
  });

  it('a movement of another pointer (a second finger) does not move it', async () => {
    const { pill, grip } = await renderPill();
    fireEvent.pointerDown(grip, { clientX: 500, clientY: 500, pointerId: 6, button: 0 });
    const before = where(pill);
    fireEvent.pointerMove(grip, { clientX: 100, clientY: 100, pointerId: 99 });
    expect(where(pill)).toEqual(before);
  });

  it('a drag that is interrupted (the system takes the pointer) goes back to the saved place and saves nothing', async () => {
    const { pill, grip } = await renderPill({ x: 1, y: 1 });
    const before = where(pill);
    fireEvent.pointerDown(grip, { clientX: 500, clientY: 500, pointerId: 7, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 300, clientY: 300, pointerId: 7 });
    expect(where(pill)).not.toEqual(before);
    fireEvent.pointerCancel(grip, { pointerId: 7 });
    expect(where(pill)).toEqual(before);
    expect(savePrefs).not.toHaveBeenCalled();
  });

  it('after an interrupted drag the keyboard starts from the saved place, not from where the drag was', async () => {
    const { grip } = await renderPill({ x: 0.5, y: 0.5 });
    vi.useFakeTimers();
    fireEvent.pointerDown(grip, { clientX: 500, clientY: 500, pointerId: 9, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 100, clientY: 100, pointerId: 9 });
    fireEvent.pointerCancel(grip, { pointerId: 9 });
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(savePrefs).toHaveBeenCalledWith({ player: { float: { x: 0.52, y: 0.5 } } });
  });

  it('a place the server refuses is not kept: the pill goes back', async () => {
    const { pill, grip } = await renderPill({ x: 1, y: 1 });
    const before = where(pill);
    savePrefs.mockRejectedValue(new Error('{"error":"invalid_prefs:player.float.x"}'));
    fireEvent.pointerDown(grip, { clientX: 500, clientY: 500, pointerId: 8, button: 0 });
    fireEvent.pointerMove(grip, { clientX: 300, clientY: 300, pointerId: 8 });
    fireEvent.pointerUp(grip, { clientX: 300, clientY: 300, pointerId: 8 });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(where(pill)).toEqual(before);
  });
});

describe('without a configuration', () => {
  it('the pill starts in the bottom right corner (the place where the Player has always been), never at the top left', async () => {
    fetchPrefs.mockRejectedValue(new Error('network down'));
    const areaRef = createRef<HTMLElement>();
    render(
      <LanguageProvider><MemoryRouter><UiPrefsProvider><main ref={areaRef} data-testid="area" /><FloatingPlayer areaRef={areaRef} /></UiPrefsProvider></MemoryRouter></LanguageProvider>,
    );
    const pill = await screen.findByRole('region', { name: t.shellPlayerLabel });
    await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
    expect(where(pill)).toEqual(px(pillOrigin({ x: 1, y: 1 }, AREA, SIZE)));
  });
});

describe('moving it with the keyboard', () => {
  it('an arrow moves it by 2 % of the free area, Shift by 10 %, and the place is saved once, a moment after the last key', async () => {
    const { pill, grip } = await renderPill({ x: 0.5, y: 0.5 });
    vi.useFakeTimers();
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    fireEvent.keyDown(grip, { key: 'ArrowUp', shiftKey: true });
    expect(where(pill)).toEqual(px(pillOrigin({ x: 0.46, y: 0.4 }, AREA, SIZE)));
    expect(savePrefs).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(savePrefs).toHaveBeenCalledTimes(1);
    expect(savePrefs).toHaveBeenCalledWith({ player: { float: { x: 0.46, y: 0.4 } } });
  });

  it('Home and End go to the corners; another key does nothing, not even a save', async () => {
    const { pill, grip } = await renderPill({ x: 0.5, y: 0.5 });
    vi.useFakeTimers();
    fireEvent.keyDown(grip, { key: 'a' });
    fireEvent.keyDown(grip, { key: 'Enter' });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(savePrefs).not.toHaveBeenCalled();
    fireEvent.keyDown(grip, { key: 'Home' });
    expect(where(pill)).toEqual(px(pillOrigin({ x: 0, y: 0 }, AREA, SIZE)));
    fireEvent.keyDown(grip, { key: 'End' });
    expect(where(pill)).toEqual(px(pillOrigin({ x: 1, y: 1 }, AREA, SIZE)));
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(savePrefs).toHaveBeenCalledTimes(1);
    expect(savePrefs).toHaveBeenCalledWith({ player: { float: { x: 1, y: 1 } } });
  });

  it('an arrow against the edge moves nothing and saves nothing', async () => {
    const { grip } = await renderPill({ x: 1, y: 1 });
    vi.useFakeTimers();
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(savePrefs).not.toHaveBeenCalled();
  });

  it('a move that is still waiting when the player goes away (a page, a place chosen in the panel) is saved, not lost', async () => {
    const { grip, unmount } = await renderPill({ x: 0.5, y: 0.5 });
    vi.useFakeTimers();
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    unmount();
    await act(async () => { await Promise.resolve(); });
    expect(savePrefs).toHaveBeenCalledWith({ player: { float: { x: 0.52, y: 0.5 } } });
  });

  it('the grip is a button the keyboard can reach, and the arrows do not scroll the page', async () => {
    const { grip } = await renderPill();
    grip.focus();
    expect(grip).toHaveFocus();
    const proceeded = fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    expect(proceeded).toBe(false);                                 // preventDefault was called
  });
});

describe('a window that changes', () => {
  it('a smaller window keeps the pill on screen: it sits at the same fractions of the new free area', async () => {
    const { pill } = await renderPill({ x: 1, y: 1 });
    area = { left: 76, top: 64, width: 700, height: 500 };           // a narrower window: the menu keeps only its icons
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    const origin = pillOrigin({ x: 1, y: 1 }, area, SIZE);
    expect(where(pill)).toEqual(px(origin));
    expect(origin.left + SIZE.width).toBeLessThanOrEqual(area.left + area.width);
    expect(origin.top + SIZE.height).toBeLessThanOrEqual(area.top + area.height);
  });

  it('a window smaller than the pill puts it at the start, never at a negative place', async () => {
    const { pill } = await renderPill({ x: 1, y: 1 });
    area = { left: 0, top: 64, width: 200, height: 40 };
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(parseFloat(pill.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(pill.style.top)).toBeGreaterThanOrEqual(0);
  });
});
