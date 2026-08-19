import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ollamaClient', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_URL = 'http://gpu-router:9000';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws VisionUnavailableError on the router 503 for vision models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'vision model not available on local GPU', model: 'moondream' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )));

    const { generateText, VisionUnavailableError } = await import('./ollamaClient');
    await expect(generateText('x', [{ mimeType: 'image/jpeg', base64: 'AAAA' }]))
      .rejects.toBeInstanceOf(VisionUnavailableError);
  });

  it('throws a plain error on an unrelated 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'no healthy backends' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )));

    const { generateText, VisionUnavailableError } = await import('./ollamaClient');
    await expect(generateText('x'))
      .rejects.not.toBeInstanceOf(VisionUnavailableError);
  });

  it('returns null from describeFramesWithVision when vision is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'vision model not available on local GPU' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )));

    // A real file, not a mocked fs: vi.mock() is hoisted out of the test body
    // and would not apply here anyway.
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'ollama-test-'));
    const frame = join(dir, 'frame1.jpg');
    await writeFile(frame, Buffer.from([0xff, 0xd8, 0xff]));

    const { describeFramesWithVision } = await import('./ollamaClient');
    await expect(describeFramesWithVision([frame])).resolves.toBeNull();
  });
});
