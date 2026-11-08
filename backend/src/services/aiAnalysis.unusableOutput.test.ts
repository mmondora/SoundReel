import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ollamaClient', () => ({
  generateText: vi.fn(),
  BackendUnavailableError: class BackendUnavailableError extends Error {},
  OllamaTransientError: class OllamaTransientError extends Error {},
}));
vi.mock('./claudeFallback', () => ({ runClaudePrompt: vi.fn(), logFallbackOutcome: vi.fn() }));
vi.mock('./promptLoader', () => ({ getPrompt: vi.fn(), renderTemplate: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));
vi.mock('../utils/db', () => ({
  getFeaturesConfig: vi.fn().mockResolvedValue({ outputLanguage: 'it' }),
  outputLanguageDisplayName: () => 'Italian',
}));

import { ANALYSIS_SCHEMA, ANALYSIS_SCHEMA_WITH_SUMMARY, analysisSchemaFor, analyzeWithAi, parseAnalysisResponse } from './aiAnalysis';
import { generateText } from './ollamaClient';
import { runClaudePrompt } from './claudeFallback';
import { getPrompt, renderTemplate } from './promptLoader';

/**
 * 8 novembre: un reel di Cloudflare ("Security Audit Skill... open source... 65.000 stelle su GitHub") e' risultato
 * "completato" senza un tag, una nota o un riassunto. La prima analisi era andata in loop fino al tetto di token (4096),
 * la seconda aveva copiato come chiave JSON una riga di istruzioni del prompt. Una risposta troncata o illeggibile
 * veniva trattata come "non c'era niente da trovare" e nessuno la riprendeva: 33 entry su 91 in una settimana.
 */
const CLOUDFLARE_INPUT = {
  caption: 'Security Audit Skill è la skill open source di Cloudflare. Funziona con Claude Code, Codex e Cursor. #claudecode',
  musicInfo: null,
  transcript: 'Cloufer ha rilasciato gratis una skill che trova le falle di sicurezza nelle app.',
  transcriptLanguage: 'it',
  ocrText: 'CLOUDFLARE skill di sicurezza GitHub',
  visualContext: 'Un uomo davanti a un microfono.',
  slidePaths: [],
  thumbnailPath: null,
};

const GOOD = JSON.stringify({
  songs: [], films: [], notes: [{ text: 'Cloudflare', category: 'brand' }], links: [], tags: ['#claudecode'],
  software: [{ title: 'Security Audit Skill', url: null, tag: 'repo', description: 'La skill open source di Cloudflare.' }],
  summary: 'Cloudflare ha pubblicato una skill open source per trovare falle di sicurezza.',
});
const VALID_EMPTY = JSON.stringify({ songs: [], films: [], notes: [], software: [], links: [], tags: [], summary: null });
const USAGE = (prompt: number, out: number) => ({ promptTokenCount: prompt, candidatesTokenCount: out, totalTokenCount: prompt + out, estimatedCostUSD: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPrompt).mockResolvedValue({ name: 'x', description: 'x', template: 'TPL', variables: [], updatedAt: '2026-01-01' });
  vi.mocked(renderTemplate).mockReturnValue('rendered prompt');
});

describe('the answer shape is imposed on the model', () => {
  it('asks for JSON conforming to the schema, not for "any JSON", with the summary mandatory when the post has text', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: GOOD, usageMetadata: null, truncated: false });
    await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(generateText).toHaveBeenCalledWith('rendered prompt', [], { json: true, schema: ANALYSIS_SCHEMA_WITH_SUMMARY });
  });

  it('lets the summary stay null when there is no text to summarise (only a thumbnail or a visual description)', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: VALID_EMPTY, usageMetadata: null, truncated: false });
    await analyzeWithAi({ ...CLOUDFLARE_INPUT, caption: null, transcript: null, ocrText: null });
    expect(generateText).toHaveBeenCalledWith('rendered prompt', [], { json: true, schema: ANALYSIS_SCHEMA });
  });

  it('extracts the software mentioned in the post', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: GOOD, usageMetadata: null, truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(res.failure).toBeUndefined();
    expect(res.result.software).toEqual([
      { title: 'Security Audit Skill', url: null, tag: 'repo', description: 'La skill open source di Cloudflare.' },
    ]);
    expect(res.result.summary).toMatch(/Cloudflare/);
  });
});

