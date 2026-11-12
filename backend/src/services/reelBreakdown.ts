/**
 * What a reel shows in Mondrop (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md §4, contract docs/mondrop-reels.md): the explanation of the post
 * (its summary) and what the post contained, by category — music, films, software, places, books, products, brands, people, events, quotes — and never the address
 * of the post. Michele, 12 November: «un tab con le altre categorie sul reel … ma non il link al reel ma la sua scomposizione e spiegazione».
 *
 * PURE: the rows come from the database already (`reelBreakdownData.ts`) and the tracks of the music from the library (`mondropReels.ts`); nothing here asks for
 * anything. What the analysis saved is JSONB, whose shape is a convention and not a guarantee (a local model wrote it), so every read is defensive: a damaged post is a
 * post with nothing in it, never an error, and the words of the model that are only its own placeholders (`#tag`, `@utente`, `...`) are never shown.
 *
 * Rule P (ADR-0018): no field of the words and things of a reel is an address — not the post's (`sourceUrl`), not a film's (`imdbUrl`, `posterUrl`), not a software's (`url`), and the
 * addresses written inside the words of the model are taken out of the words. The only paths are the ones of SoundReel itself (`imagePath`, the tracks). The tracks are the library's
 * ordinary tracks and keep their legacy `coverUrl` (a cover address of the music provider; found on the real server on 13 November, ADR-0033): the app never fetches it.
 *
 * One exception, asked for by Michele on 12 November («Q3 si apri sulla scheda», ADR-0033 amended): a FILM may carry `openUrl`, the page of the film on IMDb, for an «Apri» on its
 * sheet. It is never an address as the analysis or the post wrote it: `filmSheetUrl` builds it from the id of a title page of IMDb and gives nothing for anything else. A software
 * has none (the analysis almost never has one: 1 of the 1 370 on the real reels), and the post has none.
 */
import { isJunkSoftwareTitle, isPlaceholderValue } from './placeholderFilter';
import { songKey } from './songMeta';
import type { OfflineTrack } from './offlineManifest';

/** The categories, in the order they are shown everywhere. */
export const REEL_KINDS = ['music', 'film', 'software', 'place', 'book', 'product', 'brand', 'person', 'event', 'quote'] as const;
export type ReelKind = (typeof REEL_KINDS)[number];
type TextKind = Exclude<ReelKind, 'music'>;

export const REEL_KIND_LABEL: Readonly<Record<ReelKind, string>> = {
  music: 'Musica',
  film: 'Film',
  software: 'Software',
  place: 'Luoghi',
  book: 'Libri',
  product: 'Prodotti',
  brand: 'Marchi',
  person: 'Persone',
  event: 'Eventi',
  quote: 'Citazioni',
};

/** The categories of a note that are shown (they are also the kinds): `other` and everything that is not a category of things are not (spec M5). */
export const SHOWN_NOTE_CATEGORIES = ['place', 'book', 'product', 'brand', 'person', 'event', 'quote'] as const;
type NoteKind = (typeof SHOWN_NOTE_CATEGORIES)[number];

export const REEL_LIMITS = {
  /** The explanation of the post. */
  summary: 1500,
  /** A title (a name), in characters. */
  title: 140,
  /** The detail of a film or a software (its year and director, its kind and description), whole. */
  detail: 200,
  /** A quote may be longer than a name. */
  quote: 280,
  /** The names on the card of the list are shorter, to fit a line. */
  name: 60,
  /** How many names a card of the list shows for a category. */
  names: 3,
  /** Things in a category that is not music. */
  perSection: 20,
  /** Songs (and tracks) of a post. */
  tracks: 50,
  tags: 12,
  insights: 8,
  insightText: 600,
  slideSummary: 600,
} as const;

// ---------------------------------------------------------------------------
// What comes out
// ---------------------------------------------------------------------------

/** One post, as the database gives it: only the columns the builder reads, never the address of the post. */
export interface ReelRow {
  id: string;
  createdAt: Date | string;
  platform: string | null;
  /** `/media/<id>/thumbnail.jpg` when the picture is a file of the server, an address of someone else's CDN otherwise (never passed on). */
  thumbnailUrl: string | null;
  /** The `results` of the entry, or the part of them the query kept. */
  results: unknown;
}

export interface ReelCount {
  kind: ReelKind;
  label: string;
  count: number;
  /** The first three names (titles). */
  names: string[];
}

