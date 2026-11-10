import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBED_BATCH, EMBED_MODEL, EMBED_PREFIX, embedTexts, embeddingTextHash, entryEmbeddingText, postToRouter } from './embeddings';

// Raccolte, task 1 (spec 2026-11-09-library-collections-auto-topics-design.md §3.1, ADR-0022): the text of an entry that is turned into a vector, and the call
// to the local router that does it (`nomic-embed-text` through `/api/embed`, batches of 32, every text prefixed `clustering: `). No test touches the network.

const entry = (over: { caption?: string | null; summary?: string | null; tags?: unknown[] } = {}) => ({
  caption: over.caption ?? null,
  results: { summary: over.summary ?? null, tags: (over.tags ?? []) as string[] },
});

describe('entryEmbeddingText', () => {
  it('uses the summary when there is one (and not the caption)', () => {
    const text = entryEmbeddingText(entry({ summary: '  Cinque vini italiani da provare questo inverno.  ', caption: 'una didascalia lunga che non si usa' }));
    expect(text).toBe('Cinque vini italiani da provare questo inverno.');
  });

  it('without a summary it uses the caption, cut at 400 characters', () => {
    const caption = 'a'.repeat(300) + ' ' + 'b'.repeat(300);
    const text = entryEmbeddingText(entry({ caption }));
    expect(text).toHaveLength(400);
    expect(text?.startsWith('a'.repeat(300))).toBe(true);
    expect(entryEmbeddingText(entry({ summary: '   ', caption: 'Una didascalia abbastanza lunga da bastare.' }))).toBe('Una didascalia abbastanza lunga da bastare.');
  });

  it('adds the tags without the #, never more than twelve, in their order and once each (case does not make a new tag)', () => {
    const tags = ['#Vino', 'vino', '#cantina', '#Vitigni', '#prezzi', '#bollicine', '#rosso', '#bianco', '#etichetta', '#sommelier', '#annata', '#degustazione', '#tredicesimo', '#quattordicesimo'];
    const text = entryEmbeddingText(entry({ summary: 'Una guida ai vini italiani e ai loro prezzi.', tags })) as string;
    const extra = text.slice('Una guida ai vini italiani e ai loro prezzi.'.length).trim().split(/\s+/);
    expect(extra).toEqual(['Vino', 'cantina', 'Vitigni', 'prezzi', 'bollicine', 'rosso', 'bianco', 'etichetta', 'sommelier', 'annata', 'degustazione', 'tredicesimo']);
    expect(text).not.toContain('#');
    expect(text).not.toContain('quattordicesimo');
  });

  it.each(['#tag', '@utente', '#fyp', '#viral', '#perte', '#foryou', '#foryoupage', '#reels', '#instagram', '#explore', '#trending', '#x', '#hashtag', '#FYP', '#Viral', '@qualcuno', '@Mario_Rossi'])(
    'the placeholder or noise tag %s is not added',
    (tag) => {
      const summary = 'Un riassunto lungo abbastanza per bastare da solo.';
      expect(entryEmbeddingText(entry({ summary, tags: [tag, '#montagna'] }))).toBe(`${summary}\nmontagna`);
    },
  );

  it('a tag that merely CONTAINS a noise word is kept (#xfiles, #viralvideo is not #viral)', () => {
    const text = entryEmbeddingText(entry({ summary: 'Un riassunto lungo abbastanza per bastare da solo.', tags: ['#xfiles', '#tagliatelle'] })) as string;
    expect(text).toContain('xfiles');
    expect(text).toContain('tagliatelle');
  });

  it('is cut at 1400 characters', () => {
    const text = entryEmbeddingText(entry({ summary: 'parola '.repeat(400), tags: ['#vino'] })) as string;
    expect(text).toHaveLength(1400);
  });

  it('under 25 characters there is nothing to say: null (also with nothing at all, and with only noise tags)', () => {
    expect(entryEmbeddingText(entry({ summary: 'Troppo corto.' }))).toBeNull();
    expect(entryEmbeddingText(entry({}))).toBeNull();
    expect(entryEmbeddingText(entry({ tags: ['#tag', '@utente', '#fyp'] }))).toBeNull();
    expect(entryEmbeddingText(entry({ summary: 'a'.repeat(24) }))).toBeNull();
    expect(entryEmbeddingText(entry({ summary: 'a'.repeat(25) }))).toHaveLength(25);
  });

  it('a short summary is helped by its tags (the 25 characters are those of the whole text)', () => {
    expect(entryEmbeddingText(entry({ summary: 'Vini rossi.', tags: ['#cantina', '#vitigni', '#prezzi'] }))).toBe('Vini rossi.\ncantina vitigni prezzi');
  });

  it('survives rows that are not clean (tags that are not text, a missing results)', () => {
    expect(entryEmbeddingText(entry({ summary: 'Un riassunto lungo abbastanza per bastare da solo.', tags: [3, null, undefined, '#vino', { a: 1 }] }))).toContain('vino');
    expect(entryEmbeddingText({ caption: 'Una didascalia abbastanza lunga da bastare.', results: undefined as never })).toBe('Una didascalia abbastanza lunga da bastare.');
  });

  it('the same entry gives the same text, always', () => {
    const e = entry({ summary: 'Riassunto uguale ogni volta, abbastanza lungo.', tags: ['#a1', '#b2'] });
    expect(entryEmbeddingText(e)).toBe(entryEmbeddingText(e));
  });
});

