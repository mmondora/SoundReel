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

  it('manda un fotogramma per richiesta', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rispondi('prima scena'))
      .mockResolvedValueOnce(rispondi('seconda scena'))
      .mockResolvedValueOnce(rispondi('terza scena'))
      .mockResolvedValueOnce(rispondi('quarta scena'))
      .mockResolvedValueOnce(rispondi('quinta scena'));
    vi.stubGlobal('fetch', fetchMock);
    const { describeFramesWithVision } = await conFrameFinti();

    await describeFramesWithVision(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']);

    // Cinque insieme sforavano il contesto (3716 token contro 2048), e anche
    // due per volta erano sprecate: moondream ne descrive comunque una sola.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse((init as { body: string }).body);
      expect(body.images).toHaveLength(1);
    }
  });

  /**
   * La scoperta del 19 settembre: la vision non aveva mai prodotto niente, e
   * la causa era il prompt. Sullo stesso fotogramma, misurato:
   *
   *   prompt lungo con negazione -> 1 token, risposta vuota
   *   "Describe the scene."      -> 116 token, descrizione corretta
   */
  it('chiede con una domanda semplice, non con un elenco di istruzioni', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi('descrizione'));
    vi.stubGlobal('fetch', fetchMock);
    const { describeFramesWithVision } = await conFrameFinti();

    await describeFramesWithVision(['a.jpg']);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.prompt.length).toBeLessThan(60);
    expect(body.prompt).not.toMatch(/\bNOT\b/);
  });

  // Fotogrammi vicini della stessa scena danno la stessa identica descrizione.
  it('non ripete tre volte la stessa descrizione', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi('una donna davanti a una finestra'));
    vi.stubGlobal('fetch', fetchMock);
    const { describeFramesWithVision } = await conFrameFinti();

    expect(await describeFramesWithVision(['a.jpg', 'b.jpg', 'c.jpg']))
      .toBe('una donna davanti a una finestra');
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