export interface ReelCard {
  id: string;
  createdAt: string;
  platform: string;
  summary: string | null;
  imagePath: string | null;
  counts: ReelCount[];
}

export interface ReelItem {
  title: string;
  detail: string | null;
  /** Only a film with a title page on IMDb: the address of that page, built by `filmSheetUrl`. Absent (no key) for everything else. */
  openUrl?: string;
}

/** A track as the library has it, without the legacy `mediaUrl` (always null since 2.13.0 and never read by the app). The legacy `coverUrl` stays, as in every list of songs: a cover address of the provider that the app never fetches (it asks SoundReel through `coverPath`). */
export type ReelTrack = Omit<OfflineTrack, 'mediaUrl'>;

export type ReelSection =
  | { kind: 'music'; title: string; tracks: ReelTrack[] }
  | { kind: TextKind; title: string; items: ReelItem[] };

export interface ReelInsight {
  label: string;
  text: string;
}

export interface ReelVerdict {
  label: string;
  explanation: string;
}

export interface ReelSlide {
  index: number;
  summary: string;
}

export interface ReelDetail {
  id: string;
  createdAt: string;
  platform: string;
  summary: string | null;
  imagePath: string | null;
  tags: string[];
  sections: ReelSection[];
  insights: ReelInsight[];
  verdict: ReelVerdict | null;
  slides: ReelSlide[];
}

/** A song of a post: its identity in the journal (the key of the words AS WRITTEN) and the words for the eye. */
export interface ReelSong {
  key: string;
  title: string;
  artist: string;
}

// ---------------------------------------------------------------------------
// Reading JSON that a model wrote
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const fieldOf = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

/** Characters, not UTF-16 units: a cut never splits an emoji. */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** An address written in the words of the model («vedi https://…», «www.…»): rule P takes it out of the words and leaves the words. */
const ADDRESS = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;

/** What the model copies from the example of its prompt when it has nothing to say: `#tag`, `@utente`, `#hashtag`. */
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set(['tag', 'utente', 'hashtag']);

/** The path fragments a model writes for a name it does not have: `/n`, `/repo`, `/name`. */
const PATH_FRAGMENT = /^[/\\][\p{L}\p{N}_-]{0,8}$/u;

const QUOTES: ReadonlyMap<string, string> = new Map([
  ["'", "'"], ['"', '"'], ['`', '`'], ['“', '”'], ['‘', '’'], ['«', '»'],
]);

/** The quotes a model puts around a name (`'AGENTI'`), however many. */
function unquote(text: string): string {
  let t = text;
  while (t.length >= 2 && QUOTES.get(t[0]) === t[t.length - 1]) t = t.slice(1, -1).trim();
  return t;
}

/** Words for the eye: addresses and the placeholders of the model out, one line, cut at `max`; null when nothing is left. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = squash(value.replace(ADDRESS, ' '));
  if (!text || isPlaceholderValue(text)) return null;
  if (!/[\p{L}\p{N}]/u.test(text)) return null;                          // only signs
  if (PLACEHOLDER_WORDS.has(text.replace(/^[#@]+/, '').toLowerCase())) return null;
  return cut(text, max);
}

/**
 * The signs a broken JSON or a Markdown leaves at the edges of a name: `> vLLM`, `}TypeScript`, `]}code`, `Zed {`, `* Ollama *`. They are taken off the edges and the name stays
 * (measured on the 1 665 reels of 12 November: 58 of the 1 368 software names had them). Not the dot, the at, the hash or the plus: `.NET`, `@angular/core` and `C++` are names.
 */
const LEADING_DEBRIS = /^[\s>}\])*|\\`]+/;
const TRAILING_DEBRIS = /[\s{\[(*|\\`<,;:]+$/;

