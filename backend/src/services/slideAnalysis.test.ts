import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ollamaClient', () => ({ generateText: vi.fn(), describeFramesWithVision: vi.fn() }));
vi.mock('./claudeFallback', () => ({ runClaudePrompt: vi.fn(), logFallbackOutcome: vi.fn() }));
vi.mock('./promptLoader', () => ({ getPrompt: vi.fn(), renderTemplate: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { analyzeSlides } from './slideAnalysis';
import { generateText, describeFramesWithVision } from './ollamaClient';
import { runClaudePrompt } from './claudeFallback';
import { getPrompt, renderTemplate } from './promptLoader';

const DISABLED_FALLBACK = {
  status: 'disabled' as const, text: null, reason: 'off in tests',
  durationMs: 0, model: 'claude-opus-4-8',
};

function slidesPayload(slides: Array<{ index: number; summary: string | null; links?: Array<{ url: string; label: string }> }>) {
  return JSON.stringify({ slides: slides.map((s) => ({ links: [], ...s })) });
}

const BASE = {
  entryId: 'entry-1',
  slidePaths: ['/data/media/entry-1/slide-0.jpg', '/data/media/entry-1/slide-1.jpg'],
  ocrPerSlide: ['Plex is a media server with a polished interface and wide device support', 'Jellyfin is the free and open source alternative to Plex'],
  caption: '2 Best Streaming Apps',
};

describe('analyzeSlides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPrompt).mockResolvedValue({
      name: 'x', description: 'x', template: 'TPL', variables: [], updatedAt: '2026-01-01',
    });
    vi.mocked(renderTemplate).mockReturnValue('rendered prompt');
    vi.mocked(runClaudePrompt).mockResolvedValue(DISABLED_FALLBACK);
    vi.mocked(describeFramesWithVision).mockResolvedValue(null);
  });

  it('returns one entry per slide with its own OCR text and image url', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: slidesPayload([
        { index: 0, summary: 'Presenta Plex.', links: [{ url: 'https://www.plex.tv', label: 'Plex' }] },
        { index: 1, summary: 'Presenta Jellyfin.', links: [{ url: 'https://jellyfin.org', label: 'Jellyfin' }] },
      ]),
      usageMetadata: null,
    });

    const slides = await analyzeSlides(BASE);

    expect(slides).toHaveLength(2);
    expect(slides[0]).toMatchObject({
      index: 0,
      imageUrl: '/media/entry-1/slide-0.jpg',
      ocrText: BASE.ocrPerSlide[0],
      summary: 'Presenta Plex.',
    });
    expect(slides[0].links).toEqual([{ url: 'https://www.plex.tv', label: 'Plex' }]);
    expect(slides[1].summary).toBe('Presenta Jellyfin.');
  });

  it('sends every slide to the model in a single call', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: slidesPayload([{ index: 0, summary: 'a' }, { index: 1, summary: 'b' }]),
      usageMetadata: null,
    });

    await analyzeSlides(BASE);

    expect(generateText).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(renderTemplate).mock.calls[0][1] as { slides: unknown[]; slideCount: number };
    expect(ctx.slideCount).toBe(2);
    expect(ctx.slides).toHaveLength(2);
  });

  it('matches results by index when the model returns them out of order', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: slidesPayload([{ index: 1, summary: 'second' }, { index: 0, summary: 'first' }]),
      usageMetadata: null,
    });

    const slides = await analyzeSlides(BASE);

    expect(slides[0].summary).toBe('first');
    expect(slides[1].summary).toBe('second');
  });

  it('leaves a slide the model omitted without a summary, still listing its text', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: slidesPayload([{ index: 0, summary: 'only the first' }]),
      usageMetadata: null,
    });

    const slides = await analyzeSlides(BASE);

    expect(slides).toHaveLength(2);
    expect(slides[1].summary).toBeNull();
    expect(slides[1].ocrText).toBe(BASE.ocrPerSlide[1]);
  });

  // Vision is slow (measured ~20s per image), and slides are usually text-heavy
  // screenshots, so it must only run where OCR found nothing worth having.
  it('runs vision only on slides whose OCR text is too short', async () => {
    vi.mocked(describeFramesWithVision).mockResolvedValue('a dark movie poster');
    vi.mocked(generateText).mockResolvedValue({
      text: slidesPayload([{ index: 0, summary: 'x' }, { index: 1, summary: 'y' }]),
      usageMetadata: null,
    });

    const slides = await analyzeSlides({ ...BASE, ocrPerSlide: ['tiny', BASE.ocrPerSlide[1]] });

    expect(describeFramesWithVision).toHaveBeenCalledTimes(1);
    expect(describeFramesWithVision).toHaveBeenCalledWith([BASE.slidePaths[0]]);
    expect(slides[0].visualDescription).toBe('a dark movie poster');
    expect(slides[1].visualDescription).toBeNull();
  });

  it('rejects implausible and placeholder links', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: slidesPayload([
        {
          index: 0,
          summary: 'ok',
          links: [
            { url: 'https://...', label: 'hallucinated' },
            { url: 'not a url', label: 'broken' },
            { url: 'https://www.plex.tv', label: 'Plex' },
            { url: 'https://kodi.tv', label: '...' },
          ],
        },
      ]),
      usageMetadata: null,
    });

    const slides = await analyzeSlides(BASE);

    expect(slides[0].links).toEqual([{ url: 'https://www.plex.tv', label: 'Plex' }]);
  });

  // Slide links are intentionally *suggested* rather than extracted, so unlike
  // the main pipeline they must survive not appearing in the source text.
  it('keeps a link that does not appear in the slide text', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: slidesPayload([
        { index: 0, summary: 'ok', links: [{ url: 'https://www.plex.tv', label: 'Plex' }] },
      ]),
      usageMetadata: null,
    });

    const slides = await analyzeSlides(BASE);

    expect(slides[0].links).toHaveLength(1);
  });

  it('preserves per-slide text when the model fails entirely', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('ollama down'));

    const slides = await analyzeSlides(BASE);

    expect(slides).toHaveLength(2);
    expect(slides[0].ocrText).toBe(BASE.ocrPerSlide[0]);
    expect(slides[0].summary).toBeNull();
    expect(slides[0].links).toEqual([]);
  });

  it('preserves per-slide text when the model returns unusable JSON', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'sorry, cannot help', usageMetadata: null });

    const slides = await analyzeSlides(BASE);

    expect(slides[0].ocrText).toBe(BASE.ocrPerSlide[0]);
    expect(slides[0].summary).toBeNull();
  });

  it('falls back to Claude when the local model yields nothing usable', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'not json', usageMetadata: null });
    vi.mocked(runClaudePrompt).mockResolvedValue({
      status: 'ok', text: slidesPayload([{ index: 0, summary: 'recuperato da Claude' }]),
      reason: null, durationMs: 10, model: 'claude-opus-4-8',
    });

    const slides = await analyzeSlides(BASE);

    expect(runClaudePrompt).toHaveBeenCalledWith('rendered prompt');
    expect(slides[0].summary).toBe('recuperato da Claude');
  });

  it('returns an empty array when there are no slides', async () => {
    const slides = await analyzeSlides({ ...BASE, slidePaths: [], ocrPerSlide: [] });
    expect(slides).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });
});
