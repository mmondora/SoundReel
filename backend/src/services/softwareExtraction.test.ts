import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ollamaClient', () => ({ generateText: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import {
  MAX_EXTRACTED,
  SOFTWARE_MAX_TOKENS,
  SOFTWARE_SCHEMA,
  buildSoftwarePrompt,
  extractSoftware,
  isGrounded,
  looksLikeSoftware,
  mergeSoftware,
  parseSoftwareResponse,
  sourceTextOf,
  type GenerateFn,
} from './softwareExtraction';
import { logWarning } from '../utils/logger';

/** 8 November: the Cloudflare reel and the five-plugins reel, the two that started it. */
const CLOUDFLARE = {
  caption: 'Commenta "sicurezza" per il link alla repo. Security Audit Skill è la skill open source di Cloudflare: su GitHub ha superato le 65.000 stelle. Funziona con Claude Code, Codex e Cursor.',
  transcript: null,
  ocrText: 'github.com/cloudflare/security-audit-skill',
};
const PLUGINS = { caption: 'Commenta "PLUGIN" e ti mando i cinque link. FreeLLMAPI (quota illimitata), Strix, Cloud Mem.', transcript: null, ocrText: null };
const WINE = { caption: 'Cena al mare con Franco, che vino! Questo lo voglio riassaggiare #estate', transcript: null, ocrText: null };

const answer = (list: unknown[]) => JSON.stringify({ software: list });

beforeEach(() => vi.clearAllMocks());

