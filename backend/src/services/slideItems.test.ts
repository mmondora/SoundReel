import { describe, expect, it } from 'vitest';
import type { ActionLogItem, EntrySlide } from '../types';
import {
  MUSIC_GATE_MAX_TOKENS,
  MUSIC_GATE_SCHEMA,
  buildMusicGatePrompt,
  buildSlidePrompt,
  carouselItemsFoundBefore,
  dashedPairs,
  isMusicItem,
  itemsOfSlide,
  parseMusicVerdict,
  parseSlideItems,
  refineSlideItems,
  slideItemKey,
  storedSlideOcrTexts,
  tidyItem,
  type SlideItem,
} from './slideItems';

// The per-slide extraction of a carousel (10 November, two links of Michele: «5 modern jazz songs» with 6 slides and «album da ascoltare» with 15 slides,
// 10 albums, both read 0 items). The prompt asked for a JSON ARRAY while the call was in JSON mode; the model answered with ONE OBJECT per slide
// (`{"type":"album","title":"Mystic Stylez - Three 6 Mafia"}`), the code looked for `[...]` in the text, found none and dropped the slide in silence. These are
// the shapes the model really answers, taken from the real run, and the schema that makes the answer one shape.

describe('parseSlideItems: the shapes the model really answers', () => {
  it('reads {"items":[…]} (the shape the schema asks for)', () => {
    const raw = JSON.stringify({ items: [{ type: 'album', title: 'Mystic Stylez', artist: 'Three 6 Mafia', director: null, year: null, notes: null }] });
    expect(parseSlideItems(raw, 3)).toEqual([{ type: 'album', title: 'Mystic Stylez', artist: 'Three 6 Mafia', director: null, year: null, notes: null, sourceSlide: 3 }]);
  });

  it('reads a bare array (the shape the old prompt asked for)', () => {
    const raw = JSON.stringify([{ type: 'song', title: 'Golden Brown', artist: 'The Take Vibe E.P.' }]);
    expect(parseSlideItems(raw, 0)).toEqual([{ type: 'song', title: 'Golden Brown', artist: 'The Take Vibe E.P.', director: null, year: null, notes: null, sourceSlide: 0 }]);
  });

  it('reads a SINGLE object: what the model answers when the slide has one album, and what lost all ten of them', () => {
    const raw = '{"type":"album","title":"Mystic Stylez - Three 6 Mafia"}';
    expect(parseSlideItems(raw, 3)).toEqual([{ type: 'album', title: 'Mystic Stylez - Three 6 Mafia', artist: null, director: null, year: null, notes: null, sourceSlide: 3 }]);
  });

  it('reads the odd shape with lists where text belongs (type ["album"], artist [], director [{…}]): the text fields are text, the empty list is null', () => {
    const raw = '{"type":["album"],"title":"Turn on the Bright Lights","artist":[],"director":[{"name":null,"year":{"value":"","notes":""}}]}';
    expect(parseSlideItems(raw, 4)).toEqual([{ type: 'album', title: 'Turn on the Bright Lights', artist: null, director: null, year: null, notes: null, sourceSlide: 4 }]);
  });

  it('joins a list of artists, and takes the first text of a list of types', () => {
    const raw = '{"type":["song","album"],"title":"Set It Free","artist":["Nubya Garcia","Richie Seivwright"]}';
    const [item] = parseSlideItems(raw, 2);
    expect(item.type).toBe('song');
    expect(item.artist).toBe('Nubya Garcia, Richie Seivwright');
  });

  it('finds the list under another key too (the model invents «objects», «results»…)', () => {
    expect(parseSlideItems('{"objects":[{"type":"film","title":"Taxi Driver","director":"Martin Scorsese","year":1976}]}', 2)).toEqual([
      { type: 'film', title: 'Taxi Driver', artist: null, director: 'Martin Scorsese', year: 1976, notes: null, sourceSlide: 2 },
    ]);
  });

  it('finds the JSON inside a few words of text around it', () => {
    const raw = 'Ecco: {"items":[{"type":"book","title":"Il nome della rosa","artist":null}]} fine';
    expect(parseSlideItems(raw, 1).map((i) => i.title)).toEqual(['Il nome della rosa']);
  });

  it('an empty answer, no items, text that is no JSON, or no text at all are nothing, never an exception', () => {
    for (const raw of ['', '   ', '[]', '{}', '{"items":[]}', 'nessun brano', '{"items": [', 'null', '42', '"testo"']) {
      expect(parseSlideItems(raw, 0)).toEqual([]);
    }
  });

  it('drops an item with no title, an empty or blank one, one with no letter or digit, and anything that is not an object', () => {
    const raw = JSON.stringify({ items: [{ type: 'song' }, { type: 'song', title: '   ' }, { type: 'song', title: '...' }, { type: 'song', title: 'Equinox', artist: 'John Coltrane' }, 'testo', null, 7] });
    expect(parseSlideItems(raw, 0).map((i) => i.title)).toEqual(['Equinox']);
  });

  it('writes the type the pipeline knows: movie → film, track → song, record or disco → album, libro → book, anything else → text', () => {
    const type = (t: string): string => parseSlideItems(JSON.stringify({ items: [{ type: t, title: 'X' }] }), 0)[0].type;
    expect([type('movie'), type('Track'), type('record'), type('DISCO'), type('libro'), type('Song'), type('podcast'), type('')]).toEqual(['film', 'song', 'album', 'album', 'book', 'song', 'text', 'text']);
  });

  it('takes a year written as a number or as text when it is a sane year, and nothing else', () => {
    const year = (y: unknown): number | null => parseSlideItems(JSON.stringify({ items: [{ type: 'film', title: 'X', year: y }] }), 0)[0].year ?? null;
    expect([year(1976), year('1976'), year(' 2013 '), year(12), year(99999), year('abc'), year(null), year(1976.5)]).toEqual([1976, 1976, 2013, null, null, null, null, null]);
  });

  it('cleans the title: quotes and spaces around it go, inner spaces are one; a very long one is cut', () => {
    const [a] = parseSlideItems('{"items":[{"type":"album","title":"  «Turn  on the   Bright Lights»  "}]}', 0);
    expect(a.title).toBe('Turn on the Bright Lights');
    const [b] = parseSlideItems(JSON.stringify({ items: [{ type: 'text', title: 'x'.repeat(500) }] }), 0);
    expect(b.title.length).toBe(200);
  });

  it('keeps the notes (cut at 300) and the slide it came from', () => {
    const [item] = parseSlideItems(JSON.stringify({ items: [{ type: 'album', title: 'A', notes: 'n'.repeat(400) }] }), 9);
    expect(item.notes?.length).toBe(300);
    expect(item.sourceSlide).toBe(9);
  });
});

