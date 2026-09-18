import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * spec-060 — generazione AI sempre via gpu-router.
 *
 * Due 503 che si somigliano ma vogliono reazioni opposte, e un segnale di fine
 * batch che non deve mai far male a chi lo manda.
 */
describe('spec-060: classificazione delle risposte del router', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_URL = 'http://gpu-router:9000';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function risposta(status: number, headers: Record<string, string> = {}, body = '') {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => body,
      json: async () => JSON.parse(body || '{}'),
    };
  }

  // 503 CON l'header: la macchina non si riesce a portare su. Ritentare non la
  // accende — serve un intervento umano.
  it('503 con X-Backend-Unavailable → non ritentabile, con la capability dentro', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(risposta(503, { 'x-backend-unavailable': 'ollama' })));
    const { generateText, BackendUnavailableError } = await import('./ollamaClient');
    await expect(generateText('ciao')).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(generateText('ciao')).rejects.toMatchObject({ capability: 'ollama' });
  });

  // 503 SENZA header: il router sta svegliando o accodando. Passa da sé.
  it('503 senza header → transitorio, si ritenta', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(risposta(503)));
    const { generateText, OllamaTransientError } = await import('./ollamaClient');
    await expect(generateText('ciao')).rejects.toBeInstanceOf(OllamaTransientError);
    await expect(generateText('ciao')).rejects.toMatchObject({ category: 'transient_503' });
  });

  // La categoria che mancava: 42 chiamate su 75 sono morte così il 15 settembre
  // e nel journal erano indistinguibili da "non ho trovato niente".
  it('richiesta abortita → categoria propria, non un errore generico', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    const { generateText, OllamaTransientError } = await import('./ollamaClient');
    await expect(generateText('ciao')).rejects.toBeInstanceOf(OllamaTransientError);
    await expect(generateText('ciao')).rejects.toMatchObject({ category: 'aborted' });
  });

  it('il 503 della vision resta il caso suo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      risposta(503, {}, 'vision model not available on local GPU')
    ));
    const { generateText, VisionUnavailableError } = await import('./ollamaClient');
    await expect(generateText('ciao')).rejects.toBeInstanceOf(VisionUnavailableError);
  });
});

describe('spec-060: release del modello a fine batch', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_URL = 'http://gpu-router:9000';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bussa al router, non alla macchina', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ released: true, backends: ['archipc'] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { releaseModel } = await import('./ollamaClient');

    const esito = await releaseModel('qwen2.5:3b');

    expect(esito.released).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gpu-router:9000/router/release');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ model: 'qwen2.5:3b' });
  });

  // È un suggerimento: il router non scarica se ha altro lavoro, e va bene così.
  it('accetta il rifiuto quando la coda è attiva', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ released: false, reason: 'coda attiva' }),
    }));
    const { releaseModel } = await import('./ollamaClient');
    expect(await releaseModel()).toEqual({ released: false, reason: 'coda attiva' });
  });

  // Non è un requisito di correttezza: senza, ci pensa il keep_alive. Un
  // fallimento qui non deve toccare la passata che si è appena conclusa bene.
  it('non solleva mai, qualunque cosa risponda il router', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { releaseModel } = await import('./ollamaClient');
    await expect(releaseModel()).resolves.toMatchObject({ released: false });
  });
});
