/**
 * What one slide of a carousel names (songs, albums, films, books): the question to the local model, the one shape of the answer, and the reading of it.
 *
 * The bug this replaces (10 November 2026, two links of Michele: «5 modern jazz songs» with 6 slides and «album da ascoltare» with 15, ten albums): the prompt asked
 * for a JSON ARRAY while the call was in JSON mode, and the model answered with ONE OBJECT per slide (`{"type":"album","title":"Mystic Stylez - Three 6 Mafia"}`,
 * or `{"type":["album"],"title":"…","artist":[],"director":[{…}]}`). The code looked for `[...]` in the text, found none, and dropped the slide in silence:
 * `carousel_extraction: itemsFound 0` on a post that lists ten albums, written in the journal as «nothing to find».
 *
 * Now the reading accepts every shape the model has really answered (a list, `{items:[…]}`, ONE object, lists where text belongs), so that a slide whose answer has the
 * items in it never gives none. A JSON SCHEMA was tried and dropped: under a grammar this local model (glm-4.7-flash, q4) writes empty titles and runs of tabs, and a
 * prompt that asks for an `{items:[…]}` wrapper gets an empty list; the ORIGINAL prompt (a flat object per item) is the one it answers well.
 *
 * What it still gets wrong it gets wrong the same way (the TITLE and no artist; both in the title; a comment taken for a song; «JAZZ RECS», a header, for an album),
 * and the OCR text of the slide has the answer: `refineSlideItems` takes the artist from the line before the title and drops what is a comment, and `dashedPairs`
 * reads the «ARTIST - TITLE» lines of a list of songs, which are explicit and beat the model.
 */
import type { ActionLogItem, EntrySlide } from '../types';

export type SlideItemType = 'song' | 'film' | 'book' | 'album' | 'text';

export interface SlideItem {
  type: SlideItemType;
  title: string;
  artist?: string | null;
  director?: string | null;
  year?: number | null;
  notes?: string | null;
  sourceSlide: number;
}

/** The ceiling of the answer for ONE slide: a few items, never a page. */
export const SLIDE_MAX_TOKENS = 700;
const MAX_TITLE = 200;
const MAX_NOTES = 300;

export function buildSlidePrompt(slideIndex: number, total: number, ocrText: string): string {
  return `Questa è la slide ${slideIndex + 1} di ${total} di un carosello Instagram.

Testo OCR estratto:
${ocrText}

Estrai tutti gli oggetti culturali menzionati in formato JSON array.
Per ogni oggetto usa questo schema:
{"type":"song"|"film"|"book"|"album"|"text","title":"...","artist":null,"director":null,"year":null,"notes":null}
Usa null per campi sconosciuti. Se non c'è nulla di estraibile, ritorna [].
Rispondi SOLO con il JSON array, senza testo aggiuntivo.`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// reading the answer
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const TYPE_WORDS: Record<string, SlideItemType> = {
  song: 'song', track: 'song', canzone: 'song', brano: 'song', single: 'song',
  album: 'album', record: 'album', disco: 'album', disc: 'album', lp: 'album', ep: 'album', dischi: 'album',
  film: 'film', movie: 'film', serie: 'film', series: 'film', show: 'film',
  book: 'book', libro: 'book', romanzo: 'book', novel: 'book',
};

/** A text, or the first text of a list; anything else is nothing. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') {
    const cleaned = value.replace(/\s+/g, ' ').trim();
    return cleaned === '' ? null : cleaned;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = textOf(v);
      if (t !== null) return t;
    }
  }
  return null;
}

/** A person or a group: one text, or a list of texts joined (`["Nubya Garcia","Richie Seivwright"]`). */
function peopleOf(value: unknown): string | null {
  if (Array.isArray(value)) {
    const names = value.map((v) => (typeof v === 'string' ? textOf(v) : null)).filter((v): v is string => v !== null);
    return names.length > 0 ? names.join(', ') : null;
  }
  return textOf(value);
}

function typeOf(value: unknown): SlideItemType {
  const word = textOf(value)?.toLowerCase();
  return (word && TYPE_WORDS[word]) || 'text';
}

function yearOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d{4}\s*$/.test(value) ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= 1000 && n <= 2100 ? n : null;
}