describe('the prompt of one slide', () => {
  it('says which slide it is, carries the text and asks for JSON with the title and the artist apart (the shape this local model answers well: an object per slide)', () => {
    const prompt = buildSlidePrompt(3, 15, 'Three 6 Mafia\nMystic Stylez');
    expect(prompt).toContain('slide 4 di 15');
    expect(prompt).toContain('Three 6 Mafia\nMystic Stylez');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"artist"');
  });
});

const item = (over: Partial<SlideItem>): SlideItem => ({ type: 'album', title: 'X', artist: null, director: null, year: null, notes: null, sourceSlide: 0, ...over });

// What the local model really reads from the slides of the two links (10 November): it gives the TITLE and leaves the artist empty, sometimes writes both in the title, takes
// a comment for a song and a header for an album. The OCR text of the slide has the answer: the artist is the line before the title.
describe('refineSlideItems: the artist from the OCR lines, and no comments for songs', () => {
  it('takes the artist from the line before the title («Drake» before «Nothing Was The Same»)', () => {
    const ocr = 'Drake\nNothing Was The Same\n\nsanno tutti che sei soft e hai sempre\nla presa a male, tanto v';
    expect(refineSlideItems([item({ title: 'Nothing Was The Same' })], ocr)).toEqual([item({ title: 'Nothing Was The Same', artist: 'Drake' })]);
  });

  it('cleans the symbols the OCR leaves after a name («Interpol ©»)', () => {
    const ocr = 'Interpol ©\nTurn on the Bright Lights\n\nsd\n\nInterpol\nTurn on the Bright Lights\n\ndark, malinconico';
    expect(refineSlideItems([item({ title: 'Turn on the Bright Lights' })], ocr)[0].artist).toBe('Interpol');
  });

  it('splits a title that holds both («Mystic Stylez - Three 6 Mafia»), using which of the two sits on the line before the other', () => {
    const ocr = '“DJ PAUL & JUICY J”\n\nilo i MA VPI\n\nMYSTIC sry LEZ\n\nThree 6 Mafia\nMystic Stylez\n\nlivelli di darkness inarrivabili a distanza';
    expect(refineSlideItems([item({ title: 'Mystic Stylez - Three 6 Mafia' })], ocr)).toEqual([item({ title: 'Mystic Stylez', artist: 'Three 6 Mafia' })]);
  });

  it('finds the title even when the OCR splits a word or the model joins two («Taxidriver» for «Taxi Driver»), but only fills the artist of a song or an album', () => {
    const ocr = 'ROBERT DE NIRO\nI AXI DRIVER\n\nBernard Hermann\nTaxi Driver\n\nserve aggiungere altro?';
    expect(refineSlideItems([item({ type: 'album', title: 'Taxidriver' })], ocr)[0].artist).toBe('Bernard Hermann');
    expect(refineSlideItems([item({ type: 'film', title: 'Taxidriver' })], ocr)[0].artist).toBeNull();
  });

  it('leaves the artist the model gave, and leaves it empty when the line before is a sentence, a handle or too long (no guess is better than a wrong artist)', () => {
    expect(refineSlideItems([item({ title: 'Dummy', artist: 'Portishead' })], 'Massive Attack\nDummy')[0].artist).toBe('Portishead');
    expect(refineSlideItems([item({ title: 'Dummy' })], 'Ascolta questo disco, è bellissimo e ti cambia la giornata.\nDummy')[0].artist).toBeNull();
    expect(refineSlideItems([item({ title: 'Dummy' })], '@qualcuno\nDummy')[0].artist).toBeNull();
    expect(refineSlideItems([item({ title: 'Dummy' })], 'Dummy')[0].artist).toBeNull();
    expect(refineSlideItems([item({ title: 'Dummy' })], 'Un nome lungo di tante parole che non finisce più mai qui\nDummy')[0].artist).toBeNull();
  });

  it('drops a song or an album that is a comment: a long sentence, a sentence with punctuation, a lowercase phrase; films, books and texts are not touched', () => {
    const comment = item({ type: 'song', title: 'se vuoi anche che la città sprofondi insieme alla nebbia' });
    const sentence = item({ type: 'album', title: 'Sono 10 dischi per andare in giro. Ascoltali tutti!' });
    const ok = item({ type: 'album', title: 'The Downward Spiral' });
    expect(refineSlideItems([comment, sentence, ok], 'x').map((i) => i.title)).toEqual(['The Downward Spiral']);
    const film = item({ type: 'film', title: 'se vuoi anche che la città sprofondi insieme alla nebbia' });
    expect(refineSlideItems([film], 'x')).toHaveLength(1);
  });

  it('drops an item whose title is its own artist or a single letter', () => {
    expect(refineSlideItems([item({ type: 'song', title: 'Drake', artist: 'Drake' }), item({ type: 'song', title: 'a' })], 'x')).toEqual([]);
  });
});

