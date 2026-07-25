import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ollamaClient', () => ({ generateText: vi.fn() }));
vi.mock('./promptLoader', () => ({ getPrompt: vi.fn(), renderTemplate: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { analyzeWithAi } from './aiAnalysis';
import { generateText } from './ollamaClient';
import { getPrompt, renderTemplate } from './promptLoader';

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
