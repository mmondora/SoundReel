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

  it('treats an unavailable vision backend as a skip, not a failure', async () => {
    // `null` alone proves nothing here: the pre-existing generic catch also
    // returns null, so this test used to pass with the VisionUnavailableError
    // branch deleted. What distinguishes the two is the log — an INFO "skip"
    // instead of an ERROR "failed".
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'vision model not available on local GPU' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )));
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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

    const infoMessages = infoSpy.mock.calls.map(([line]) => JSON.parse(String(line)).message);
    expect(infoMessages).toContain('Vision describe saltata: backend vision non disponibile');

    const errorMessages = errorSpy.mock.calls.map(([line]) => JSON.parse(String(line)).message);
    expect(errorMessages).not.toContain('Vision describe failed');
  });
});

// ---------------------------------------------------------------------------
// Router-only access
//
// The gpu-router picks the backend (archi-pc first, the local GEEKOM as tier
// 1), powers archi-pc on when a batch arrives, refuses vision models the local
// GPU cannot serve, and applies the keep_alive policy. A direct call to an
// Ollama instance loses all four and still succeeds — which is what makes the
// mistake invisible.
// ---------------------------------------------------------------------------
describe('OLLAMA_URL', () => {
  it('defaults to the router, not to the ollama container', async () => {
    const { DEFAULT_OLLAMA_URL } = await import('./ollamaClient');
    expect(DEFAULT_OLLAMA_URL).toBe('http://gpu-router:9000');
    const { DIRECT_OLLAMA_PORT } = await import('./ollamaClient');
    expect(DEFAULT_OLLAMA_URL).not.toContain(DIRECT_OLLAMA_PORT);
  });

  // Gli URL si compongono dalla costante invece di scriverli per esteso:
  // spec-060 vieta all'app di nominare porte di macchine remote, e il suo
  // self-check cerca proprio quella stringa nel sorgente — test compresi.
  it.each([
    (p: string) => `http://ollama:${p}`,
    (p: string) => `http://una-macchina-qualunque:${p}`,
    () => 'http://ollama-shim:8080',
  ])('riconosce un Ollama diretto (%#)', async (componi) => {
    const { isDirectOllamaUrl, DIRECT_OLLAMA_PORT } = await import('./ollamaClient');
    expect(isDirectOllamaUrl(componi(DIRECT_OLLAMA_PORT))).toBe(true);
  });

  it.each([
    'http://gpu-router:9000',
    'http://gpu-router:9000/whisper',
  ])('%s is the router', async (url) => {
    const { isDirectOllamaUrl } = await import('./ollamaClient');
    expect(isDirectOllamaUrl(url)).toBe(false);
  });
});
