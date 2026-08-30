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

describe('transcribeLocal', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.WHISPER_URL = 'http://gpu-router.test:9000/whisper';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withAudio(status: number) {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        promises: {
          ...actual.promises,
          stat: vi.fn(async () => ({ isFile: () => true, size: 128 })),
          readFile: vi.fn(async () => Buffer.from('fake wav')),
        },
      };
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })));
    const { transcribeLocal } = await import('./whisperClient');
    return transcribeLocal('/data/media/e1/audio.wav');
  }

  // The caller has to tell "the router has no capacity right now" (503) from
  // "the service broke" without parsing the reason string: one defers, the
  // other burns the job's last attempt.
  it('reports the HTTP status alongside the error on a 503', async () => {
    const res = await withAudio(503);
    expect(res.status).toBe('error');
    expect(res.httpStatus).toBe(503);
  });

  it('reports the HTTP status on other error codes too', async () => {
    const res = await withAudio(500);
    expect(res.status).toBe('error');
    expect(res.httpStatus).toBe(500);
  });
});
