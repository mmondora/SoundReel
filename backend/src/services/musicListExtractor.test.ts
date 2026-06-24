import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ollamaClient', () => ({ generateText: vi.fn() }));
vi.mock('./pageExtractor', () => ({ extractPage: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { detectMusicList, extractSongsFromText, extractSongsFromUrl } from './musicListExtractor';
import { generateText } from './ollamaClient';
import { extractPage } from './pageExtractor';

describe('detectMusicList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when Ollama answers yes', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'yes', usageMetadata: null });
    expect(await detectMusicList('Top 10 albums of 2026')).toBe(true);
  });

  it('returns true for YES (case-insensitive)', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'YES\n', usageMetadata: null });
    expect(await detectMusicList('some text')).toBe(true);
  });

  it('returns false when Ollama answers no', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'no', usageMetadata: null });
    expect(await detectMusicList('a recipe for pasta')).toBe(false);
  });

  it('returns false when Ollama throws', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('Ollama down'));
    expect(await detectMusicList('text')).toBe(false);
  });

  it('truncates input to 2000 chars', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'no', usageMetadata: null });
    await detectMusicList('x'.repeat(5000));
    const call = vi.mocked(generateText).mock.calls[0][0] as string;
    expect(call).toContain('x'.repeat(2000));
    expect(call).not.toContain('x'.repeat(2001));
  });
});

describe('extractSongsFromText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses valid JSON array', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '[{"title":"Bohemian Rhapsody","artist":"Queen"},{"title":"Hotel California","artist":"Eagles"}]',
      usageMetadata: null,
    });
    const songs = await extractSongsFromText('some music text');
    expect(songs).toEqual([
      { title: 'Bohemian Rhapsody', artist: 'Queen' },
      { title: 'Hotel California', artist: 'Eagles' },
    ]);
  });

  it('extracts JSON embedded in prose', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'Here are the songs: [{"title":"One","artist":"Metallica"}] Hope that helps!',
      usageMetadata: null,
    });
    const songs = await extractSongsFromText('text');
    expect(songs).toEqual([{ title: 'One', artist: 'Metallica' }]);
  });

  it('filters entries missing title or artist', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '[{"title":"Valid","artist":"Artist"},{"title":"","artist":"No Title"},{"title":"No Artist","artist":""}]',
      usageMetadata: null,
    });
    const songs = await extractSongsFromText('text');
    expect(songs).toEqual([{ title: 'Valid', artist: 'Artist' }]);
  });

  it('returns [] when no JSON array in response', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'No songs found.', usageMetadata: null });
    expect(await extractSongsFromText('text')).toEqual([]);
  });

  it('returns [] when Ollama throws', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('fail'));
    expect(await extractSongsFromText('text')).toEqual([]);
  });
});

describe('extractSongsFromUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches page and extracts songs when music list detected', async () => {
    vi.mocked(extractPage).mockResolvedValue({
      finalUrl: 'https://example.com', httpStatus: 200, contentType: 'text/html',
      title: 'Top 10', description: null, mainText: 'Top 10 albums text',
      representativeImageUrl: null, rawLinks: [], siteName: null, lang: null,
    });
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: 'yes', usageMetadata: null }) // detect
      .mockResolvedValueOnce({ text: '[{"title":"Abbey Road","artist":"Beatles"}]', usageMetadata: null }); // extract
    const songs = await extractSongsFromUrl('https://example.com/top10');
    expect(songs).toEqual([{ title: 'Abbey Road', artist: 'Beatles' }]);
  });

  it('returns [] when page is not a music list', async () => {
    vi.mocked(extractPage).mockResolvedValue({
      finalUrl: 'https://example.com', httpStatus: 200, contentType: 'text/html',
      title: 'Recipe', description: null, mainText: 'pasta recipe text',
      representativeImageUrl: null, rawLinks: [], siteName: null, lang: null,
    });
    vi.mocked(generateText).mockResolvedValue({ text: 'no', usageMetadata: null });
    expect(await extractSongsFromUrl('https://example.com/recipe')).toEqual([]);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1); // detect only, no extract
  });

  it('returns [] when page has no mainText', async () => {
    vi.mocked(extractPage).mockResolvedValue({
      finalUrl: 'https://example.com', httpStatus: 200, contentType: 'text/html',
      title: null, description: null, mainText: null,
      representativeImageUrl: null, rawLinks: [], siteName: null, lang: null,
    });
    expect(await extractSongsFromUrl('https://example.com')).toEqual([]);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('returns [] when extractPage throws', async () => {
    vi.mocked(extractPage).mockRejectedValue(new Error('Network error'));
    expect(await extractSongsFromUrl('https://example.com')).toEqual([]);
  });
});