/** What is left of a broken JSON in the middle of a name (braces, a backtick, a bold): not a name at all. */
const BROKEN_NAME = /[{}`]|\*\*/;

/** A name (a title): like `cleanText`, without the quotes and the debris around it, and never a path fragment or the pieces of a broken JSON. */
function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  let name = unquote(squash(value.replace(ADDRESS, ' ')));
  name = unquote(name.replace(LEADING_DEBRIS, '').replace(TRAILING_DEBRIS, '').trim());
  if (BROKEN_NAME.test(name) || PATH_FRAGMENT.test(name)) return null;
  return cleanText(name, max);
}

/** The same thing written two ways: without capitals, accents and punctuation. */
const identityOf = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---------------------------------------------------------------------------
// What a post contains
// ---------------------------------------------------------------------------

/** What a model writes as the text of a note when it only repeats the category (`event`, `persona`): not a thing. */
const CATEGORY_WORDS: ReadonlySet<string> = new Set([
  'place', 'book', 'product', 'brand', 'person', 'event', 'quote', 'other', 'note', 'notes', 'tag', 'tags',
  'luogo', 'luoghi', 'libro', 'libri', 'prodotto', 'prodotti', 'marchio', 'marchi', 'persona', 'persone', 'evento', 'eventi', 'citazione', 'citazioni', 'nota', 'note',
]);

/** Where a long note separates what it is about from what it says. */
const SEPARATORS = [' - ', ' – ', ' — ', ': '] as const;
/** A note longer than this is a sentence, not a name (a name with a dash in it stays whole). */
const SENTENCE_FROM = 80;

/**
 * A note the model wrote as a whole sentence («Timorasso Derthona, Vigneti Massa (Piemonte) - vitigno salvato dall'estinzione…», «CHALLENGE10 - sfida gratuita per…»; 650 of
 * the 5 000 notes of 12 November): when its first separator comes within the first 80 characters (and after the third) what comes before it is the name, and the rest the words.
 */
function splitSentence(text: string): { head: string; tail: string } | null {
  if ([...text].length <= SENTENCE_FROM) return null;
  let first: { at: number; length: number } | null = null;
  for (const separator of SEPARATORS) {
    const at = text.indexOf(separator);
    if (at !== -1 && (first === null || at < first.at)) first = { at, length: separator.length };
  }
  if (!first) return null;
  const headLength = [...text.slice(0, first.at)].length;
  if (headLength < 3 || headLength > SENTENCE_FROM) return null;
  return { head: text.slice(0, first.at), tail: text.slice(first.at + first.length) };
}

/**
 * The categories whose things the model mixes up (the same name as a software and as a product, as a brand and as a person): the same name is ONE thing there and the
 * first category of `REEL_KINDS` keeps it. A film is not a book and a quote is not a product: a film and a book that share a title are both shown.
 */
const MIXED_UP: ReadonlySet<ReelKind> = new Set<ReelKind>(['software', 'place', 'product', 'brand', 'person', 'event']);
const familyOf = (kind: TextKind): string => (MIXED_UP.has(kind) ? 'things' : kind);

const TEXT_KINDS: readonly TextKind[] = REEL_KINDS.filter((kind): kind is TextKind => kind !== 'music');
const NOTE_KINDS: ReadonlySet<string> = new Set<string>(SHOWN_NOTE_CATEGORIES);

const SOFTWARE_TAG: ReadonlyMap<string, string> = new Map([['repo', 'repo'], ['product', 'prodotto'], ['article', 'articolo']]);

/** A year, if the words hold one: the model writes «anno o null», «forse 1999» and «molto tempo fa» too. */
function yearOf(value: unknown): string | null {
  return typeof value === 'string' ? (/\b(?:1[89]|20)\d{2}\b/.exec(value)?.[0] ?? null) : null;
}

/**
 * A title page of IMDb: https or http, `imdb.com` with at most `www.` or `m.` before it, nothing between the host and `/title/` (so no credentials, no port, no longer host), and the id
 * (`tt` and 7 to 10 digits) closed by `/`, `?`, `#` or the end.
 */
const IMDB_TITLE = /^https?:\/\/(?:www\.|m\.)?imdb\.com\/title\/(tt\d{7,10})(?:[/?#]|$)/i;

/** The sheet of a film («Apri»): `https://www.imdb.com/title/<id>/` built from the id of a title page of IMDb; null for any other text or address, whatever it says. */
export function filmSheetUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = IMDB_TITLE.exec(value.trim())?.[1];
  return id ? `https://www.imdb.com/title/${id.toLowerCase()}/` : null;
}

/** The songs of a post, once each, by the key the journal gives them (`aggregateSongs` keys the words as written, so the key is made from them, not from the cleaned ones). */
export function reelSongs(results: unknown): ReelSong[] {
  const out: ReelSong[] = [];
  const seen = new Set<string>();
  for (const raw of listOf(fieldOf(results, 'songs'))) {
    if (!isObject(raw)) continue;
    const rawTitle = raw.title;
    if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) continue;
    const rawArtist = raw.artist;
    if (rawArtist !== undefined && rawArtist !== null && typeof rawArtist !== 'string') continue;   // not a song mention for the journal either
    const title = cleanName(rawTitle, REEL_LIMITS.title);
    if (!title) continue;
    const key = songKey(rawArtist ?? '', rawTitle);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, title, artist: cleanName(rawArtist ?? '', REEL_LIMITS.title) ?? '' });
    if (out.length >= REEL_LIMITS.tracks) break;
  }
  return out;
}

