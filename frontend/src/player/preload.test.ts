import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The YouTube side is warmed up ONCE, when the player page is idle (spec 2026-11-08-player-selection-and-filters-design
// §2/X6): preconnect to youtube.com and i.ytimg.com, and the IFrame API script — never twice, never at all for a page
// nobody opens, and a failed warm-up is not an error.

vi.mock('./youtubeApi', () => ({ loadYoutubeApi: vi.fn() }));

import { loadYoutubeApi } from './youtubeApi';
import {
  YOUTUBE_ORIGINS,
  addPreconnect,
  resetWarmUpForTests,
  scheduleYoutubeWarmUp,
  warmUpYoutube,
  whenIdle,
} from './preload';

const links = () => Array.from(document.head.querySelectorAll('link[rel="preconnect"]')).map((l) => l.getAttribute('href'));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(loadYoutubeApi).mockResolvedValue(undefined);
  resetWarmUpForTests();
  document.head.querySelectorAll('link[rel="preconnect"]').forEach((l) => l.remove());
  delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('whenIdle', () => {
  it('runs when the browser is idle, and can be cancelled', () => {
    const callbacks: Array<() => void> = [];
    const cancel = vi.fn();
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = vi.fn((cb: () => void) => { callbacks.push(cb); return 7; });
    (window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = cancel;
    const fn = vi.fn();
    whenIdle(fn);
    expect(fn).not.toHaveBeenCalled();
    callbacks[0]();
    expect(fn).toHaveBeenCalledTimes(1);
    const stop = whenIdle(vi.fn());
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('falls back to a timer where there is no idle callback', () => {
    const fn = vi.fn();
    whenIdle(fn, 1500);
    vi.advanceTimersByTime(1499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    whenIdle(cancelled, 1500)();
    vi.advanceTimersByTime(5000);
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe('preconnect', () => {
  it('opens connections to youtube.com and i.ytimg.com, once each however often it is asked', () => {
    expect(YOUTUBE_ORIGINS).toEqual(['https://www.youtube.com', 'https://i.ytimg.com']);
    addPreconnect();
    addPreconnect();
    expect(links()).toEqual(['https://www.youtube.com', 'https://i.ytimg.com']);
  });

  it('does not duplicate a hint the page already has', () => {
    const existing = document.createElement('link');
    existing.rel = 'preconnect';
    existing.href = 'https://www.youtube.com';
    document.head.appendChild(existing);
    addPreconnect();
    expect(links().filter((h) => h === 'https://www.youtube.com')).toHaveLength(1);
    expect(links()).toContain('https://i.ytimg.com');
  });
});

describe('the warm-up', () => {
  it('loads the IFrame API and connects ahead, once however often it is called', async () => {
    await warmUpYoutube();
    await warmUpYoutube();
    await warmUpYoutube();
    expect(loadYoutubeApi).toHaveBeenCalledTimes(1);
    expect(links()).toHaveLength(2);
  });

  it('a failure is not an error: the first real play will try again', async () => {
    vi.mocked(loadYoutubeApi).mockRejectedValueOnce(new Error('offline'));
    await expect(warmUpYoutube()).resolves.toBeUndefined();
    expect(loadYoutubeApi).toHaveBeenCalledTimes(1);
  });

  it('happens when the page is idle, not before', () => {
    scheduleYoutubeWarmUp();
    expect(loadYoutubeApi).not.toHaveBeenCalled();
    expect(links()).toHaveLength(0);
    vi.advanceTimersByTime(1500);
    expect(loadYoutubeApi).toHaveBeenCalledTimes(1);
    expect(links()).toHaveLength(2);
  });

  it('two pages asking before it ran, or one asking after it ran, still make ONE warm-up', () => {
    scheduleYoutubeWarmUp();
    scheduleYoutubeWarmUp();
    vi.advanceTimersByTime(5000);
    expect(loadYoutubeApi).toHaveBeenCalledTimes(1);
    scheduleYoutubeWarmUp();
    vi.advanceTimersByTime(5000);
    expect(loadYoutubeApi).toHaveBeenCalledTimes(1);
    expect(links()).toHaveLength(2);
  });

  it('leaving the page before it is idle cancels it', () => {
    const cancel = scheduleYoutubeWarmUp();
    cancel();
    vi.advanceTimersByTime(5000);
    expect(loadYoutubeApi).not.toHaveBeenCalled();
    expect(links()).toHaveLength(0);
  });
});
