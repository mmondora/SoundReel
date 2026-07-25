import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ollamaClient', () => ({ generateText: vi.fn() }));
vi.mock('./claudeFallback', () => ({ runClaudePrompt: vi.fn(), logFallbackOutcome: vi.fn() }));
vi.mock('./promptLoader', () => ({ getPrompt: vi.fn(), renderTemplate: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { analyzeWithAi } from './aiAnalysis';
import { generateText } from './ollamaClient';
import { runClaudePrompt } from './claudeFallback';
import { getPrompt, renderTemplate } from './promptLoader';

const DISABLED_FALLBACK = {
  status: 'disabled' as const, text: null, reason: 'off in tests',
  durationMs: 0, model: 'claude-opus-4-8',
};

const BASE_INPUT = {
  caption: null,
  musicInfo: null,
  transcript: null,
  transcriptLanguage: null,
  ocrText: null,
  visualContext: null,
  slidePaths: [],
  thumbnailPath: null,
};

describe('analyzeWithAi link validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPrompt).mockResolvedValue({
      name: 'x', description: 'x', template: 'TPL', variables: [], updatedAt: '2026-01-01',
    });
    vi.mocked(renderTemplate).mockReturnValue('rendered prompt');
    // These cases exercise the Ollama path only; keep the cascade inert.
    vi.mocked(runClaudePrompt).mockResolvedValue(DISABLED_FALLBACK);
  });

  it('keeps a link that literally appears in the caption', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        songs: [], films: [], notes: [], tags: [], summary: null,
        links: [{ url: 'https://example.com/article', label: 'Article' }],
      }),
      usageMetadata: null,
    });
    const { result } = await analyzeWithAi({
      ...BASE_INPUT,
      caption: 'Check this out: https://example.com/article it is great',
    });
    expect(result.links).toEqual([{ url: 'https://example.com/article', label: 'Article' }]);
  });

  it('drops a hallucinated link with no real URL in any source text', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        songs: [], films: [], notes: [], tags: [], summary: null,
        links: [{ url: 'https://...', label: null }],
      }),
      usageMetadata: null,
    });
    const { result } = await analyzeWithAi({
      ...BASE_INPUT,
      caption: 'The link to the full lecture is in the pinned comment.',
    });
    expect(result.links).toEqual([]);
  });

  it('keeps a link found in OCR text even if absent from caption', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        songs: [], films: [], notes: [], tags: [], summary: null,
        links: [{ url: 'https://ocr-found.example.com', label: null }],
      }),
      usageMetadata: null,
    });
    const { result } = await analyzeWithAi({
      ...BASE_INPUT,
      caption: 'no link here',
      ocrText: 'Visit https://ocr-found.example.com for more',
    });
    expect(result.links).toEqual([{ url: 'https://ocr-found.example.com', label: null }]);
  });

  it('keeps a link found in the transcript', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        songs: [], films: [], notes: [], tags: [], summary: null,
        links: [{ url: 'https://spoken-link.example.com', label: null }],
      }),
      usageMetadata: null,
    });
    const { result } = await analyzeWithAi({
      ...BASE_INPUT,
      transcript: 'go to https://spoken-link.example.com now',
    });
    expect(result.links).toEqual([{ url: 'https://spoken-link.example.com', label: null }]);
  });

  it('drops a link when the model returns a non-string url', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        songs: [], films: [], notes: [], tags: [], summary: null,
        links: [{ url: 12345, label: null }],
      }),
      usageMetadata: null,
    });
    const { result } = await analyzeWithAi({
      ...BASE_INPUT,
      caption: 'some caption with 12345 in it',
    });
    expect(result.links).toEqual([]);
  });
});

const RICH_TEXT = 'Ieri ho rivisto Blade Runner del 1982, un capolavoro assoluto del cinema.';

const EMPTY_JSON = JSON.stringify({
  songs: [], films: [], notes: [], links: [], tags: [], summary: null,
});

const RICH_JSON = JSON.stringify({
  songs: [], films: [{ title: 'Blade Runner', director: null, year: '1982' }],
  notes: [], links: [], tags: [], summary: 'Un post su Blade Runner.',
});

function okFallback(text: string) {
  return { status: 'ok' as const, text, reason: null, durationMs: 100, model: 'claude-opus-4-8' };
}