/** The things of every category but the music, in the order of the categories, each once, at most `perSection` of them. */
function textItems(results: unknown): Map<TextKind, ReelItem[]> {
  const items = new Map<TextKind, ReelItem[]>();
  const seen = new Set<string>();
  /** The items that were really added, by identity: a film named twice keeps the first place and takes the sheet of the second when it had none. */
  const added = new Map<string, ReelItem>();
  const add = (kind: TextKind, title: string, detail: string | null, openUrl: string | null = null): void => {
    const identity = identityOf(title);
    if (!identity) return;
    const id = `${familyOf(kind)}:${identity}`;
    if (seen.has(id)) {
      const kept = added.get(id);
      if (kept && openUrl && kept.openUrl === undefined) kept.openUrl = openUrl;
      return;
    }
    seen.add(id);
    const list = items.get(kind) ?? [];
    if (list.length >= REEL_LIMITS.perSection) return;
    const item: ReelItem = openUrl ? { title, detail, openUrl } : { title, detail };
    list.push(item);
    added.set(id, item);
    items.set(kind, list);
  };

  for (const film of listOf(fieldOf(results, 'films'))) {
    const title = cleanName(fieldOf(film, 'title'), REEL_LIMITS.title);
    if (!title) continue;
    const director = cleanText(fieldOf(film, 'director'), 80);
    const words = [yearOf(fieldOf(film, 'year')), director ? `regia di ${director}` : null].filter((part): part is string => part !== null).join(' · ');
    add('film', title, words ? cut(words, REEL_LIMITS.detail) : null, filmSheetUrl(fieldOf(film, 'imdbUrl')));
  }

  for (const software of listOf(fieldOf(results, 'software'))) {
    const raw = fieldOf(software, 'title');
    if (typeof raw !== 'string' || isJunkSoftwareTitle(raw)) continue;
    const title = cleanName(raw, REEL_LIMITS.title);
    if (!title || isJunkSoftwareTitle(title)) continue;
    const tag = fieldOf(software, 'tag');
    const words = [typeof tag === 'string' ? SOFTWARE_TAG.get(tag) ?? null : null, cleanText(fieldOf(software, 'description'), REEL_LIMITS.detail)]
      .filter((part): part is string => part !== null).join(' · ');
    add('software', title, words ? cut(words, REEL_LIMITS.detail) : null);
  }

  // the notes by category; their order inside a category is the one of the post, and the categories are visited in the order of the kinds
  const notes = new Map<NoteKind, unknown[]>();
  for (const note of listOf(fieldOf(results, 'notes'))) {
    if (!isObject(note)) continue;
    const category = typeof note.category === 'string' ? note.category.trim().toLowerCase() : '';
    if (!NOTE_KINDS.has(category)) continue;
    const kind = category as NoteKind;
    notes.set(kind, [...(notes.get(kind) ?? []), note.text]);
  }
  for (const kind of SHOWN_NOTE_CATEGORIES) {
    const max = kind === 'quote' ? REEL_LIMITS.quote : REEL_LIMITS.title;
    for (const text of notes.get(kind) ?? []) {
      const full = cleanName(text, 2000);                          // not cut yet: a sentence is split first
      if (!full) continue;
      let title: string | null = null;
      let detail: string | null = null;
      const split = splitSentence(full);
      if (split) {
        title = cleanName(split.head, max);
        if (title) detail = cleanText(split.tail, REEL_LIMITS.detail);
      }
      title ??= cleanName(full, max);
      if (title && !CATEGORY_WORDS.has(identityOf(title))) add(kind, title, detail);
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// The pieces of a post
// ---------------------------------------------------------------------------

const isoOf = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
};

const platformOf = (value: string | null): string => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'other');

/** The picture, only when it is a file of the server (`/media/…`): an address of someone else's CDN is never passed on, and the route serves only what is ours. */
const imagePathOf = (row: ReelRow): string | null => (typeof row.thumbnailUrl === 'string' && row.thumbnailUrl.startsWith('/media/') ? `/api/mondrop/reels/${row.id}/image` : null);

const summaryOf = (results: unknown): string | null => cleanText(fieldOf(results, 'summary'), REEL_LIMITS.summary);

/** The key words of the post: without the `#` or `@`, without the placeholders of the model, once each. */
function tagsOf(results: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of listOf(fieldOf(results, 'tags'))) {
    if (typeof raw !== 'string') continue;
    const tag = squash(raw.replace(ADDRESS, ' ')).replace(/^[#@]+/, '').trim();
    if (!tag || !/[\p{L}\p{N}]/u.test(tag) || PLACEHOLDER_WORDS.has(tag.toLowerCase())) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cut(tag, REEL_LIMITS.name));
    if (out.length >= REEL_LIMITS.tags) break;
  }
  return out;
}

/** The explanations the model wrote for what the post names («approfondimenti»): a label and its words, never the links. */
function insightsOf(results: unknown): ReelInsight[] {
  const out: ReelInsight[] = [];
  const seen = new Set<string>();
  for (const item of listOf(fieldOf(fieldOf(results, 'enrichments'), 'items'))) {
    const label = cleanText(fieldOf(item, 'label'), REEL_LIMITS.title);
    const text = cleanText(fieldOf(item, 'explanation'), REEL_LIMITS.insightText);
    if (!label || !text) continue;
    const key = identityOf(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, text });
    if (out.length >= REEL_LIMITS.insights) break;
  }
  return out;
}

