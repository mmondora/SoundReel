import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L'8 novembre, sullo stesso reel, il modello con `format: "json"` ha scritto una chiave presa da una riga di istruzioni
 * del prompt (`movies_serie_tv_film_menzionati_citati_...`) e poi "sorry, I misunderstood the prompt" in chiaro; al
 * tentativo dopo e' andato in loop fino ai 4096 token. `format: "json"` garantisce JSON valido, non le chiavi giuste.
 * Uno JSON Schema nel campo `format` si': Ollama vincola chiavi e tipi (structured outputs).
 *
 * E la risposta deve dire al chiamante se e' stata tagliata sul tetto di token: prima lo scriveva solo nel log.
 */
describe('format con schema, e risposta tagliata', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_URL = 'http://gpu-router:9000';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const SCHEMA = { type: 'object', properties: { songs: { type: 'array', items: { type: 'string' } } }, required: ['songs'] };

  function rispondi(extra: Record<string, unknown> = {}) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{}',
      json: async () => ({ response: '{"songs":[]}', prompt_eval_count: 10, eval_count: 20, done_reason: 'stop', ...extra }),
    };
  }
  const corpoDi = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);

  it('manda lo schema come format, al posto della semplice stringa "json"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi());
    vi.stubGlobal('fetch', fetchMock);
    const { generateText } = await import('./ollamaClient');

    await generateText('prompt', [], { json: true, schema: SCHEMA });
    expect(corpoDi(fetchMock).format).toEqual(SCHEMA);
  });

  it('con json e senza schema resta "json" come prima', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi());
    vi.stubGlobal('fetch', fetchMock);
    const { generateText } = await import('./ollamaClient');

    await generateText('prompt', [], { json: true });
    expect(corpoDi(fetchMock).format).toBe('json');
  });

  it('uno schema senza json non impone niente: chi non chiede JSON continua a leggere testo libero', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi());
    vi.stubGlobal('fetch', fetchMock);
    const { generateText } = await import('./ollamaClient');

    await generateText('prompt', [], { schema: SCHEMA });
    expect(corpoDi(fetchMock).format).toBeUndefined();
  });

  it('non lo impone mai alla vision, nemmeno con uno schema', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rispondi());
    vi.stubGlobal('fetch', fetchMock);
    const fs = await import('fs');
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('finta') as never);
    const { generateText } = await import('./ollamaClient');

    await generateText('descrivi', [{ mimeType: 'image/jpeg', base64: 'AAA' }], { json: true, schema: SCHEMA });
    expect(corpoDi(fetchMock).format).toBeUndefined();
  });

  it('dice al chiamante che la risposta e\' stata tagliata dal tetto (done_reason length)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rispondi({ done_reason: 'length', eval_count: 4096 })));
    const { generateText } = await import('./ollamaClient');

    const res = await generateText('prompt', [], { json: true, schema: SCHEMA });
    expect(res.truncated).toBe(true);
  });

  it('lo dice anche quando il backend non riporta done_reason ma ha raggiunto il tetto di token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rispondi({ done_reason: undefined, eval_count: 4096 })));
    const { generateText } = await import('./ollamaClient');

    expect((await generateText('prompt', [], { json: true })).truncated).toBe(true);
  });

  it('una risposta finita regolarmente non e\' tagliata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rispondi()));
    const { generateText } = await import('./ollamaClient');

    const res = await generateText('prompt', [], { json: true, schema: SCHEMA });
    expect(res.truncated).toBe(false);
    expect(res.text).toBe('{"songs":[]}');
  });
});
