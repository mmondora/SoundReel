import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The IFrame API script is loaded once; a load that fails is forgotten, so that the first real play after a warm-up
// that failed at page load tries again instead of inheriting the failure.

const scripts = () => Array.from(document.head.querySelectorAll('script[data-sr-yt]'));

async function freshModule() {
  vi.resetModules();
  return import('./youtubeApi');
}

beforeEach(() => {
  vi.useFakeTimers();
  scripts().forEach((s) => s.remove());
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

afterEach(() => {
  vi.useRealTimers();
  scripts().forEach((s) => s.remove());
  delete (window as unknown as { YT?: unknown }).YT;
});

describe('loadYoutubeApi', () => {
  it('is ready at once when the API is already there', async () => {
    (window as unknown as { YT: unknown }).YT = { Player: class {} };
    const { loadYoutubeApi } = await freshModule();
    await expect(loadYoutubeApi()).resolves.toBeUndefined();
    expect(scripts()).toHaveLength(0);
  });

  it('adds the script ONCE however often it is asked, and resolves when YouTube says it is ready', async () => {
    const { loadYoutubeApi } = await freshModule();
    const first = loadYoutubeApi();
    const second = loadYoutubeApi();
    expect(first).toBe(second);
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0].getAttribute('src')).toBe('https://www.youtube.com/iframe_api');
    (window as unknown as { YT: unknown }).YT = { Player: class {} };
    window.onYouTubeIframeAPIReady?.();
    await expect(first).resolves.toBeUndefined();
  });

  it('a failed load is forgotten: the next attempt adds a fresh script', async () => {
    const { loadYoutubeApi } = await freshModule();
    const failed = loadYoutubeApi();
    scripts()[0].dispatchEvent(new Event('error'));
    await expect(failed).rejects.toThrow('YouTube API load failed');
    expect(scripts()).toHaveLength(0);

    const retry = loadYoutubeApi();
    expect(retry).not.toBe(failed);
    expect(scripts()).toHaveLength(1);
    (window as unknown as { YT: unknown }).YT = { Player: class {} };
    window.onYouTubeIframeAPIReady?.();
    await expect(retry).resolves.toBeUndefined();
  });

  it('a load that never answers times out after 15 s and can be retried too', async () => {
    const { loadYoutubeApi } = await freshModule();
    const slow = loadYoutubeApi();
    const caught = slow.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_100);
    expect(((await caught) as Error).message).toBe('YouTube API timeout');
    expect(scripts()).toHaveLength(0);
    expect(loadYoutubeApi()).not.toBe(slow);
    expect(scripts()).toHaveLength(1);
  });
});
