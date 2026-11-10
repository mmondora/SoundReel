import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));
vi.mock('./ollamaClient', async (importOriginal) => ({ ...(await importOriginal<typeof import('./ollamaClient')>()), generateText: vi.fn() }));

import { logWarning } from '../utils/logger';
import { generateText } from './ollamaClient';
import { extractFromSlides } from './aiAnalysis';
import { SLIDE_MAX_TOKENS } from './slideItems';

// The per-slide extraction of a carousel, on what the model really answers (10 November: ten albums on fifteen slides, `itemsFound: 0`).

const answer = (text: string, truncated = false): Awaited<ReturnType<typeof generateText>> => ({ text, usageMetadata: null, truncated }) as never;
const slides = (...texts: string[]): Array<{ slideIndex: number; text: string }> => texts.map((text, slideIndex) => ({ slideIndex, text }));

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.mocked(logWarning).mockReset();
});

describe('extractFromSlides', () => {
  it('finds the album of a slide whose answer is ONE OBJECT, not a list: the shape that read zero on the real post', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"type":"album","title":"Mystic Stylez - Three 6 Mafia"}'))
      .mockResolvedValueOnce(answer('{"type":["album"],"title":"Turn on the Bright Lights","artist":[],"director":[{"name":null}]}'));
    const items = await extractFromSlides(slides('Three 6 Mafia\nMystic Stylez', 'Interpol\nTurn on the Bright Lights'));
    expect(items.map((i) => [i.type, i.title, i.artist, i.sourceSlide])).toEqual([
      ['album', 'Mystic Stylez', 'Three 6 Mafia', 0],
      ['album', 'Turn on the Bright Lights', 'Interpol', 1],
    ]);
  });

  it('asks every slide in JSON mode, with a ceiling on the answer and no schema (under a grammar this local model writes empty titles), and the prompt carries the slide and its text', async () => {
    vi.mocked(generateText).mockResolvedValue(answer('[]'));
    await extractFromSlides([{ slideIndex: 4, text: 'Interpol' }, { slideIndex: 7, text: 'Equinox' }]);
    expect(generateText).toHaveBeenCalledTimes(2);
    const [prompt, images, opts] = vi.mocked(generateText).mock.calls[0];
    expect(images).toEqual([]);
    expect(opts).toEqual({ json: true, maxTokens: SLIDE_MAX_TOKENS });
    expect(prompt).toContain('slide 5 di 2');
    expect(prompt).toContain('Interpol');
    expect(vi.mocked(generateText).mock.calls[1][0]).toContain('slide 8 di 2');
  });

  it('keeps the index of the slide each item came from (the post links back to it)', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer('{"items":[{"type":"song","title":"Golden Brown","artist":"The Take Vibe E.P."}]}')).mockResolvedValueOnce(answer('{"items":[]}'));
    const items = await extractFromSlides([{ slideIndex: 0, text: 'a' }, { slideIndex: 2, text: 'b' }]);
    expect(items).toHaveLength(1);
    expect(items[0].sourceSlide).toBe(0);
  });

  it('is one item for the same title and artist written on two slides (the first one is kept), whatever the case and the punctuation', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"items":[{"type":"album","title":"Turn on the Bright Lights","artist":"Interpol"}]}'))
      .mockResolvedValueOnce(answer('{"items":[{"type":"album","title":"TURN ON THE BRIGHT LIGHTS","artist":"interpol"},{"type":"album","title":"Antics","artist":"Interpol"}]}'));
    const items = await extractFromSlides(slides('a', 'b'));
    expect(items.map((i) => [i.title, i.sourceSlide])).toEqual([['Turn on the Bright Lights', 0], ['Antics', 1]]);
  });

  it('keeps two different artists with the same title (two songs called «Home» are two songs)', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"items":[{"type":"song","title":"Home","artist":"Depeche Mode"}]}'))
      .mockResolvedValueOnce(answer('{"items":[{"type":"song","title":"Home","artist":"Daughter"}]}'));
    expect(await extractFromSlides(slides('a', 'b'))).toHaveLength(2);
  });

  it('skips a slide whose answer was cut at the ceiling (and says so), and goes on with the others', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"items":[{"type":"album","title":"Cut', true))
      .mockResolvedValueOnce(answer('{"items":[{"type":"album","title":"Antics","artist":"Interpol"}]}'));
    const items = await extractFromSlides(slides('a', 'b'));
    expect(items.map((i) => i.title)).toEqual(['Antics']);
    expect(logWarning).toHaveBeenCalled();
  });

  it('a slide that fails (router asleep) is a warning, not the end: the other slides are read', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('router asleep')).mockResolvedValueOnce(answer('{"items":[{"type":"film","title":"Taxi Driver"}]}'));
    const items = await extractFromSlides(slides('a', 'b'));
    expect(items.map((i) => i.title)).toEqual(['Taxi Driver']);
    expect(logWarning).toHaveBeenCalled();
  });

  it('does not ask for a slide with no text, and with no slide at all it asks nothing', async () => {
    vi.mocked(generateText).mockResolvedValue(answer('[]'));
    expect(await extractFromSlides([])).toEqual([]);
    await extractFromSlides([{ slideIndex: 0, text: '   ' }, { slideIndex: 1, text: 'x' }]);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
