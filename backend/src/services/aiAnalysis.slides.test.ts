import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));
vi.mock('./ollamaClient', async (importOriginal) => ({ ...(await importOriginal<typeof import('./ollamaClient')>()), generateText: vi.fn() }));

import { logWarning } from '../utils/logger';
import { generateText } from './ollamaClient';
import { carouselAboutMusic, extractFromSlides, extractFromSlidesDetailed } from './aiAnalysis';
import { MUSIC_GATE_MAX_TOKENS, MUSIC_GATE_SCHEMA, SLIDE_MAX_TOKENS } from './slideItems';

// The per-slide extraction of a carousel, on what the model really answers (10 November: ten albums on fifteen slides, `itemsFound: 0`).

const answer = (text: string, truncated = false): Awaited<ReturnType<typeof generateText>> => ({ text, usageMetadata: null, truncated }) as never;
const slides = (...texts: string[]): Array<{ slideIndex: number; text: string }> => texts.map((text, slideIndex) => ({ slideIndex, text }));
/** The verdict of the music question, the way the model writes it under the schema. */
const gate = (music: boolean): Awaited<ReturnType<typeof generateText>> => answer(`{"music" :${music} }`);

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.mocked(logWarning).mockReset();
});

describe('extractFromSlides', () => {
  it('finds the album of a slide whose answer is ONE OBJECT, not a list: the shape that read zero on the real post', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"type":"album","title":"Mystic Stylez - Three 6 Mafia"}'))
      .mockResolvedValueOnce(answer('{"type":["album"],"title":"Turn on the Bright Lights","artist":[],"director":[{"name":null}]}'))
      .mockResolvedValueOnce(gate(true));
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
    vi.mocked(generateText).mockResolvedValueOnce(answer('{"items":[{"type":"song","title":"Golden Brown","artist":"The Take Vibe E.P."}]}')).mockResolvedValueOnce(answer('{"items":[]}')).mockResolvedValueOnce(gate(true));
    const items = await extractFromSlides([{ slideIndex: 0, text: 'a' }, { slideIndex: 2, text: 'b' }]);
    expect(items).toHaveLength(1);
    expect(items[0].sourceSlide).toBe(0);
  });

  it('is one item for the same title and artist written on two slides (the first one is kept), whatever the case and the punctuation', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"items":[{"type":"album","title":"Turn on the Bright Lights","artist":"Interpol"}]}'))
      .mockResolvedValueOnce(answer('{"items":[{"type":"album","title":"TURN ON THE BRIGHT LIGHTS","artist":"interpol"},{"type":"album","title":"Antics","artist":"Interpol"}]}'))
      .mockResolvedValueOnce(gate(true));
    const items = await extractFromSlides(slides('a', 'b'));
    expect(items.map((i) => [i.title, i.sourceSlide])).toEqual([['Turn on the Bright Lights', 0], ['Antics', 1]]);
  });

  it('keeps two different artists with the same title (two songs called «Home» are two songs)', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"items":[{"type":"song","title":"Home","artist":"Depeche Mode"}]}'))
      .mockResolvedValueOnce(answer('{"items":[{"type":"song","title":"Home","artist":"Daughter"}]}'))
      .mockResolvedValueOnce(gate(true));
    expect(await extractFromSlides(slides('a', 'b'))).toHaveLength(2);
  });

  it('skips a slide whose answer was cut at the ceiling (and says so), and goes on with the others', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"items":[{"type":"album","title":"Cut', true))
      .mockResolvedValueOnce(answer('{"items":[{"type":"album","title":"Antics","artist":"Interpol"}]}'))
      .mockResolvedValueOnce(gate(true));
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

// 11 November: «songs» of a carousel are trusted only when the carousel is about music. On 403 old carousels the pass found «songs» in 164 and about nine in ten were not music: every «X - Y»
// line of the OCR of a roadmap, a stack of tools or a list of horror films was a song. ONE boolean question to the local model, asked after the slides, when they gave songs or albums.
describe('extractFromSlidesDetailed: the music gate', () => {
  const albumSlide = '{"type":"album","title":"Antics","artist":"Interpol"}';

  it('asks the question ONCE, after the slides, in JSON mode with the boolean schema, with the caption and the text of every slide', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer(albumSlide)).mockResolvedValueOnce(answer('[]')).mockResolvedValueOnce(gate(true));
    const result = await extractFromSlidesDetailed(slides('Interpol\nAntics', 'Equinox'), { caption: 'album da ascoltare tipo oggi #musica' });
    expect(generateText).toHaveBeenCalledTimes(3);
    const [prompt, images, opts] = vi.mocked(generateText).mock.calls[2];
    expect(images).toEqual([]);
    expect(opts).toEqual({ json: true, schema: MUSIC_GATE_SCHEMA, maxTokens: MUSIC_GATE_MAX_TOKENS });
    expect(prompt).toContain('album da ascoltare tipo oggi #musica');
    expect(prompt).toContain('Slide 1: Interpol Antics');
    expect(prompt).toContain('Slide 2: Equinox');
    expect(result).toMatchObject({ musicGate: 'music', droppedSongs: 0 });
    expect(result.items.map((i) => i.title)).toEqual(['Antics']);
  });

  it('throws the songs away when the carousel is not about music, and says how many: the roadmap whose OCR lines have dashes (the real junk)', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer('[]')).mockResolvedValueOnce(gate(false));
    const result = await extractFromSlidesDetailed(slides('Phase 1 - Stabilize (Month 1-2): what to systematize and\nPhase 2 - Automate (Month 3-4): top 3 processes to'));
    expect(result.items).toEqual([]);
    expect(result).toMatchObject({ musicGate: 'not_music', droppedSongs: 2 });
  });

  it('keeps the films, the books and the texts of a carousel that is not about music: the gate is about SONGS and ALBUMS only', async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(answer('{"items":[{"type":"film","title":"The Descent"},{"type":"song","title":"SCARE SCORE","artist":null},{"type":"book","title":"Dune"},{"type":"text","title":"AI FOR BUILDERS"}]}'))
      .mockResolvedValueOnce(gate(false));
    const result = await extractFromSlidesDetailed(slides('20 FILM PIU SPAVENTOSI DI SEMPRE\nTHE DESCENT\nSCARE SCORE\nDune'));
    expect(result.items.map((i) => [i.type, i.title])).toEqual([['film', 'The Descent'], ['book', 'Dune'], ['text', 'AI FOR BUILDERS']]);
    expect(result).toMatchObject({ musicGate: 'not_music', droppedSongs: 1 });
  });

  it('keeps everything of a carousel that is about music, the films next to the songs', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer('{"items":[{"type":"song","title":"Antics","artist":"Interpol"},{"type":"film","title":"Control"}]}')).mockResolvedValueOnce(gate(true));
    const result = await extractFromSlidesDetailed(slides('Interpol - Antics'));
    expect(result.items.map((i) => i.type).sort()).toEqual(['film', 'song']);
    expect(result.musicGate).toBe('music');
  });

  it('does NOT ask when the slides gave no song and no album (a list of films, nothing at all): one call for each slide and no more', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer('{"type":"film","title":"Taxi Driver"}')).mockResolvedValueOnce(answer('[]'));
    const result = await extractFromSlidesDetailed(slides('Taxi Driver', 'a slide with no dash and nothing in it'));
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ musicGate: 'not_asked', droppedSongs: 0 });
    expect(result.items.map((i) => i.title)).toEqual(['Taxi Driver']);
  });

  it.each([
    ['text that is no JSON', () => answer('Sì, è musica')],
    ['the wrong key', () => answer('{"musica":true}')],
    ['a string for a boolean', () => answer('{"music":"true"}')],
    ['an answer cut at the ceiling', () => answer('{"music" :tr', true)],
    ['an answer flagged as cut, even with a boolean in it', () => answer('{"music" :true }', true)],
  ])('an unreadable verdict (%s) is NOT a yes: the songs go, the verdict is «unreadable», and it is a warning (a second pass reads the carousel again)', async (_name, verdict) => {
    vi.mocked(generateText).mockResolvedValueOnce(answer(albumSlide)).mockResolvedValueOnce(verdict());
    const result = await extractFromSlidesDetailed(slides('Interpol\nAntics'));
    expect(result.items).toEqual([]);
    expect(result).toMatchObject({ musicGate: 'unreadable', droppedSongs: 1 });
    expect(logWarning).toHaveBeenCalled();
  });

  it('a question that fails (router asleep) is the same: the songs go, «unreadable», a warning; it never throws', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer(albumSlide)).mockRejectedValueOnce(new Error('router asleep'));
    const result = await extractFromSlidesDetailed(slides('Interpol\nAntics'));
    expect(result).toMatchObject({ items: [], musicGate: 'unreadable', droppedSongs: 1 });
    expect(logWarning).toHaveBeenCalled();
  });

  it('works with no context at all (the old call), and says «nessuna» for a missing caption', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer(albumSlide)).mockResolvedValueOnce(gate(true));
    expect((await extractFromSlidesDetailed(slides('Interpol\nAntics'))).items).toHaveLength(1);
    expect(vi.mocked(generateText).mock.calls[1][0]).toContain('Didascalia:\n(nessuna)');
  });

  it('extractFromSlides is the same extraction and gives the items only', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer(albumSlide)).mockResolvedValueOnce(gate(false));
    expect(await extractFromSlides(slides('Interpol\nAntics'))).toEqual([]);
  });
});

describe('carouselAboutMusic: the question alone (the recovery script asks it BEFORE reading the slides one by one)', () => {
  it('is true or false as the model says, with the caption and the slides in the prompt', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(gate(true)).mockResolvedValueOnce(gate(false));
    expect(await carouselAboutMusic(slides('JAZZ RECS'), '5 modern jazz songs')).toBe(true);
    expect(vi.mocked(generateText).mock.calls[0][0]).toContain('5 modern jazz songs');
    expect(await carouselAboutMusic(slides('AI FOR BUILDERS'), null)).toBe(false);
  });

  it('is null (not a yes, not a no) when the answer is not a boolean, was cut, or the call fails; it never throws', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(answer('???')).mockResolvedValueOnce(answer('{"music" :tr', true)).mockRejectedValueOnce(new Error('down'));
    expect(await carouselAboutMusic(slides('x'), null)).toBeNull();
    expect(await carouselAboutMusic(slides('x'), null)).toBeNull();
    expect(await carouselAboutMusic(slides('x'), null)).toBeNull();
  });
});
