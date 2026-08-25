import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('isWhisperReachable', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://whisper.test:9000';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is true when whisper answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const { isWhisperReachable } = await import('./whisperClient');
    await expect(isWhisperReachable()).resolves.toBe(true);
  });

  it('is false when the connection is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const { isWhisperReachable } = await import('./whisperClient');
    await expect(isWhisperReachable()).resolves.toBe(false);
  });

  it('is false when WHISPER_URL is not configured', async () => {
    delete process.env.WHISPER_URL;
    vi.stubGlobal('fetch', vi.fn());
    const { isWhisperReachable } = await import('./whisperClient');
    await expect(isWhisperReachable()).resolves.toBe(false);
  });

  it('is false on a server error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    const { isWhisperReachable } = await import('./whisperClient');
    await expect(isWhisperReachable()).resolves.toBe(false);
  });
});
