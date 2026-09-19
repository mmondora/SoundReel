import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Il 19 settembre la vision non ha mai funzionato, e il journal diceva solo
 * `vision_describe: skipped`. Il backend rispondeva 400:
 *
 *   request (3716 tokens) exceeds the available context size (2048 tokens)
 *
 * Cinque fotogrammi in una richiesta sola, a ~730 token l'uno, contro un
 * moondream servito con 2048 token di contesto. Il contesto lo decide chi
 * serve il modello; qui ci si adatta mandandone pochi per volta.
 */
describe('describeFramesWithVision', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_URL = 'http://gpu-router:9000';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Risposta piena del modello, con dentro il testo chiesto. */
  function rispondi(testo: string) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ response: testo }),
      json: async () => ({ response: testo, prompt_eval_count: 1, eval_count: 1 }),
    };
  }

  async function conFrameFinti() {
    const mod = await import('./ollamaClient');
    const fs = await import('fs');
    // pathToImage legge il file: gli si dà un'immagine minima invece di
    // toccare il disco.
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('finta') as never);
    return mod;
  }

  it('spezza cinque fotogrammi in richieste che stanno nel contesto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi('descrizione'));
    vi.stubGlobal('fetch', fetchMock);
    const { describeFramesWithVision } = await conFrameFinti();

    await describeFramesWithVision(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']);

    // 5 fotogrammi, 2 per volta → 3 richieste, nessuna con più di 2 immagini.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as { body: string }).body);
      expect(body.images.length).toBeLessThanOrEqual(2);
    }
  });

  it('unisce le descrizioni dei gruppi in un testo solo', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rispondi('prima parte'))
      .mockResolvedValueOnce(rispondi('seconda parte'));
    vi.stubGlobal('fetch', fetchMock);
    const { describeFramesWithVision } = await conFrameFinti();

    const testo = await describeFramesWithVision(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(testo).toBe('prima parte seconda parte');
  });

  // Una descrizione parziale vale più di nessuna descrizione.
  it('un gruppo perso non si porta via gli altri', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(rispondi('quel che resta'));
    vi.stubGlobal('fetch', fetchMock);
    const { describeFramesWithVision } = await conFrameFinti();

    expect(await describeFramesWithVision(['a.jpg', 'b.jpg', 'c.jpg'])).toBe('quel che resta');
  });

  // Se il backend non serve vision adesso, insistere sugli altri gruppi
  // significa solo prendersi lo stesso rifiuto tre volte.
  it('smette subito quando la vision non è disponibile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => 'vision model not available on local GPU',
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { describeFramesWithVision } = await conFrameFinti();

    expect(await describeFramesWithVision(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('senza fotogrammi non chiama nessuno', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { describeFramesWithVision } = await import('./ollamaClient');

    expect(await describeFramesWithVision([])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
