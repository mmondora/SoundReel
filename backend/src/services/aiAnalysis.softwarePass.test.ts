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

import { analyzeWithAi } from './aiAnalysis';
import { generateText } from './ollamaClient';
import { getPrompt, renderTemplate } from './promptLoader';

/**
 * 8 November, measured on the 135 entries re-analysed after the 2.9.1 repair: the big schema gave NO software item at
 * all, while 48 of them clearly name tools. A small second call that looks for nothing else finds them.
 */
const USAGE = (n: number) => ({ promptTokenCount: n, candidatesTokenCount: n, totalTokenCount: 2 * n, estimatedCostUSD: 0 });
const MAIN_EMPTY_SOFTWARE = JSON.stringify({
  songs: [], films: [], notes: [], links: [], tags: ['#claudecode'], software: [],
  summary: 'Cloudflare ha pubblicato una skill open source per trovare falle di sicurezza.',
});
const MAIN_PLACEHOLDERS = JSON.stringify({
  songs: [], films: [], notes: [], links: [], tags: [], software: [{ title: '/repo', url: null, tag: 'other', description: null }, { title: 'tool', url: null, tag: 'other', description: null }],
  summary: 'Cloudflare ha pubblicato una skill open source per trovare falle di sicurezza.',
});
const SOFTWARE_ANSWER = JSON.stringify({
  software: [
    { title: 'Security Audit Skill', url: null, kind: 'product' },
    { title: 'cloudflare/security-audit-skill', url: 'https://github.com/cloudflare/security-audit-skill', kind: 'repo' },
    { title: 'Claude Code', url: null, kind: 'product' },
  ],
});

const CLOUDFLARE = {
  caption: 'Security Audit Skill è la skill open source di Cloudflare. Funziona con Claude Code. Repo: github.com/cloudflare/security-audit-skill',
  musicInfo: null, transcript: null, transcriptLanguage: null, ocrText: null, visualContext: null, slidePaths: [], thumbnailPath: null,
};
const WINE = { ...CLOUDFLARE, caption: 'Cena al mare con Franco, che vino! Questo lo voglio riassaggiare #estate' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPrompt).mockResolvedValue({ name: 'x', description: 'x', template: 'TPL', variables: [], updatedAt: '2026-01-01' });
  vi.mocked(renderTemplate).mockReturnValue('rendered prompt');
});

describe('the software pass after the main analysis', () => {
  it('adds the tools the post names when the big call left software empty', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: MAIN_EMPTY_SOFTWARE, usageMetadata: USAGE(100), truncated: false })
      .mockResolvedValueOnce({ text: SOFTWARE_ANSWER, usageMetadata: USAGE(20), truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE);
    expect(res.failure).toBeUndefined();
    expect(res.result.software?.map((s) => s.title)).toEqual(['Security Audit Skill', 'cloudflare/security-audit-skill', 'Claude Code']);
    expect(res.result.software?.find((s) => s.title === 'cloudflare/security-audit-skill')).toMatchObject({ tag: 'repo', url: 'https://github.com/cloudflare/security-audit-skill' });
    expect(res.result.summary).toMatch(/Cloudflare/); // the rest of the analysis is untouched
    expect(res.result.tags).toEqual(['#claudecode']);
  });

  it('drops the placeholders of the big call and keeps the real names of the small one', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: MAIN_PLACEHOLDERS, usageMetadata: USAGE(100), truncated: false })
      .mockResolvedValueOnce({ text: SOFTWARE_ANSWER, usageMetadata: USAGE(20), truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE);
    expect(res.result.software?.map((s) => s.title)).not.toContain('/repo');
    expect(res.result.software?.map((s) => s.title)).not.toContain('tool');
    expect(res.result.software).toHaveLength(3);
  });

  it('is a small, bounded, schema-imposed call after the main one, and its tokens are counted', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: MAIN_EMPTY_SOFTWARE, usageMetadata: USAGE(100), truncated: false })
      .mockResolvedValueOnce({ text: SOFTWARE_ANSWER, usageMetadata: USAGE(20), truncated: false });
    const res = await analyzeWithAi(CLOUDFLARE);
    expect(generateText).toHaveBeenCalledTimes(2);
    const second = vi.mocked(generateText).mock.calls[1];
    expect(String(second[0])).toMatch(/estrai i SOFTWARE citati per nome/);
    expect(second[2]).toMatchObject({ json: true, maxTokens: 500 });
    expect(res.usageMetadata?.totalTokenCount).toBe(200 + 40);
  });

  it('does not run for a post that says nothing about software: one call, no invented tool', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: MAIN_EMPTY_SOFTWARE, usageMetadata: USAGE(100), truncated: false });
    const res = await analyzeWithAi(WINE);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(res.result.software).toEqual([]);
  });

  it('a failing second call never fails the analysis', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: MAIN_EMPTY_SOFTWARE, usageMetadata: USAGE(100), truncated: false })
      .mockRejectedValueOnce(new Error('router down'));
    const res = await analyzeWithAi(CLOUDFLARE);
    expect(res.failure).toBeUndefined();
    expect(res.result.summary).toMatch(/Cloudflare/);
    expect(res.result.software).toEqual([]);
    expect(res.usageMetadata?.totalTokenCount).toBe(200);
  });

  it('a truncated or unreadable second answer adds nothing', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: MAIN_EMPTY_SOFTWARE, usageMetadata: USAGE(100), truncated: false })
      .mockResolvedValueOnce({ text: '{"software":[{"title":"Sec', usageMetadata: USAGE(20), truncated: true });
    const res = await analyzeWithAi(CLOUDFLARE);
    expect(res.result.software).toEqual([]);
  });

  it('does not run when the main analysis itself failed (nothing to add to)', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: '{"songs":[', usageMetadata: USAGE(100), truncated: true });
    const res = await analyzeWithAi(CLOUDFLARE);
    expect(res.failure?.category).toBe('unusable_output');
    expect(generateText).toHaveBeenCalledTimes(2); // the main call and its single retry, no third
  });
});