function verdictOf(results: unknown): ReelVerdict | null {
  const verdict = fieldOf(fieldOf(results, 'enrichments'), 'verdict');
  const label = cleanText(fieldOf(verdict, 'label'), 40);
  if (!label) return null;
  return { label, explanation: cleanText(fieldOf(verdict, 'explanation'), REEL_LIMITS.insightText) ?? '' };
}

/** What the model wrote for each slide of a carousel: its number and its words, nothing of the picture or of the text read from it. */
function slidesOf(results: unknown): ReelSlide[] {
  const out: ReelSlide[] = [];
  listOf(fieldOf(results, 'slides')).forEach((slide, position) => {
    const summary = cleanText(fieldOf(slide, 'summary'), REEL_LIMITS.slideSummary);
    if (!summary) return;
    const index = fieldOf(slide, 'index');
    out.push({ index: typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : position, summary });
  });
  return out;
}

// ---------------------------------------------------------------------------
// The two answers
// ---------------------------------------------------------------------------

/** The card of the list: the explanation, and for each category how many things it holds and the first names. */
export function buildReelCard(row: ReelRow): ReelCard {
  const music = reelSongs(row.results);
  const items = textItems(row.results);
  const counts: ReelCount[] = [];
  const count = (kind: ReelKind, titles: string[]): void => {
    if (titles.length === 0) return;
    counts.push({ kind, label: REEL_KIND_LABEL[kind], count: titles.length, names: titles.slice(0, REEL_LIMITS.names).map((title) => cut(title, REEL_LIMITS.name)) });
  };
  count('music', music.map((song) => song.title));
  for (const kind of TEXT_KINDS) count(kind, (items.get(kind) ?? []).map((item) => item.title));
  return {
    id: row.id,
    createdAt: isoOf(row.createdAt),
    platform: platformOf(row.platform),
    summary: summaryOf(row.results),
    imagePath: imagePathOf(row),
    counts,
  };
}

const withoutMediaUrl = (track: OfflineTrack): ReelTrack => {
  const { mediaUrl, ...rest } = track;
  void mediaUrl;
  return rest;
};

/** The page of a reel: everything the card says and what the post holds, by category. `tracks` are the music of the post as the library builds them (null: not available). */
export function buildReelDetail(row: ReelRow, tracks: readonly OfflineTrack[] | null): ReelDetail {
  const items = textItems(row.results);
  const sections: ReelSection[] = [];
  if (tracks && tracks.length > 0) {
    sections.push({ kind: 'music', title: REEL_KIND_LABEL.music, tracks: tracks.slice(0, REEL_LIMITS.tracks).map(withoutMediaUrl) });
  }
  for (const kind of TEXT_KINDS) {
    const list = items.get(kind) ?? [];
    if (list.length > 0) sections.push({ kind, title: REEL_KIND_LABEL[kind], items: list });
  }
  return {
    id: row.id,
    createdAt: isoOf(row.createdAt),
    platform: platformOf(row.platform),
    summary: summaryOf(row.results),
    imagePath: imagePathOf(row),
    tags: tagsOf(row.results),
    sections,
    insights: insightsOf(row.results),
    verdict: verdictOf(row.results),
    slides: slidesOf(row.results),
  };
}