describe('analyzeWithAi — Claude fallback cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPrompt).mockResolvedValue({
      name: 'x', description: 'x', template: 'TPL', variables: [], updatedAt: '2026-01-01',
    });
    vi.mocked(renderTemplate).mockReturnValue('rendered prompt');
  });

  it('does not call Claude when Ollama returns a usable result', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: RICH_JSON, usageMetadata: null });

    const res = await analyzeWithAi({ ...BASE_INPUT, caption: RICH_TEXT });

    expect(runClaudePrompt).not.toHaveBeenCalled();
    expect(res.result.films).toHaveLength(1);
    expect(res.fallback).toBeNull();
  });

  it('calls Claude when Ollama is empty and source text is substantial', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: EMPTY_JSON, usageMetadata: null });
    vi.mocked(runClaudePrompt).mockResolvedValue(okFallback(RICH_JSON));

    const res = await analyzeWithAi({ ...BASE_INPUT, caption: RICH_TEXT });

    expect(runClaudePrompt).toHaveBeenCalledWith('rendered prompt');
    expect(res.result.films).toHaveLength(1);
    expect(res.result.summary).toBe('Un post su Blade Runner.');
    expect(res.fallback?.status).toBe('ok');
  });

  it('does not call Claude when there is too little source text to be worth it', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: EMPTY_JSON, usageMetadata: null });
    vi.mocked(runClaudePrompt).mockResolvedValue(DISABLED_FALLBACK);

    const res = await analyzeWithAi({ ...BASE_INPUT, caption: 'ciao' });

    expect(runClaudePrompt).not.toHaveBeenCalled();
    expect(res.fallback).toBeNull();
  });

  it('treats tags-only output as empty and still falls back', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({ songs: [], films: [], notes: [], links: [], tags: ['#cinema'], summary: null }),
      usageMetadata: null,
    });
    vi.mocked(runClaudePrompt).mockResolvedValue(okFallback(RICH_JSON));

    const res = await analyzeWithAi({ ...BASE_INPUT, caption: RICH_TEXT });

    expect(runClaudePrompt).toHaveBeenCalled();
    expect(res.result.films).toHaveLength(1);
  });

  it('falls back when Ollama emits no JSON at all', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'mi dispiace, non posso', usageMetadata: null });
    vi.mocked(runClaudePrompt).mockResolvedValue(okFallback(RICH_JSON));

    const res = await analyzeWithAi({ ...BASE_INPUT, caption: RICH_TEXT });

    expect(runClaudePrompt).toHaveBeenCalled();
    expect(res.result.films).toHaveLength(1);
  });

  it('strips markdown fences from the Claude output', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: EMPTY_JSON, usageMetadata: null });
    vi.mocked(runClaudePrompt).mockResolvedValue(okFallback('```json\n' + RICH_JSON + '\n```'));

    const res = await analyzeWithAi({ ...BASE_INPUT, caption: RICH_TEXT });

    expect(res.result.films).toHaveLength(1);
  });

  it('applies the same link verification to Claude output', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: EMPTY_JSON, usageMetadata: null });
    vi.mocked(runClaudePrompt).mockResolvedValue(okFallback(JSON.stringify({
      songs: [], films: [], notes: [], tags: [], summary: 'ok',
      links: [
        { url: 'https://...', label: 'hallucinated' },
        { url: 'https://real.example.com', label: 'real' },
      ],
    })));

    const res = await analyzeWithAi({
      ...BASE_INPUT,
      caption: `${RICH_TEXT} vedi https://real.example.com per approfondire`,
    });

    expect(res.result.links).toEqual([{ url: 'https://real.example.com', label: 'real' }]);
  });

  it('keeps the empty Ollama result when the fallback fails', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: EMPTY_JSON, usageMetadata: null });
    vi.mocked(runClaudePrompt).mockResolvedValue({
      status: 'error', text: null, reason: 'exit code 1', durationMs: 50, model: 'claude-opus-4-8',
    });

    const res = await analyzeWithAi({ ...BASE_INPUT, caption: RICH_TEXT });

    expect(res.result.films).toHaveLength(0);
    expect(res.result.summary).toBeNull();
    expect(res.fallback?.status).toBe('error');
  });

  it('keeps the empty Ollama result when the fallback returns unparseable text', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: EMPTY_JSON, usageMetadata: null });
    vi.mocked(runClaudePrompt).mockResolvedValue(okFallback('non e json'));

    const res = await analyzeWithAi({ ...BASE_INPUT, caption: RICH_TEXT });

    expect(res.result.films).toHaveLength(0);
    expect(res.fallback?.status).toBe('ok');
  });
});
