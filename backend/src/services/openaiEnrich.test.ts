import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({ getOpenAIConfig: vi.fn() }));
vi.mock('./promptLoader', () => ({ getPrompt: vi.fn(), renderTemplate: vi.fn() }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn() }));

import { enrichWithOpenAI } from './openaiEnrich';
import { getOpenAIConfig } from '../utils/db';
import { getPrompt, renderTemplate } from './promptLoader';
import { logWarning } from '../utils/logger';

const EMPTY_RESULTS = { songs: [], films: [], notes: [], links: [], tags: [], summary: null };

function mockOpenAIOutputText(text: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    }),
  }));
}

describe('enrichWithOpenAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOpenAIConfig).mockResolvedValue({ apiKey: 'sk-test', enabled: true });
    vi.mocked(getPrompt).mockResolvedValue({
      name: 'x', description: 'x', template: 'TPL', variables: [], updatedAt: '2026-01-01',
    });
    vi.mocked(renderTemplate).mockReturnValue('rendered prompt');
  });

  it('throws when API key is missing', async () => {
    vi.mocked(getOpenAIConfig).mockResolvedValue({ apiKey: null, enabled: false });
    await expect(enrichWithOpenAI(EMPTY_RESULTS, null)).rejects.toThrow(/API key non configurata/);
  });

  it('throws when the OpenAI response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(enrichWithOpenAI(EMPTY_RESULTS, null)).rejects.toThrow(/OpenAI API error 500/);
  });

  it('returns generic empty fallback when there is no output_text content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output: [] }),
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result).toEqual({ category: 'generic', items: [] });
  });

  it('parses a tech category response without a verdict', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'tech',
      items: [{
        label: 'foo/bar', explanation: 'A CLI tool for X, actively maintained, MIT license.',
        links: [{ url: 'https://github.com/foo/bar', title: 'foo/bar', snippet: 'GitHub repo' }],
      }],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.category).toBe('tech');
    expect(result.verdict).toBeUndefined();
    expect(result.items).toEqual([{
      label: 'foo/bar', explanation: 'A CLI tool for X, actively maintained, MIT license.',
      links: [{ url: 'https://github.com/foo/bar', title: 'foo/bar', snippet: 'GitHub repo' }],
    }]);
  });

  it('parses a security category response with a verdict, clamping confidence', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'security',
      verdict: { label: 'phishing', confidence: 150, explanation: 'Domain registered yesterday, mimics a bank login page.' },
      items: [{ label: 'evil-bank-login.com', explanation: 'Newly registered domain.', links: [] }],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.category).toBe('security');
    expect(result.verdict).toEqual({
      label: 'phishing', confidence: 100, explanation: 'Domain registered yesterday, mimics a bank login page.',
    });
    expect(result.items).toEqual([]); // item has no links, filtered out like today
  });

  it('parses a claim category response with a verdict', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'claim',
      verdict: { label: 'falso', confidence: 92, explanation: 'No credible source reports this; likely satire.' },
      items: [{
        label: 'Massive doorway discovered in Kentucky', explanation: 'Originated from a satire site, no scientific source confirms it.',
        links: [{ url: 'https://example.com/factcheck', title: 'Fact-check article', snippet: 'Debunked' }],
      }],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.category).toBe('claim');
    expect(result.verdict?.label).toBe('falso');
    expect(result.items[0].label).toBe('Massive doorway discovered in Kentucky');
  });

  it('defaults to generic when category is missing or invalid', async () => {
    mockOpenAIOutputText(JSON.stringify({ items: [] }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.category).toBe('generic');
  });

  it('drops verdict for tech/generic even if the model includes one', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'generic',
      verdict: { label: 'vero', confidence: 99, explanation: 'should be ignored' },
      items: [],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.verdict).toBeUndefined();
  });

  it('falls back to generic/empty and logs a warning on malformed JSON', async () => {
    mockOpenAIOutputText('not valid json {{{');
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result).toEqual({ category: 'generic', items: [] });
    expect(logWarning).toHaveBeenCalled();
  });

  it('strips markdown code fences before parsing', async () => {
    mockOpenAIOutputText('```json\n' + JSON.stringify({ category: 'generic', items: [] }) + '\n```');
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result).toEqual({ category: 'generic', items: [] });
  });

  it('filters out items missing label or links, and links missing url/title', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'generic',
      items: [
        { label: 'no links', explanation: '', links: [] },
        { explanation: 'no label', links: [{ url: 'https://x.com', title: 'x' }] },
        {
          label: 'valid', explanation: 'ok',
          links: [
            { url: 'https://x.com', title: 'x', snippet: 'y' },
            { url: 'https://missing-title.com' },
          ],
        },
      ],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.items).toEqual([{
      label: 'valid', explanation: 'ok',
      links: [{ url: 'https://x.com', title: 'x', snippet: 'y' }],
    }]);
  });
});
