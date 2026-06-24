import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ollamaClient', () => ({
  generateText: vi.fn(),
}));
vi.mock('../utils/logger', () => ({
  logWarning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { expandQuery } from './queryExpander';
import { generateText } from './ollamaClient';

describe('expandQuery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses valid JSON array from Ollama response', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: '["GPU", "home server", "NVIDIA"]', usageMetadata: null });
    const result = await expandQuery('ai compute');
    expect(result).toEqual(['GPU', 'home server', 'NVIDIA']);
  });

  it('extracts JSON embedded in prose', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'Sure! Here are the terms: ["GPU", "TPU", "edge AI"] Hope this helps!',
      usageMetadata: null,
    });
    const result = await expandQuery('ai chips');
    expect(result).toEqual(['GPU', 'TPU', 'edge AI']);
  });

  it('returns [] when Ollama response has no JSON array', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'No terms found.', usageMetadata: null });
    const result = await expandQuery('xyz');
    expect(result).toEqual([]);
  });

  it('filters out non-string values from JSON array', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '["valid", 42, null, "also valid", true]',
      usageMetadata: null,
    });
    const result = await expandQuery('test');
    expect(result).toEqual(['valid', 'also valid']);
  });

  it('slices result to max 10 items', async () => {
    const terms = Array.from({ length: 15 }, (_, i) => `term${i}`);
    vi.mocked(generateText).mockResolvedValue({ text: JSON.stringify(terms), usageMetadata: null });
    const result = await expandQuery('big query');
    expect(result).toHaveLength(10);
  });

  it('returns [] and logs warning when generateText throws', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('Ollama down'));
    const { logWarning } = await import('../utils/logger');
    const result = await expandQuery('test');
    expect(result).toEqual([]);
    expect(logWarning).toHaveBeenCalled();
  });

  it('returns [] on timeout (5s)', async () => {
    vi.useFakeTimers();
    vi.mocked(generateText).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: '["term"]', usageMetadata: null }), 10_000),
        ),
    );
    const promise = expandQuery('slow query');
    vi.advanceTimersByTime(5_001);
    const result = await promise;
    expect(result).toEqual([]);
    vi.useRealTimers();
  });
});