function titleOf(value: unknown): string | null {
  const raw = textOf(value);
  if (raw === null) return null;
  const title = raw.replace(/^[\s"'«»“”‘’]+|[\s"'«»“”‘’]+$/g, '').trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return null;
  return title.slice(0, MAX_TITLE);
}

/** The items the answer holds, whatever the shape it chose: a list, `{items:[…]}`, a list under another key, or ONE item as the whole answer. */
function candidates(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.items)) return o.items;
    if ('title' in o) return [o];
    for (const v of Object.values(o)) {
      if (Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object')) return v;
    }
  }
  return [];
}

function parseJson(raw: string): unknown {
  const text = raw.trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // a few words of text around the JSON: the widest object, then the widest list
    for (const re of [/\{[\s\S]*\}/, /\[[\s\S]*\]/]) {
      const match = text.match(re);
      if (!match) continue;
      try {
        return JSON.parse(match[0]);
      } catch {
        /* the next one */
      }
    }
    return null;
  }
}

/** The items of the answer to ONE slide, each cleaned and written the way the pipeline knows; never throws. */
export function parseSlideItems(raw: string, slideIndex: number): SlideItem[] {
  const out: SlideItem[] = [];
  for (const candidate of candidates(parseJson(raw))) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const o = candidate as Record<string, unknown>;
    const title = titleOf(o.title);
    if (title === null) continue;
    const notes = textOf(o.notes);
    out.push({
      type: typeOf(o.type),
      title,
      artist: peopleOf(o.artist),
      director: peopleOf(o.director),
      year: yearOf(o.year),
      notes: notes === null ? null : notes.slice(0, MAX_NOTES),
      sourceSlide: slideIndex,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the OCR text of the slide says what the model leaves out
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const ocrLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
const wordsOf = (v: string): string[] => v.split(/\s+/).filter(Boolean);
/** Without case, accents, punctuation and SPACES: «Taxidriver» is «Taxi Driver». */
const foldSolid = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const isUpper = (v: string): boolean => /\p{L}/u.test(v) && v === v.toUpperCase();
/** The symbols the OCR leaves around a name («Interpol ©»). */
const cleanName = (v: string): string => v.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[\s©®™*•|:;,"“”‘’']+$/u, '').trim();

/** A sentence, not a name: many words, a question or an exclamation, a lowercase phrase, or a full stop between two words. */
function looksLikeSentence(v: string): boolean {
  const words = wordsOf(v);
  return words.length > 8 || (/[?!]/.test(v) && words.length >= 3) || (/^\p{Ll}/u.test(v) && words.length >= 5) || /\p{Ll}{2,}\.\s+\S/u.test(v) || /\p{Ll}{2,},\s+\p{Ll}{2,}/u.test(v) || /\p{Ll}{2,}\.$/u.test(v);
}

/** Can this line be the artist of the title that follows it? A short name: not a sentence, not a handle or a hashtag, not empty. */
function plausibleArtist(line: string): boolean {
  const clean = cleanName(line);
  const words = wordsOf(clean);
  return clean.length >= 2 && clean.length <= 40 && words.length >= 1 && words.length <= 6 && /\p{L}/u.test(clean) && !/^[@#]/.test(line.trim()) && !/https?:|www\./i.test(clean) && !looksLikeSentence(clean);
}

/** The artist written on the line before the title, when the line is a name. */
function artistBefore(title: string, lines: readonly string[]): string | null {
  const wanted = foldSolid(title);
  if (wanted.length < 2) return null;
  for (let i = 1; i < lines.length; i++) {
    const here = foldSolid(lines[i]);
    // the line IS the title, or the title is inside a longer line («Nothing Was The Same (2013)»); never the line inside a longer title: that is half of «A - B»
    const same = here === wanted || (wanted.length >= 6 && here.includes(wanted));
    if (same && plausibleArtist(lines[i - 1]) && foldSolid(lines[i - 1]) !== wanted) return cleanName(lines[i - 1]);
  }
  return null;
}

/** «Title - Artist» or «Artist - Title» in ONE title, told apart by which of the two is written on the line before the other. */
function splitCombined(title: string, lines: readonly string[]): { title: string; artist: string } | null {
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!m) return null;
  const [a, b] = [m[1].trim(), m[2].trim()];
  for (let i = 0; i + 1 < lines.length; i++) {
    const [l1, l2] = [foldSolid(lines[i]), foldSolid(lines[i + 1])];
    if (l1 === foldSolid(a) && l2 === foldSolid(b)) return { artist: cleanName(a), title: cleanName(b) };
    if (l1 === foldSolid(b) && l2 === foldSolid(a)) return { artist: cleanName(b), title: cleanName(a) };
  }
  return null;
}

/**
 * What the model got from the slide, mended with the OCR text of the same slide: a song or an album that is a COMMENT («se vuoi anche che la città sprofondi…»), or its
 * own artist, or one letter, is dropped; one with no artist gets the artist written on the line before its title (or the two held in one title are told apart);
 * and when no line is a name the artist stays empty (no guess is better than a wrong artist: the search of the song would look for the wrong one).
 */
export function refineSlideItems(items: readonly SlideItem[], ocrText: string): SlideItem[] {
  const lines = ocrLines(ocrText);
  const out: SlideItem[] = [];
  for (const item of items) {
    if (item.type !== 'song' && item.type !== 'album') {
      out.push(item);
      continue;
    }
    if (foldSolid(item.title).length < 2 || looksLikeSentence(item.title)) continue;
    if (item.artist && foldSolid(item.artist) === foldSolid(item.title)) continue;
    if (item.artist) {
      out.push(item);
      continue;
    }
    const split = splitCombined(item.title, lines);
    if (split) {
      out.push({ ...item, title: split.title, artist: split.artist });
      continue;
    }
    out.push({ ...item, artist: artistBefore(item.title, lines) });
  }
  return out;
}

const WRAP_STOP = /^(out now|new|ep|lp|single|album|release|nuovo|nuova|disponibile|ascolta|listen|stream)\b/i;

/**
 * The «ARTIST - TITLE» lines of a slide (a list of songs written the way people write one): explicit, so they beat the model. A title that wraps on the next line
 * («GOLDEN» / «BROWN») is joined when the next line is short, in the same case and no tag; a sentence with a dash, a hashtag, a handle, a link or a name too long is not a pair.
 */
export function dashedPairs(ocrText: string): Array<{ artist: string; title: string }> {
  const lines = ocrLines(ocrText);
  const pairs: Array<{ artist: string; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.{2,60}?)\s+[-–—]\s+(.{1,60})$/);
    if (!m || /[@#]|https?:|www\./i.test(lines[i]) || /[?!]/.test(lines[i])) continue;
    const artist = cleanName(m[1]);
    let title = cleanName(m[2]);
    if (!/\p{L}/u.test(artist) || !/\p{L}/u.test(title) || wordsOf(artist).length > 6 || looksLikeSentence(artist)) continue;
    const next = lines[i + 1];
    if (
      next !== undefined && wordsOf(title).length <= 2 && wordsOf(next).length <= 3 && !WRAP_STOP.test(next) && !/\s[-–—]\s/.test(next) &&
      !looksLikeSentence(next) && isUpper(title) === isUpper(next)
    ) {
      title = `${title} ${cleanName(next)}`;
      i += 1;
    }
    if (wordsOf(title).length > 8) continue;
    pairs.push({ artist, title });
  }
  return withoutRankRuns(pairs);
}

/** The number at the start of an artist, with the dot or the bracket of a rank or without: «1.», «12)», «#3:», «3 ». */
const LEADING_NUMBER = /^#?(\d{1,3})\s*[.):]?\s*(?=\p{L})/u;

/**
 * The rank of a list the OCR wrote without its dot («3 Chip E.», «4 J.M. Silk» after «1. Jesse Saunders», «2. Chip E.»): a number in front of the artist is a RANK when the number of the
 * next line or of the line before differs by one, up («1, 2, 3») or down (a countdown, «10, 9, 8»). A name with a number in it («50 Cent», «2 Chainz») has no such neighbour; a single
 * line is never stripped here (it could be a name).
 */
function withoutRankRuns(pairs: Array<{ artist: string; title: string }>): Array<{ artist: string; title: string }> {
  const ranks = pairs.map((p) => { const m = p.artist.match(LEADING_NUMBER); return m ? Number(m[1]) : null; });
  const next = (a: number | null | undefined, b: number): boolean => a !== null && a !== undefined && Math.abs(a - b) === 1;
  return pairs.map((p, i) => {
    const rank = ranks[i];
    const inRun = rank !== null && (next(ranks[i + 1], rank) || next(ranks[i - 1], rank));
    return inRun ? { ...p, artist: p.artist.replace(LEADING_NUMBER, '').trim() } : p;
  });
}

/** The same song or album written on two slides (in big letters and in small ones) is one item: title and artist without case, accents or punctuation. */
export function slideItemKey(item: SlideItem): string {
  const fold = (v: string | null | undefined): string => (v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `${fold(item.title)}|${fold(item.artist)}`;
}

/** What ONE slide gives: the model's items mended by the OCR text, and the «ARTIST - TITLE» lines, which are explicit: the songs and albums of the model are kept only if they ARE one of those titles. */
export function itemsOfSlide(modelItems: readonly SlideItem[], ocrText: string, slideIndex: number): SlideItem[] {
  const refined = refineSlideItems(modelItems, ocrText);
  const pairs = dashedPairs(ocrText);
  if (pairs.length === 0) return refined.map(tidyItem);
  const titles = new Set(pairs.map((p) => foldSolid(p.title)));
  const kept = refined
    .filter((i) => (i.type !== 'song' && i.type !== 'album') || titles.has(foldSolid(i.title)))
    .map((i) => ((i.type === 'song' || i.type === 'album') && !i.artist ? { ...i, artist: pairs.find((p) => foldSolid(p.title) === foldSolid(i.title))?.artist ?? null } : i));
  const pairItems: SlideItem[] = pairs
    .filter((p) => !kept.some((i) => foldSolid(i.title) === foldSolid(p.title)))
    .map((p) => ({ type: 'song', title: p.title, artist: p.artist, director: null, year: null, notes: null, sourceSlide: slideIndex }));
  return [...kept, ...pairItems].map(tidyItem);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the rank and the year are not part of the names
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** «1. », «12) », «#3: », «1.Wendy»: the rank of a list. A bare number is a name too («50 Cent», «2 Chainz»): without the dot or the bracket it stays. */
const RANK_PREFIX = /^#?\d{1,3}\s*[.):]\s*(?=\p{L})/u;
/** A bracket at the end of the title that holds a year («(1968)», «(ZYX 1984)», «(1984, Jes Say Records)»), even when the OCR left one bracket open («( (Memory records 1984)»). */
const YEAR_BRACKET = /\s*\(+[^()]*?\b((?:19|20)\d{2})\b[^()]*\)?\s*$/;
/** A bracket that says WHICH version it is stays: a version is a song of its own («Heroes (Live 1985)», «(Remastered 2009)», «(feat. X)»). */
const VERSION_WORD = /\b(live|remix(?:ed)?|remaster(?:ed)?|version|demo|acoustic|edit|mix|instrumental|cover|reprise|session|dub|extended|radio|feat\.?|ft\.?|featuring)\b/i;

/**
 * A song or an album as the pipeline wants it: the rank of the list off the artist («1. Charlie» is «Charlie»), and the year written in brackets after the title («Switched-On
 * Bach (1968)», «Spacer Woman (ZYX 1984)») in `year`, where a year already read is kept. Lists of «100 essential tracks» are written «N. ARTIST - TITLE (LABEL YEAR)», and a search for
 * the title with the label and the year in it finds nothing. A title that would be left empty is not touched; films, books and texts are not songs and are not touched.
 */
export function tidyItem(item: SlideItem): SlideItem {
  if (!isMusicItem(item)) return item;
  let { title, artist, year } = item;
  if (artist) {
    const withoutRank = artist.replace(RANK_PREFIX, '').trim();
    if (withoutRank !== '') artist = withoutRank;
  }
  const bracket = title.match(YEAR_BRACKET);
  if (bracket && !VERSION_WORD.test(bracket[0])) {
    const rest = title.slice(0, bracket.index).replace(/[\s(]+$/, '');
    if (foldSolid(rest).length >= 2) {
      title = rest;
      year = year ?? Number(bracket[1]);
    }
  }
  return title === item.title && artist === item.artist && year === item.year ? item : { ...item, title, artist, year };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the carousel is about MUSIC, or its «songs» are not songs
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The answer is ONE boolean. Free JSON gave `{"false}:thinking_face:"…` and a different object each time; under this schema it is `{"music":true}` in a few tokens. */
export const MUSIC_GATE_SCHEMA = { type: 'object', properties: { music: { type: 'boolean' } }, required: ['music'] } as const;
export const MUSIC_GATE_MAX_TOKENS = 40;
const GATE_CAPTION_MAX = 500;
const GATE_SLIDE_MAX = 260;
const GATE_SLIDES_MAX = 2600;

/** A song or an album: what the pipeline turns into a song of the entry. A film, a book and a text are not. */
export const isMusicItem = (item: Pick<SlideItem, 'type'>): boolean => item.type === 'song' || item.type === 'album';

/**
 * ONE yes/no question for the whole carousel, asked when its slides gave «songs»: does it list or recommend music? The caption and the first words of every slide are the
 * evidence. Every «ARTIST - TITLE» line of the OCR becomes a song (`dashedPairs`), and a business roadmap («Phase 1 - Stabilize»), a Flutter stack or a list of horror films
 * have such lines too: on 403 old carousels 164 gave songs and about nine in ten were not music.
 */
export function buildMusicGatePrompt(caption: string | null | undefined, slides: ReadonlyArray<{ slideIndex: number; text: string }>): string {
  const text = slides.map((s) => `Slide ${s.slideIndex + 1}: ${s.text.replace(/\s+/g, ' ').trim().slice(0, GATE_SLIDE_MAX)}`).join('\n').slice(0, GATE_SLIDES_MAX);
  const description = (caption ?? '').replace(/\s+/g, ' ').trim().slice(0, GATE_CAPTION_MAX) || '(nessuna)';
  return `Questo è un carosello Instagram: la didascalia del post e il testo delle sue slide.

Didascalia:
${description}

${text}

Domanda: questo carosello elenca o consiglia MUSICA da ascoltare (canzoni, album, dischi, artisti musicali)?
Film, serie, libri, software, intelligenza artificiale, finanza, salute, consigli di vita e ogni altro argomento NON sono musica, anche se il testo ha elenchi con trattini o numeri.
Rispondi SOLO con un oggetto JSON: {"music": true} oppure {"music": false}.`;
}

/** The verdict of the model: `true`, `false`, or `null` when the answer is not the boolean (a string, another key, no object): no answer is not a «yes». */
export function parseMusicVerdict(raw: string): boolean | null {
  const parsed = parseJson(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const verdict = (parsed as Record<string, unknown>).music;
    if (typeof verdict === 'boolean') return verdict;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// a second pass
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The OCR text of the slides an entry ALREADY carries, with their own indexes: what a second pass reads again, with no download and no OCR. */
export function storedSlideOcrTexts(slides: readonly EntrySlide[] | null | undefined): Array<{ slideIndex: number; text: string }> {
  return (slides ?? [])
    .filter((s) => typeof s.ocrText === 'string' && s.ocrText.trim() !== '')
    .map((s) => ({ slideIndex: s.index, text: s.ocrText as string }));
}

/** What the LAST pass found in the slides (`carousel_extraction.itemsFound`): zero when it never ran or its count is no number. */
export function carouselItemsFoundBefore(actionLog: readonly ActionLogItem[] | null | undefined): number {
  let found = 0;
  for (const line of actionLog ?? []) {
    if (line.action !== 'carousel_extraction') continue;
    const n = line.details?.itemsFound;
    found = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  }
  return found;
}
