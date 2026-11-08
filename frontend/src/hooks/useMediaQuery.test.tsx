import '@testing-library/jest-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PHONE_QUERY, useMediaQuery } from './useMediaQuery';

type Listener = () => void;

function stubMatchMedia(initial: boolean) {
  const state = { matches: initial };
  const listeners = new Set<Listener>();
  const removed = vi.fn();
  window.matchMedia = vi.fn((media: string) => ({
    get matches() { return state.matches; },
    media,
    addEventListener: (_type: string, fn: Listener) => { listeners.add(fn); },
    removeEventListener: (_type: string, fn: Listener) => { listeners.delete(fn); removed(); },
  })) as unknown as typeof window.matchMedia;
  return {
    set(matches: boolean) { state.matches = matches; act(() => listeners.forEach((fn) => fn())); },
    listeners,
    removed,
  };
}

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe('useMediaQuery', () => {
  it('the phone breakpoint is the one the stylesheets use', () => {
    expect(PHONE_QUERY).toBe('(max-width: 640px)');
  });

  it('says whether the query matches now', () => {
    stubMatchMedia(true);
    expect(renderHook(() => useMediaQuery(PHONE_QUERY)).result.current).toBe(true);
    stubMatchMedia(false);
    expect(renderHook(() => useMediaQuery(PHONE_QUERY)).result.current).toBe(false);
  });

  it('follows the screen: a phone turned sideways, a window resized', () => {
    const screen = stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery(PHONE_QUERY));
    expect(result.current).toBe(true);
    screen.set(false);
    expect(result.current).toBe(false);
    screen.set(true);
    expect(result.current).toBe(true);
  });

  it('stops listening when the component goes away', () => {
    const screen = stubMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery(PHONE_QUERY));
    expect(screen.listeners.size).toBe(1);
    unmount();
    expect(screen.listeners.size).toBe(0);
  });

  it('never matches where the browser has no matchMedia (a test environment, an old browser)', () => {
    expect(typeof window.matchMedia).not.toBe('function');
    expect(renderHook(() => useMediaQuery(PHONE_QUERY)).result.current).toBe(false);
  });
});
