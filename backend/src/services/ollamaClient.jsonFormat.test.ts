import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Le 18 chiamate a Claude della passata del 20 settembre, su 58 entry.
 *
 * Non era qwen a non capire: il contenuto che produceva era giusto — note,
 * link, riassunto. Era la punteggiatura. Misurato sullo stesso prompt, tre
 * tentativi:
 *
 *   senza format  -> 1 parsata su 3, le altre con `"category: "quote"`
 *                    al posto di `"category": "quote"`
 *   format json   -> 3 su 3
 *
 * `format: "json"` vincola la generazione a produrre JSON valido, e toglie di
 * mezzo l'intera classe di errore: niente più analisi buone buttate, niente
 * più fallback a pagamento per rifarle.
 */
describe('format json', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_URL = 'http://gpu-router:9000';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function rispondi() {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{}',
      json: async () => ({ response: '{"songs":[]}', prompt_eval_count: 1, eval_count: 1 }),
    };
  }

  function corpoDi(fetchMock: ReturnType<typeof vi.fn>, chiamata = 0) {
    return JSON.parse((fetchMock.mock.calls[chiamata][1] as { body: string }).body);
  }

  it('lo chiede quando la risposta verrà letta come oggetto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi());
    vi.stubGlobal('fetch', fetchMock);
    const { generateText } = await import('./ollamaClient');

    await generateText('prompt', [], { json: true });
    expect(corpoDi(fetchMock).format).toBe('json');
  });

  // Chi si aspetta un array nudo non lo chiede: con format json il modello
  // incapsula l'array in un oggetto (`{"search_terms": [...]}`), e quei
  // chiamanti leggono la risposta libera.
  it('non lo impone a chi non lo ha chiesto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi());
    vi.stubGlobal('fetch', fetchMock);
    const { generateText } = await import('./ollamaClient');

    await generateText('prompt');
    expect(corpoDi(fetchMock).format).toBeUndefined();
  });

  // Con le immagini risponde moondream, a cui si chiede una descrizione in
  // prosa: vincolarlo al JSON avrebbe l'effetto opposto a quello voluto.
  it('non lo impone mai alla vision, nemmeno se richiesto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi());
    vi.stubGlobal('fetch', fetchMock);
    const fs = await import('fs');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('finta') as never);
    const { generateText } = await import('./ollamaClient');

    await generateText('descrivi', [{ mimeType: 'image/jpeg', base64: 'AAA' }], { json: true });

    const corpo = corpoDi(fetchMock);
    expect(corpo.format).toBeUndefined();
    expect(corpo.images).toHaveLength(1);
  });

  it('la descrizione dei fotogrammi resta in prosa', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => '{}',
      json: async () => ({ response: 'Una donna davanti a una finestra.', eval_count: 9 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const fs = await import('fs');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('finta') as never);
    const { describeFramesWithVision } = await import('./ollamaClient');

    await describeFramesWithVision(['a.jpg']);
    expect(corpoDi(fetchMock).format).toBeUndefined();
  });
});