describe('refineSlideItems and dashedPairs: the edges of every rule', () => {
  const titles = (items: SlideItem[]): string[] => items.map((i) => i.title);

  it('a sentence is more than eight words, a phrase that starts in lowercase from five words, or a question or an exclamation from three; a short title with «!» or «?» is a real title', () => {
    expect(titles(refineSlideItems([item({ type: 'song', title: 'Sono dieci dischi da ascoltare quando fa freddo fuori' })], 'x'))).toEqual([]);
    expect(titles(refineSlideItems([item({ type: 'song', title: 'Sono otto dischi da ascoltare quando fa freddo' })], 'x'))).toEqual(['Sono otto dischi da ascoltare quando fa freddo']);
    expect(titles(refineSlideItems([item({ type: 'song', title: 'perfetto ma se pioviggina ricordati' })], 'x'))).toEqual([]);
    expect(titles(refineSlideItems([item({ type: 'song', title: 'Perché non lo ascolti ancora?' })], 'x'))).toEqual([]);
    expect(titles(refineSlideItems([item({ type: 'song', title: 'Hey Ya!' }), item({ type: 'song', title: 'Why?' })], 'x'))).toEqual(['Hey Ya!', 'Why?']);
  });

  it('the artist line is a name: up to six words and forty characters', () => {
    expect(refineSlideItems([item({ title: 'Dummy' })], 'Uno Due Tre Quattro Cinque Sei\nDummy')[0].artist).toBe('Uno Due Tre Quattro Cinque Sei');
    expect(refineSlideItems([item({ title: 'Dummy' })], 'Uno Due Tre Quattro Cinque Sei Sette\nDummy')[0].artist).toBeNull();
    expect(refineSlideItems([item({ title: 'Dummy' })], 'Supercalifragilistichespiralidoso Anticostituzionalissimamente\nDummy')[0].artist).toBeNull();
  });

  it('a title written on two lines in a row is not its own artist', () => {
    expect(refineSlideItems([item({ title: 'Dummy' })], 'Dummy\nDummy')[0].artist).toBeNull();
  });

  it('tells the artist from the title in a combined title in either order, by the lines of the slide', () => {
    const ocr = 'Three 6 Mafia\nMystic Stylez';
    expect(refineSlideItems([item({ title: 'Three 6 Mafia - Mystic Stylez' })], ocr)).toEqual([item({ title: 'Mystic Stylez', artist: 'Three 6 Mafia' })]);
    expect(refineSlideItems([item({ title: 'Mystic Stylez - Three 6 Mafia' })], ocr)).toEqual([item({ title: 'Mystic Stylez', artist: 'Three 6 Mafia' })]);
    // lines that do not say which is which: no guess, the title stays as the model wrote it
    expect(refineSlideItems([item({ title: 'Mystic Stylez - Three 6 Mafia' })], 'Mystic Stylez\n\nunaltrariga\nThree 6 Mafia')[0]).toMatchObject({ title: 'Mystic Stylez - Three 6 Mafia', artist: null });
  });

  it('a title wraps on the next line only when it is one or two words, the next line is up to three words in the same case and no tag', () => {
    expect(dashedPairs('ARTIST - THREE WORD TITLE\nMORE')).toEqual([{ artist: 'ARTIST', title: 'THREE WORD TITLE' }]);
    expect(dashedPairs('ARTIST - TITLE\nTHIS IS A LONG LINE')).toEqual([{ artist: 'ARTIST', title: 'TITLE' }]);
    expect(dashedPairs('Portishead - Roads\nTHE END')).toEqual([{ artist: 'Portishead', title: 'Roads' }]);
    expect(dashedPairs('ARTIST - TITLE\nOUT NOW')).toEqual([{ artist: 'ARTIST', title: 'TITLE' }]);
    expect(dashedPairs('ARTIST - TITLE\nMORE')).toEqual([{ artist: 'ARTIST', title: 'TITLE MORE' }]);
  });

  it('finds an object that is no list in a few words of text around it', () => {
    expect(parseSlideItems('Ecco: {"type":"book","title":"Il nome della rosa"} fine', 1).map((i) => i.title)).toEqual(['Il nome della rosa']);
  });
});

