import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * spec-061 — coda async del gpu-router.
 *
 * Il guadagno non è velocità: la coda del router è una sola e serializza
 * comunque sulla GPU. È che nessuno resta appeso a una connessione per venti
 * minuti, che è come il 15 settembre abbiamo perso 42 chiamate su 75 — il
 * client mollava a 180s mentre il router stava ancora lavorando.
 */
describe('spec-061: coda async', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    process.env.OLLAMA_URL = 'http://gpu-router:9000';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function ok(body: unknown, headers: Record<string, string> = {}) {
    return {
      ok: true,
      status: 200,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }

  /** Fa girare la promise insieme ai timer finti del polling. */
  async function conPolling<T>(p: Promise<T>): Promise<T> {
    const atteso = p.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    const esito = await atteso;
    if (esito.ok) return esito.v;
    throw esito.e;
  }

  it('in modalità batch accoda con X-GPU-Queue e ritira il risultato', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ queued: true, job_id: 'j_ab12cd', status_url: '/router/queue/j_ab12cd' }))
      .mockResolvedValueOnce(ok({ id: 'j_ab12cd', status: 'queued', position: 2 }))
      .mockResolvedValueOnce(ok({ id: 'j_ab12cd', status: 'running' }))
      .mockResolvedValueOnce(ok({
        id: 'j_ab12cd', status: 'done',
        result: { response: 'ciao mondo', prompt_eval_count: 10, eval_count: 5 },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { generateText } = await import('./ollamaClient');
    const { runWithAiRequestMode } = await import('./aiRequestContext');

    const esito = await conPolling(
      runWithAiRequestMode({ queued: true }, () => generateText('prompt'))
    );

    expect(esito.text).toBe('ciao mondo');
    expect(esito.usageMetadata?.totalTokenCount).toBe(15);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gpu-router:9000/api/generate');
    expect((init as { headers: Record<string, string> }).headers['X-GPU-Queue']).toBe('1');
    // Il ritiro passa dallo status_url che ha dato il router, non da un
    // percorso ricostruito a mano.
    expect(fetchMock.mock.calls[1][0]).toBe('http://gpu-router:9000/router/queue/j_ab12cd');
  });

  // La chat interattiva ha qualcuno che guarda lo schermo: lì la connessione
  // tenuta è la cosa giusta, e l'header non deve comparire.
  it('fuori dal batch resta sincrona, senza header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ response: 'pronto', prompt_eval_count: 1, eval_count: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const { generateText } = await import('./ollamaClient');
    const esito = await generateText('prompt');

    expect(esito.text).toBe('pronto');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['X-GPU-Queue']).toBeUndefined();
  });

  // Un router non ancora aggiornato risponde come sempre: è una risposta
  // valida, non un errore. Così il deploy di Soundreel non è legato al suo.
  it('accetta la risposta piena di un router senza coda', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      ok({ response: 'risposta intera', prompt_eval_count: 2, eval_count: 3 })
    ));
    const { generateText } = await import('./ollamaClient');
    const { runWithAiRequestMode } = await import('./aiRequestContext');

    const esito = await conPolling(
      runWithAiRequestMode({ queued: true }, () => generateText('prompt'))
    );
    expect(esito.text).toBe('risposta intera');
  });

  it('un job fallito sul router è transitorio e dice quale', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ job_id: 'j_x' }))
      .mockResolvedValue(ok({ id: 'j_x', status: 'failed', error: 'modello non caricato' })));

    const { generateText, OllamaTransientError } = await import('./ollamaClient');
    const { runWithAiRequestMode } = await import('./aiRequestContext');

    // Una chiamata sola: il `mockResolvedValueOnce` del submit vale per la
    // prima, e una seconda generateText prenderebbe la risposta di poll come
    // se fosse il submit.
    const errore = await conPolling(
      runWithAiRequestMode({ queued: true }, () => generateText('p'))
    ).catch((e: unknown) => e);

    expect(errore).toBeInstanceOf(OllamaTransientError);
    expect(errore).toMatchObject({ category: 'queue_failed' });
    expect(String(errore)).toContain('modello non caricato');
  });

  it('un job scaduto prima del ritiro ha una categoria sua', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ job_id: 'j_y' }))
      .mockResolvedValue(ok({ id: 'j_y', status: 'expired' })));

    const { generateText } = await import('./ollamaClient');
    const { runWithAiRequestMode } = await import('./aiRequestContext');

    await expect(
      conPolling(runWithAiRequestMode({ queued: true }, () => generateText('p')))
    ).rejects.toMatchObject({ category: 'queue_expired' });
  });

  // L'id resta valido: un poll che va storto non deve perdere il lavoro che il
  // router sta già facendo.
  it('un poll fallito non perde il job, ribussa', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ job_id: 'j_z' }))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(ok({ id: 'j_z', status: 'done', result: { response: 'arrivato' } })));

    const { generateText } = await import('./ollamaClient');
    const { runWithAiRequestMode } = await import('./aiRequestContext');

    const esito = await conPolling(
      runWithAiRequestMode({ queued: true }, () => generateText('p'))
    );
    expect(esito.text).toBe('arrivato');
  });

  // spec-060 vale anche qui: il 503 con l'header non si ritenta.
  it('il 503 con X-Backend-Unavailable vale anche in accodamento', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 503,
      headers: { get: (k: string) => (k.toLowerCase() === 'x-backend-unavailable' ? 'ollama' : null) },
      text: async () => '',
      json: async () => ({}),
    }));

    const { generateText, BackendUnavailableError } = await import('./ollamaClient');
    const { runWithAiRequestMode } = await import('./aiRequestContext');

    await expect(
      runWithAiRequestMode({ queued: true }, () => generateText('p'))
    ).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});