describe('embeddingTextHash', () => {
  it('is the same for the same text, different for another, and hexadecimal', () => {
    expect(embeddingTextHash('vino')).toBe(embeddingTextHash('vino'));
    expect(embeddingTextHash('vino')).not.toBe(embeddingTextHash('vini'));
    expect(embeddingTextHash('vino')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('embedTexts', () => {
  const fake = () => {
    const calls: Array<{ url: string; body: { model: string; input: string[] } }> = [];
    let n = 0;
    const post = vi.fn(async (url: string, body: unknown) => {
      const b = body as { model: string; input: string[] };
      calls.push({ url, body: b });
      return { embeddings: b.input.map(() => [n++, 0.5]) };            // the first number of a vector says which text it is
    });
    return { post, calls };
  };

  afterEach(() => { delete process.env.OLLAMA_URL; });

  it('asks the router for `nomic-embed-text` on /api/embed, every text with the prefix `clustering: `', async () => {
    process.env.OLLAMA_URL = 'http://router.test:9000';
    const { post, calls } = fake();
    const out = await embedTexts(['uno', 'due'], { post });
    expect(EMBED_MODEL).toBe('nomic-embed-text');
    expect(EMBED_PREFIX).toBe('clustering: ');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://router.test:9000/api/embed');
    expect(calls[0].body).toEqual({ model: 'nomic-embed-text', input: ['clustering: uno', 'clustering: due'] });
    expect(out).toEqual([[0, 0.5], [1, 0.5]]);
  });

  it('without OLLAMA_URL it is the router of the house network', async () => {
    const { post, calls } = fake();
    await embedTexts(['uno'], { post });
    expect(calls[0].url).toBe('http://gpu-router:9000/api/embed');
  });

  it('batches of 32: 70 texts are 3 calls, and the vectors come back in the order of the texts', async () => {
    expect(EMBED_BATCH).toBe(32);
    const { post, calls } = fake();
    const texts = Array.from({ length: 70 }, (_, i) => `testo ${i}`);
    const out = await embedTexts(texts, { post });
    expect(calls.map((c) => c.body.input.length)).toEqual([32, 32, 6]);
    expect(calls[2].body.input[5]).toBe('clustering: testo 69');
    expect(out).toHaveLength(70);
    expect(out.map((v) => v[0])).toEqual(Array.from({ length: 70 }, (_, i) => i));
  });

  it('exactly 32 texts are one call; none is no call', async () => {
    const one = fake();
    await embedTexts(Array.from({ length: 32 }, (_, i) => `t${i}`), { post: one.post });
    expect(one.calls).toHaveLength(1);
    const none = fake();
    await expect(embedTexts([], { post: none.post })).resolves.toEqual([]);
    expect(none.post).not.toHaveBeenCalled();
  });

  it('an answer with a different number of vectors than texts is an error, not a shifted result', async () => {
    const post = vi.fn(async () => ({ embeddings: [[1, 2]] }));
    await expect(embedTexts(['a', 'b'], { post })).rejects.toThrow(/1 vectors for 2 texts/);
  });

  it('a failure of the router goes up to the caller (the step is retried by whoever calls)', async () => {
    const post = vi.fn(async () => { throw new Error('router down'); });
    await expect(embedTexts(['a'], { post })).rejects.toThrow('router down');
  });

  it('does not change the list it is given', async () => {
    const texts = ['uno', 'due'];
    await embedTexts(texts, { post: fake().post });
    expect(texts).toEqual(['uno', 'due']);
  });
});

describe('postToRouter (the real call, with the network stubbed)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends JSON and returns the embeddings of the answer', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ model: 'nomic-embed-text', embeddings: [[0.1, 0.2]] }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const out = await postToRouter('http://router.test/api/embed', { model: 'm', input: ['a'] });
    expect(out).toEqual({ embeddings: [[0.1, 0.2]] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://router.test/api/embed');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'm', input: ['a'] });
    expect(init.signal).toBeDefined();
  });

  it('an error answer is an error with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('model not found', { status: 404 })));
    await expect(postToRouter('http://router.test/api/embed', {})).rejects.toThrow(/404/);
  });

  it('an answer that is not vectors is an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })));
    await expect(postToRouter('http://router.test/api/embed', {})).rejects.toThrow(/embeddings/);
  });
});