describe('dashedPairs: «ARTIST - TITLE» on a line (the way a list of songs is written)', () => {
  it('reads the two real slides of the jazz carousel, with a title that wraps on the next line', () => {
    expect(dashedPairs('aa ”\n\nJAZZ RECS\n\nTHE TAKE.-VIBE.E.P. - GOLDEN\nBROWN')).toEqual([{ artist: 'THE TAKE.-VIBE.E.P.', title: 'GOLDEN BROWN' }]);
    expect(dashedPairs('JAZZ RECS\n\nNUBYA GARCIA, RICHIE - SET\nIT FREE')).toEqual([{ artist: 'NUBYA GARCIA, RICHIE', title: 'SET IT FREE' }]);
  });

  it('reads a title that fits on its line, in any case, and several pairs on one slide (one for each line)', () => {
    expect(dashedPairs('Portishead – Roads\nMassive Attack — Teardrop')).toEqual([
      { artist: 'Portishead', title: 'Roads' },
      { artist: 'Massive Attack', title: 'Teardrop' },
    ]);
  });

  it('does not take the next line when it is not a continuation (a «new» tag, a sentence, another pair)', () => {
    expect(dashedPairs('Portishead - Roads\nOUT NOW')).toEqual([{ artist: 'Portishead', title: 'Roads' }]);
    expect(dashedPairs('Portishead - Roads\nun disco che ascolto da anni')).toEqual([{ artist: 'Portishead', title: 'Roads' }]);
  });

  it('is nothing for a sentence with a dash, a hashtag, a handle, a link, a hyphen with no spaces or a line too long', () => {
    for (const text of ['È un disco - bellissimo, ascoltalo adesso!', '#jazz - #musica', '@account - nuovo post', 'https://example.com - sito', 'Jazz-Funk Weekend', 'Un artista con un nome davvero troppo lungo per essere vero - Un titolo']) {
      expect(dashedPairs(text)).toEqual([]);
    }
  });
});