describe('a truncated or unreadable answer is not "nothing to find"', () => {
  it('uses the first answer and does not retry when it is usable', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: GOOD, usageMetadata: USAGE(1000, 300), truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(res.usageMetadata).toEqual(USAGE(1000, 300));
  });

  it('retries once when the first answer hit the token ceiling, and uses the second', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: '{"songs": [], "notes": [{"text": "Cloudflare', usageMetadata: USAGE(1478, 4096), truncated: true })
      .mockResolvedValueOnce({ text: GOOD, usageMetadata: USAGE(1478, 330), truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(res.failure).toBeUndefined();
    expect(res.result.software).toHaveLength(1);
    // the tokens of BOTH attempts are counted: the first one was real work
    expect(res.usageMetadata).toEqual(USAGE(2956, 4426));
  });

  it('never parses a truncated answer, even if the cut text happens to look like JSON', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: VALID_EMPTY, usageMetadata: null, truncated: true })
      .mockResolvedValueOnce({ text: GOOD, usageMetadata: null, truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(res.result.software).toHaveLength(1);
  });

  it('retries once when the first answer holds no readable JSON', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: 'sorry, I misunderstood the prompt. Let me re-read it carefully.', usageMetadata: null, truncated: false })
      .mockResolvedValueOnce({ text: GOOD, usageMetadata: null, truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(res.failure).toBeUndefined();
    expect(res.result.tags).toEqual(['#claudecode']);
  });

  it('declares a retryable failure when it is truncated both times, never a "completed" empty result', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: '{"notes": [{"text": "x"', usageMetadata: USAGE(1478, 4096), truncated: true });
    const res = await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(res.failure).toEqual({ category: 'unusable_output', retryable: true, reason: expect.stringContaining('tagliata') });
    // what the pipeline already had is kept, nothing is invented
    expect(res.result.visualContext).toBe('Un uomo davanti a un microfono.');
    expect(res.result.overlayText).toBe('CLOUDFLARE skill di sicurezza GitHub');
    expect(res.result.software).toEqual([]);
    expect(res.usageMetadata).toEqual(USAGE(2956, 8192));
  });

  it('declares a retryable failure when there is no JSON both times', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'mi dispiace, non posso', usageMetadata: null, truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(res.failure).toEqual({ category: 'unusable_output', retryable: true, reason: expect.stringContaining('JSON') });
  });

  it('does not spend the paid fallback on it: the job is retried later by the worker instead', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'garbage', usageMetadata: null, truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE_INPUT);
    expect(runClaudePrompt).not.toHaveBeenCalled();
    expect(res.fallback).toBeNull();
  });

  it('a valid but empty answer is still a valid answer: no retry, no failure', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: VALID_EMPTY, usageMetadata: null, truncated: false });
    const res = await analyzeWithAi({ ...CLOUDFLARE_INPUT, caption: 'ciao', transcript: null, ocrText: null, visualContext: null });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(res.failure).toBeUndefined();
  });
});

describe('the summary is mandatory only where there is something to summarise', () => {
  const BASE = { ...CLOUDFLARE_INPUT, caption: null, transcript: null, ocrText: null, visualContext: null };

  it('the schema with a summary asks for a real string, the other one allows null', () => {
    expect(ANALYSIS_SCHEMA.properties.summary.type).toEqual(['string', 'null']);
    expect(ANALYSIS_SCHEMA_WITH_SUMMARY.properties.summary).toEqual({ type: 'string', minLength: 10 });
  });

  it('everything else is the same in both', () => {
    const { summary: _a, ...restPlain } = ANALYSIS_SCHEMA.properties;
    const { summary: _b, ...restWith } = ANALYSIS_SCHEMA_WITH_SUMMARY.properties;
    expect(restWith).toEqual(restPlain);
    expect(ANALYSIS_SCHEMA_WITH_SUMMARY.required).toEqual(ANALYSIS_SCHEMA.required);
  });

  it('picks by the amount of source text: caption, OCR and transcript count, 40 characters is the line', () => {
    expect(analysisSchemaFor({ ...BASE, caption: 'x'.repeat(39) })).toBe(ANALYSIS_SCHEMA);
    expect(analysisSchemaFor({ ...BASE, caption: 'x'.repeat(40) })).toBe(ANALYSIS_SCHEMA_WITH_SUMMARY);
    expect(analysisSchemaFor({ ...BASE, ocrText: 'y'.repeat(60) })).toBe(ANALYSIS_SCHEMA_WITH_SUMMARY);
    expect(analysisSchemaFor({ ...BASE, transcript: 'z'.repeat(60) })).toBe(ANALYSIS_SCHEMA_WITH_SUMMARY);
  });

  it('a visual description alone is not text to summarise', () => {
    expect(analysisSchemaFor({ ...BASE, visualContext: 'Un uomo davanti a un microfono, in uno studio con una parete bianca.' })).toBe(ANALYSIS_SCHEMA);
  });
});

describe('ANALYSIS_SCHEMA', () => {
  const props = ANALYSIS_SCHEMA.properties;

  it('asks for exactly the lists the pipeline reads, and requires them all', () => {
    expect(Object.keys(props).sort()).toEqual(['films', 'links', 'notes', 'software', 'songs', 'summary', 'tags']);
    expect([...ANALYSIS_SCHEMA.required].sort()).toEqual(['films', 'links', 'notes', 'software', 'songs', 'summary', 'tags']);
  });

  it('no longer asks the model to copy back the transcript, the OCR text or the visual context', () => {
    for (const copied of ['transcription', 'transcript', 'visualContext', 'overlayText']) expect(props).not.toHaveProperty(copied);
  });

  it('allows exactly the categories and tags the parser accepts', () => {
    expect(props.notes.items.properties.category.enum).toEqual(['place', 'event', 'brand', 'book', 'product', 'quote', 'person', 'other']);
    expect(props.software.items.properties.tag.enum).toEqual(['repo', 'product', 'article', 'other']);
  });

  it('lets a software mention have no URL (a reel often does not give one)', () => {
    expect(props.software.items.properties.url.type).toEqual(['string', 'null']);
    expect(props.software.items.required).toEqual(['title', 'tag']);
  });

  it('is what the parser reads back: an answer built to the schema parses', () => {
    const parsed = parseAnalysisResponse(GOOD, CLOUDFLARE_INPUT);
    expect(parsed?.software?.[0].title).toBe('Security Audit Skill');
    expect(parsed?.tags).toEqual(['#claudecode']);
  });
});