describe('looksLikeSoftware: the gate in front of the second call', () => {
  it.each([
    [CLOUDFLARE.caption, true],
    [PLUGINS.caption, true],
    ['Questa app ti cambia la vita, scaricala', true],
    ['Il nuovo tool open source che sostituisce Photoshop', true],
    ['Scritto in Rust, installa con brew install ripgrep', true],
    [WINE.caption, false],
    ['Rice cookers, I love them #surrealart', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(looksLikeSoftware(text)).toBe(expected);
  });
});

describe('isGrounded: a name must really be in the text', () => {
  const text = 'Security Audit Skill di Cloudflare. FreeLLMAPI è gratis. Scritto in Go. github.com/cloudflare/security-audit-skill. Café Racer app.';
  it.each([
    ['Security Audit Skill', true],
    ['security audit skill', true],
    ['Free LLM API', true], // the model spells out what the caption glues together
    ['cloudflare/security-audit-skill', true],
    ['Cafe Racer', true], // accents do not matter
    ['Go', true],
    ['Claude Code', false], // never said
    ['Strix', false],
    ['Security Audit Skill (di Cloudflare)', true], // a trailing note the model adds is not part of the name
    ['A', false],
    ['', false],
  ])('%s → %s', (title, expected) => {
    expect(isGrounded(title, text)).toBe(expected);
  });

  it('a very short name must be a whole word: "go" is not in "algoritmo"', () => {
    expect(isGrounded('Go', 'un algoritmo veloce')).toBe(false);
    expect(isGrounded('uv', 'una nuvola bianca')).toBe(false);
    expect(isGrounded('uv', 'installa uv e poi vai')).toBe(true);
    expect(isGrounded('C++', 'scritto in C++ e Rust')).toBe(true);
    expect(isGrounded('Go', 'scritto in Go.')).toBe(true);
  });
});

describe('parseSoftwareResponse', () => {
  const text = sourceTextOf(CLOUDFLARE);

  it('keeps real names with their kind, and an url only when it is in the text', () => {
    const items = parseSoftwareResponse(
      answer([
        { title: 'Security Audit Skill', url: null, kind: 'product' },
        { title: 'cloudflare/security-audit-skill', url: 'https://github.com/cloudflare/security-audit-skill', kind: 'repo' },
        { title: 'Claude Code', url: 'https://claude.ai/code', kind: 'product' },
      ]),
      text,
    );
    expect(items).toEqual([
      { title: 'Security Audit Skill', url: null, tag: 'product', description: null },
      { title: 'cloudflare/security-audit-skill', url: 'https://github.com/cloudflare/security-audit-skill', tag: 'repo', description: null },
      { title: 'Claude Code', url: null, tag: 'product', description: null }, // the url was not in the text: dropped, never invented
    ]);
  });

  it('drops placeholders, names that are not in the text, and duplicates', () => {
    const items = parseSoftwareResponse(
      answer([
        { title: '/repo', url: null, kind: 'repo' },
        { title: 'tool', url: null, kind: 'product' },
        { title: 'Opus 4,349 Fork Layer', url: null, kind: 'repo' },
        { title: 'Cursor', url: null, kind: 'product' },
        { title: 'cursor', url: null, kind: 'product' },
        { title: 'Cursor (editor)', url: null, kind: 'product' },
      ]),
      text,
    );
    expect(items.map((i) => i.title)).toEqual(['Cursor']);
  });

  it('never returns more than MAX_EXTRACTED', () => {
    const names = Array.from({ length: 20 }, (_, i) => `Tool${i}`);
    const big = names.join(' ');
    const items = parseSoftwareResponse(answer(names.map((title) => ({ title, url: null, kind: 'product' }))), big);
    expect(items).toHaveLength(MAX_EXTRACTED);
  });

  it('is empty for anything that is not the expected JSON', () => {
    expect(parseSoftwareResponse('not json', text)).toEqual([]);
    expect(parseSoftwareResponse('{"songs":[]}', text)).toEqual([]);
    expect(parseSoftwareResponse('{"software":"Cursor"}', text)).toEqual([]);
    expect(parseSoftwareResponse(answer([null, 3, {}, { title: 5 }]), text)).toEqual([]);
  });
});

describe('the prompt', () => {
  it('asks only for software, with the rules, two examples and the content of the post', () => {
    const p = buildSoftwarePrompt(CLOUDFLARE);
    expect(p).toMatch(/estrai i SOFTWARE citati per nome/);
    expect(p).toMatch(/Esempio 1/);
    expect(p).toMatch(/Esempio 2/);
    expect(p).toContain('Security Audit Skill');
    expect(p).toContain('Trascrizione: (nessuna)');
    expect(p).toContain('github.com/cloudflare/security-audit-skill');
  });

  it('clips long text and strips control characters', () => {
    const p = buildSoftwarePrompt({ caption: `x${'a'.repeat(5000)}\u0000\u0007`, transcript: 'b'.repeat(9000), ocrText: null });
    expect(p.length).toBeLessThan(6500);
    expect(p).not.toMatch(/[\u0000\u0007]/);
  });
});

describe('extractSoftware', () => {
  const gen = (text: string, extra: Record<string, unknown> = {}) =>
    vi.fn(async () => ({ text, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, estimatedCostUSD: 0 }, truncated: false, ...extra })) as unknown as GenerateFn & ReturnType<typeof vi.fn>;

  it('does not call the model when the text says nothing about software', async () => {
    const g = gen(answer([]));
    const r = await extractSoftware(WINE, g);
    expect(r).toEqual({ items: [], usage: null, outcome: 'skipped' });
    expect(g).not.toHaveBeenCalled();
  });

  it('does not call the model for a post with no text at all', async () => {
    const g = gen(answer([]));
    expect((await extractSoftware({ caption: null, transcript: null, ocrText: null }, g)).outcome).toBe('skipped');
    expect(g).not.toHaveBeenCalled();
  });

  it('finds the tools of the five-plugins reel with a bounded, schema-imposed call', async () => {
    const g = gen(answer([{ title: 'Free LLM API', url: null, kind: 'product' }, { title: 'Strix', url: null, kind: 'product' }, { title: 'Cloud Mem', url: null, kind: 'product' }]));
    const r = await extractSoftware(PLUGINS, g);
    expect(r.outcome).toBe('found');
    expect(r.items.map((i) => i.title)).toEqual(['Free LLM API', 'Strix', 'Cloud Mem']);
    expect(r.usage).toMatchObject({ totalTokenCount: 15 });
    const call = vi.mocked(g).mock.calls[0];
    expect(call[1]).toEqual([]);
    expect(call[2]).toEqual({ json: true, schema: SOFTWARE_SCHEMA, maxTokens: SOFTWARE_MAX_TOKENS });
  });

  it('says "none" when the model names nothing real', async () => {
    const r = await extractSoftware(CLOUDFLARE, gen(answer([{ title: 'tool', url: null, kind: 'product' }, { title: 'Invented', url: null, kind: 'repo' }])));
    expect(r.outcome).toBe('none');
    expect(r.items).toEqual([]);
  });

  it('a truncated answer is a failure, not a list', async () => {
    const r = await extractSoftware(CLOUDFLARE, gen('{"software":[{"title":"Cur', { truncated: true }));
    expect(r.outcome).toBe('failed');
    expect(r.items).toEqual([]);
  });

  it('never throws: a failing call only means no extra software', async () => {
    const g = vi.fn(async () => { throw new Error('router down'); }) as unknown as GenerateFn;
    const r = await extractSoftware(CLOUDFLARE, g);
    expect(r).toEqual({ items: [], usage: null, outcome: 'failed' });
    expect(logWarning).toHaveBeenCalled();
  });
});

describe('mergeSoftware', () => {
  const item = (title: string, url: string | null = null, tag: 'repo' | 'product' = 'product') => ({ title, url, tag, description: null });

  it('keeps the first list\'s entry (with its url and description) when both name a tool', () => {
    const main = [{ ...item('Claude Code', 'https://claude.ai/code'), description: 'agent' }];
    const merged = mergeSoftware(main, [item('claude code'), item('Cursor')]);
    expect(merged.map((m) => m.title)).toEqual(['Claude Code', 'Cursor']);
    expect(merged[0]).toMatchObject({ url: 'https://claude.ai/code', description: 'agent' });
  });

  it('is bounded', () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`T${i}`));
    expect(mergeSoftware([], many)).toHaveLength(12);
    expect(mergeSoftware([], many, 5)).toHaveLength(5);
  });

  it('ignores empty titles', () => {
    expect(mergeSoftware([item('  ')], [item('Cursor')]).map((m) => m.title)).toEqual(['Cursor']);
  });
});