describe('itemsOfSlide: the model and the lines of the slide together', () => {
  it('a slide with an «ARTIST - TITLE» line takes the pair and drops the model\'s album that is only the beginning of the artist or a header (the jazz carousel)', () => {
    const ocr = 'aa ”\n\nJAZZ RECS\n\nTHE TAKE.-VIBE.E.P. - GOLDEN\nBROWN';
    const got = itemsOfSlide([item({ type: 'album', title: 'THE TAKE' }), item({ type: 'album', title: 'JAZZ RECS' })], ocr, 0);
    expect(got.map((i) => [i.type, i.title, i.artist, i.sourceSlide])).toEqual([['song', 'GOLDEN BROWN', 'THE TAKE.-VIBE.E.P.', 0]]);
  });

  it('keeps the model\'s item when it IS the title of the pair, and gives it the artist of the pair when it had none', () => {
    const got = itemsOfSlide([item({ type: 'song', title: 'Roads' })], 'Portishead - Roads', 4);
    expect(got).toEqual([item({ type: 'song', title: 'Roads', artist: 'Portishead' })]);
  });

  it('keeps the films, books and texts of the model next to the pairs, and puts one pair for each line', () => {
    const got = itemsOfSlide([item({ type: 'film', title: 'Taxi Driver' })], 'Portishead - Roads\nMassive Attack - Teardrop', 2);
    expect(got.map((i) => [i.type, i.title])).toEqual([['film', 'Taxi Driver'], ['song', 'Roads'], ['song', 'Teardrop']]);
  });

  it('without a pair it is the model\'s items mended by the OCR (the artist from the line before)', () => {
    expect(itemsOfSlide([item({ title: 'Nothing Was The Same' })], 'Drake\nNothing Was The Same\n\nsanno tutti che sei soft', 6)).toEqual([item({ title: 'Nothing Was The Same', artist: 'Drake' })]);
  });

  it('is nothing when the model found nothing and the slide has no pair', () => {
    expect(itemsOfSlide([], 'una slide di testo qualunque', 0)).toEqual([]);
  });
});

describe('dashedPairs: the rank of a list that the OCR wrote without its dot («3 Chip E.»)', () => {
  const ocr = [
    '1. Jesse Saunders - On and On (1984, Jes Say Records)',
    '2. Chip E. - Time to Jack (1985, DJ International)',
    '3 Chip E. - It\'s House (1985, DJ International)',
    '4 J.M. Silk - Music Is the Key (1985, DJ International)',
    '5 Mr. Fingers - Mystery of Love (1985, Trax Records)',
  ].join('\n');

  it('takes a number before the artist for a rank when the numbers of the neighbouring lines go up by one, with the dot or without it (the 100 «essential» tracks lists lost the dot on half of the lines)', () => {
    expect(dashedPairs(ocr).map((p) => p.artist)).toEqual(['Jesse Saunders', 'Chip E.', 'Chip E.', 'J.M. Silk', 'Mr. Fingers']);
  });

  it('keeps a number that is part of a name when the numbers do not go up by one («50 Cent», «2 Chainz»), and a single line with a number (it could be a name)', () => {
    expect(dashedPairs('50 Cent - In Da Club\n2 Chainz - Birthday Song').map((p) => p.artist)).toEqual(['50 Cent', '2 Chainz']);
    expect(dashedPairs('3 Chip E. - It\'s House').map((p) => p.artist)).toEqual(['3 Chip E.']);
    expect(dashedPairs('1. Charlie - Spacer Woman').map((p) => p.artist)).toEqual(['1. Charlie']);
  });

  it('only the lines that are in a run lose their number: a name with a number in the middle of a list stays', () => {
    const mixed = ['7 Marshall Jefferson - Move Your Body', '8 Adonis - No Way Back', '50 Cent - In Da Club'].join('\n');
    expect(dashedPairs(mixed).map((p) => p.artist)).toEqual(['Marshall Jefferson', 'Adonis', '50 Cent']);
  });

  it('a countdown is a run too (a «top 10» that goes 10, 9, 8…): the numbers differ by one, up or down', () => {
    expect(dashedPairs('9 Mr. Fingers - Can You Feel It\n8 Adonis - No Way Back\n7 Marshall Jefferson - Move Your Body').map((p) => p.artist)).toEqual(['Mr. Fingers', 'Adonis', 'Marshall Jefferson']);
  });

  it('numbers that do not differ by one are not a run, in either direction (9 then 7, 3 then 3): the names stay', () => {
    expect(dashedPairs('9 Mr. Fingers - Can You Feel It\n7 Adonis - No Way Back').map((p) => p.artist)).toEqual(['9 Mr. Fingers', '7 Adonis']);
    expect(dashedPairs('3 Doors Down - Kryptonite\n3 Inches of Blood - Deadly Sinners').map((p) => p.artist)).toEqual(['3 Doors Down', '3 Inches of Blood']);
  });

  it('goes through itemsOfSlide too: the songs of a slide of the list have the artist without the rank, and the year apart', () => {
    const items = itemsOfSlide([], ocr, 2);
    expect(items.map((i) => [i.title, i.artist, i.year])).toEqual([
      ['On and On', 'Jesse Saunders', 1984],
      ['Time to Jack', 'Chip E.', 1985],
      ['It\'s House', 'Chip E.', 1985],
      ['Music Is the Key', 'J.M. Silk', 1985],
      ['Mystery of Love', 'Mr. Fingers', 1985],
    ]);
  });
});

describe('slideItemKey: the same item on two slides is one', () => {
  it('ignores case, accents and punctuation, and tells two artists apart', () => {
    expect(slideItemKey(item({ title: 'Turn on the Bright Lights', artist: 'Interpol' }))).toBe(slideItemKey(item({ title: 'TURN ON THE BRIGHT LIGHTS!', artist: 'interpol' })));
    expect(slideItemKey(item({ title: 'Home', artist: 'Depeche Mode' }))).not.toBe(slideItemKey(item({ title: 'Home', artist: 'Daughter' })));
    expect(slideItemKey(item({ title: 'Café', artist: null }))).toBe(slideItemKey(item({ title: 'cafe', artist: null })));
  });
});

describe('storedSlideOcrTexts: the slides an entry already carries, for a second pass', () => {
  const slide = (index: number, ocrText: string | null): EntrySlide => ({ index, imageUrl: null, ocrText, visualDescription: null, summary: null, links: [] });

  it('takes the OCR text of each slide with its own index and skips the slides with none', () => {
    expect(storedSlideOcrTexts([slide(0, 'uno'), slide(1, null), slide(2, '   '), slide(3, 'quattro')])).toEqual([
      { slideIndex: 0, text: 'uno' },
      { slideIndex: 3, text: 'quattro' },
    ]);
  });

  it('is nothing for no slides', () => {
    expect(storedSlideOcrTexts([])).toEqual([]);
    expect(storedSlideOcrTexts(undefined)).toEqual([]);
  });
});

describe('carouselItemsFoundBefore: what the last pass found in the slides', () => {
  const log = (action: string, details: Record<string, unknown>): ActionLogItem => ({ action, details, timestamp: '2026-11-10T22:00:00Z' });

  it('is the itemsFound of the LAST carousel_extraction line', () => {
    expect(carouselItemsFoundBefore([log('carousel_extraction', { slides: 6, itemsFound: 0 }), log('ai_analyzed', {}), log('carousel_extraction', { slides: 6, itemsFound: 4 })])).toBe(4);
    expect(carouselItemsFoundBefore([log('carousel_extraction', { slides: 6, itemsFound: 4 }), log('carousel_extraction', { slides: 6, itemsFound: 0 })])).toBe(0);
  });

  it('is zero with no such line, no log, or a count that is no number', () => {
    expect(carouselItemsFoundBefore([log('ai_analyzed', {})])).toBe(0);
    expect(carouselItemsFoundBefore([])).toBe(0);
    expect(carouselItemsFoundBefore(undefined)).toBe(0);
    expect(carouselItemsFoundBefore([log('carousel_extraction', { itemsFound: 'tre' })])).toBe(0);
    expect(carouselItemsFoundBefore([log('carousel_extraction', { itemsFound: -2 })])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// 11 November: the preview of the old carousels read «songs» in 164 of 403, and about nine in ten were not music: a business roadmap, a Flutter stack, tinnitus, finance, a list of horror
// films. The model typed them well («text»); the «ARTIST - TITLE» lines of the OCR (`dashedPairs`) made songs of every line with a dash («Phase 1 - Stabilize…»). The songs of a carousel
// are now trusted only when the carousel is about MUSIC, which the local model says in one yes/no question (a boolean under a schema: free JSON gave `{"false}:thinking_face:"…`).
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe('the music gate: the question, and the reading of the answer', () => {
  const slidesOf = (...texts: string[]): Array<{ slideIndex: number; text: string }> => texts.map((text, slideIndex) => ({ slideIndex, text }));

  it('asks about MUSIC to listen to (songs, albums, records, artists) and says that films, series, books, software, AI, finance and health are not, even with lists and dashes', () => {
    const prompt = buildMusicGatePrompt('5 modern jazz songs', slidesOf('JAZZ RECS'));
    expect(prompt).toContain('elenca o consiglia MUSICA da ascoltare (canzoni, album, dischi, artisti musicali)');
    expect(prompt).toContain('Film, serie, libri, software, intelligenza artificiale, finanza, salute');
    expect(prompt).toContain('anche se il testo ha elenchi con trattini o numeri');
    expect(prompt).toContain('{"music": true} oppure {"music": false}');
  });

  it('carries the caption and every slide with its own number (the first slide is «Slide 1», whatever index it has in the carousel list: the index counts from zero)', () => {
    const prompt = buildMusicGatePrompt('album da ascoltare tipo oggi #musica', [{ slideIndex: 0, text: 'Mystic Stylez' }, { slideIndex: 4, text: 'Interpol\nAntics' }]);
    expect(prompt).toContain('Didascalia:\nalbum da ascoltare tipo oggi #musica');
    expect(prompt).toContain('Slide 1: Mystic Stylez');
    expect(prompt).toContain('Slide 5: Interpol Antics');
  });

  it('says so when there is no caption, and cuts the caption at 500 characters, each slide at 260 and the whole text of the slides at 2600 (a hundred-slide carousel is a question, not a book)', () => {
    expect(buildMusicGatePrompt(null, slidesOf('a'))).toContain('Didascalia:\n(nessuna)');
    expect(buildMusicGatePrompt('   ', slidesOf('a'))).toContain('Didascalia:\n(nessuna)');
    const long = buildMusicGatePrompt('c'.repeat(900), slidesOf('s'.repeat(900)));
    expect(long).toContain(`Didascalia:\n${'c'.repeat(500)}\n`);
    expect(long).not.toContain('c'.repeat(501));
    expect(long).toContain(`Slide 1: ${'s'.repeat(260)}\n`);
    expect(long).not.toContain('s'.repeat(261));
    const many = buildMusicGatePrompt('x', slidesOf(...Array.from({ length: 40 }, () => 'w'.repeat(260))));
    const slidesPart = many.slice(many.indexOf('Slide 1:'), many.indexOf('Domanda:'));
    expect(slidesPart.length).toBeLessThanOrEqual(2600 + 2);
    expect(slidesPart).toContain('Slide 9:');
    expect(slidesPart).not.toContain('Slide 12:');
  });

  it('the answer is ONE boolean under a schema, in few tokens', () => {
    expect(MUSIC_GATE_SCHEMA).toEqual({ type: 'object', properties: { music: { type: 'boolean' } }, required: ['music'] });
    expect(MUSIC_GATE_MAX_TOKENS).toBe(40);
  });

  it('reads the boolean exactly the way the model writes it under the schema, with a few words around it too, and NOTHING else is a verdict', () => {
    expect(parseMusicVerdict('{"music":true}')).toBe(true);
    expect(parseMusicVerdict('{"music" :true }')).toBe(true);
    expect(parseMusicVerdict('{"music" :false }')).toBe(false);
    expect(parseMusicVerdict('Risposta: {"music": true}.')).toBe(true);
    expect(parseMusicVerdict('{"music":"true"}')).toBeNull();
    expect(parseMusicVerdict('{"music":1}')).toBeNull();
    expect(parseMusicVerdict('{"musica":true}')).toBeNull();
    expect(parseMusicVerdict('{"music":true,"album":["Marquee Moon"]}')).toBe(true);
    expect(parseMusicVerdict('{"false}:thinking_face:":\n1.0\n  }')).toBeNull();
    expect(parseMusicVerdict('[true]')).toBeNull();
    expect(parseMusicVerdict('true')).toBeNull();
    expect(parseMusicVerdict('')).toBeNull();
  });

  it('a music item is a song or an album: a film, a book and a text are not', () => {
    const item = (type: SlideItem['type']): SlideItem => ({ type, title: 't', sourceSlide: 0 });
    expect(['song', 'album', 'film', 'book', 'text'].map((t) => isMusicItem(item(t as SlideItem['type'])))).toEqual([true, true, false, false, false]);
  });
});

describe('tidyItem: a rank before the artist and a year after the title are not part of the names (the lists of 100 «essential» tracks)', () => {
  const song = (title: string, artist: string | null, year: number | null = null, type: SlideItem['type'] = 'song'): SlideItem => ({ type, title, artist, year, sourceSlide: 0 });

  it('drops «1.» «12)» «#3:» before the artist, and keeps a number that IS the name («50 Cent», «2 Chainz»)', () => {
    expect(tidyItem(song('Spacer Woman', '1. Charlie')).artist).toBe('Charlie');
    expect(tidyItem(song('Switched-On Bach', '1.Wendy Carlos')).artist).toBe('Wendy Carlos');
    expect(tidyItem(song('x', '12) Koto')).artist).toBe('Koto');
    expect(tidyItem(song('x', '#3: Laserdance')).artist).toBe('Laserdance');
    expect(tidyItem(song('In Da Club', '50 Cent')).artist).toBe('50 Cent');
    expect(tidyItem(song('Birthday Song', '2 Chainz')).artist).toBe('2 Chainz');
  });

  it('moves a year in brackets at the end of the title into `year`, with a label, a country or a comma around it', () => {
    expect(tidyItem(song('Switched-On Bach (1968)', 'Wendy Carlos'))).toMatchObject({ title: 'Switched-On Bach', year: 1968 });
    expect(tidyItem(song('Spacer Woman - Original Version (ZYX 1984)', 'Charlie'))).toMatchObject({ title: 'Spacer Woman - Original Version', year: 1984 });
    expect(tidyItem(song('On and On (1984, Jes Say Records)', 'Jesse Saunders'))).toMatchObject({ title: 'On and On', year: 1984 });
    expect(tidyItem(song('Humanoid Invasion (ZYX 1986*)', 'Laserdance'))).toMatchObject({ title: 'Humanoid Invasion', year: 1986 });
    expect(tidyItem(song('Polaris ( (Memory records 1984)', 'Cyber People'))).toMatchObject({ title: 'Polaris', year: 1984 });
    expect(tidyItem(song('Nothing Was The Same (2013)', 'Drake', null, 'album'))).toMatchObject({ title: 'Nothing Was The Same', year: 2013 });
  });

  it('keeps the year the model already read, and brackets that are not a year (Live, feat.)', () => {
    expect(tidyItem(song('Heroes (1977)', 'David Bowie', 1978))).toMatchObject({ title: 'Heroes', year: 1978 });
    expect(tidyItem(song('Heroes (Live)', 'David Bowie'))).toMatchObject({ title: 'Heroes (Live)', year: null });
    expect(tidyItem(song('Get Lucky (feat. Pharrell Williams)', 'Daft Punk')).title).toBe('Get Lucky (feat. Pharrell Williams)');
  });

  it('keeps a bracket that says WHICH version it is, with or without a year: a version is a song of its own', () => {
    expect(tidyItem(song('Heroes (Remastered 2009)', 'David Bowie'))).toMatchObject({ title: 'Heroes (Remastered 2009)', year: null });
    expect(tidyItem(song('Heroes (Live 1985)', 'David Bowie'))).toMatchObject({ title: 'Heroes (Live 1985)', year: null });
    expect(tidyItem(song('Rock the Casbah (Remix 2012)', 'The Clash'))).toMatchObject({ title: 'Rock the Casbah (Remix 2012)', year: null });
    expect(tidyItem(song('Get Lucky (feat. Pharrell, 2013)', 'Daft Punk')).title).toBe('Get Lucky (feat. Pharrell, 2013)');
  });

  it('never leaves a title empty, never reads a year that is not between 1900 and 2099, and does not touch a title that merely starts with a year', () => {
    expect(tidyItem(song('(1968)', 'x')).title).toBe('(1968)');
    expect(tidyItem(song('Vol. 3 (1099)', 'x'))).toMatchObject({ title: 'Vol. 3 (1099)', year: null });
    expect(tidyItem(song('1999', 'Prince'))).toMatchObject({ title: '1999', year: null });
    expect(tidyItem(song('1999 (Prince)', null))).toMatchObject({ title: '1999 (Prince)', year: null });
  });

  it('leaves films, books and texts alone, and an item with no artist', () => {
    const film: SlideItem = { type: 'film', title: 'Taxi Driver (1976)', artist: '1. x', sourceSlide: 0 };
    expect(tidyItem(film)).toEqual(film);
    expect(tidyItem(song('Heroes', null)).artist).toBeNull();
  });

  it('is what a list written «N. ARTIST - TITLE (LABEL YEAR)» gives, line by line, through itemsOfSlide', () => {
    const items = itemsOfSlide([], '1. Charlie - Spacer Woman - Original Version (ZYX 1984)\n2. Koto - Visitors (Memory records 1985)', 3);
    expect(items.map((i) => [i.type, i.title, i.artist, i.year, i.sourceSlide])).toEqual([
      ['song', 'Spacer Woman - Original Version', 'Charlie', 1984, 3],
      ['song', 'Visitors', 'Koto', 1985, 3],
    ]);
  });

  it('tidies the items of the MODEL too, on a slide with no dashed line (the year after the title, the rank before the artist)', () => {
    const [item] = itemsOfSlide([{ type: 'album', title: 'Nothing Was The Same (2013)', artist: '1. Drake', director: null, year: null, notes: null, sourceSlide: 4 }], 'Drake\nNothing Was The Same (2013)', 4);
    expect(item).toMatchObject({ type: 'album', title: 'Nothing Was The Same', artist: 'Drake', year: 2013, sourceSlide: 4 });
  });

  it('and the same song written with and without the year on two slides is ONE item (the tidy comes before the key)', () => {
    const [a] = itemsOfSlide([], '1. Charlie - Spacer Woman (ZYX 1984)', 0);
    const [b] = itemsOfSlide([], 'Charlie - Spacer Woman', 1);
    expect(slideItemKey(a)).toBe(slideItemKey(b));
  });
});
