/**
 * The place an entry is about and the venues it names (collections, spec 2026-11-09-library-collections-auto-topics-design.md §4.3 and §4.6,
 * ADR-0022).
 *
 * Michele (9 November): «il luogo venga identificato dal testo», and a post that says «ecco i ristoranti nuovi da provare su Milano» must give
 * the place (Milano) AND a section with the names of the restaurants, each with a link to Google Maps. One small dedicated call of the local
 * model reads both (own JSON schema, two examples, ~1 s), in the queue after the analysis and never inside it: a failure here only means no
 * place and no venues for now.
 *
 * Nothing the model says is trusted. The place must be in the list of `data/places.ts` AND must be written in the text of the entry (so
 * «Montagne de Reims» does not come out of a post about wine that never names it, and «Roma» is not found in «aromi»); a venue name must be
 * written in the text, must not be generic («il locale», «ristorante»), is cleaned, kept once (the same name in the same city is one venue)
 * and at most 20 per entry. And since 10 November a venue must also be PROVED by the text (the section «the evidence» below): the model proposes
 * every named thing in a post («Claude Code», «Cursor», «Pink Floyd» were «venues»), the code decides. No coordinates anywhere: the link starts from
 * the name and the city and is built here, by the server (rule P: no client builds it); it is only an address to open, no key and no call to Google.
 * `PLACES_RULES_VERSION` is part of what an entry is recorded with: a change of these rules reads every entry again.
 */
import { PLACES, type Place, type PlaceKind } from '../data/places';
import { generateText, type OllamaResponse } from './ollamaClient';
import { logWarning } from '../utils/logger';

export type { Place, PlaceKind };

// ---------- folding ----------

const stripMarks = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Lower case, no accents, letters and digits only, words separated by one space: «Caffè  della Stazione!» → «caffe della stazione». */
export function foldWords(s: string): string {
  return stripMarks(s).replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------- the list of places, indexed once ----------

interface Form {
  words: string[];
  compact: string;
  /** Written all in capitals in the list («USA», «UK»): it counts only in capitals in a text («usa» is a verb). */
  acronym: boolean;
}

const FORMS_OF = new Map<Place, Form[]>();
const BY_FOLDED = new Map<string, Place>();
const BY_COMPACT = new Map<string, Place>();
const PREFIX_FORMS: Array<{ compact: string; place: Place }> = [];

for (const place of PLACES) {
  const forms: Form[] = [];
  for (const written of [place.name, ...place.aliases]) {
    const folded = foldWords(written);
    if (!folded) continue;
    const compact = folded.replace(/ /g, '');
    forms.push({ words: folded.split(' '), compact, acronym: /^[A-Z]{2,5}$/.test(written) });
    BY_FOLDED.set(folded, place);
    BY_COMPACT.set(compact, place);
    PREFIX_FORMS.push({ compact, place });
  }
  FORMS_OF.set(place, forms);
}
// the longest first: «#romagna» belongs to Romagna, not to Roma
PREFIX_FORMS.sort((a, b) => b.compact.length - a.compact.length);

/** The place a hashtag names, also when something is glued after it: «#romafood» is Roma (a name of fewer than 4 letters must be the whole hashtag). */
function hashtagOwner(folded: string): Place | null {
  const exact = BY_COMPACT.get(folded);
  if (exact) return exact;
  for (const form of PREFIX_FORMS) {
    if (form.compact.length < 4) break;
    if (folded.startsWith(form.compact)) return form.place;
  }
  return null;
}

/** What the model wrote → a place of the list: without `#`, quotes, a note in brackets, a country after a comma. Anything else is no place. */
function candidatesOf(raw: string): string[] {
  const s = raw.replace(/^[\s#@"'“”‘’«»]+|[\s"'“”‘’«»]+$/g, '');
  if (!s) return [];
  const noNote = s.replace(/\s*\([^)]*\)\s*$/, '');
  const noPrefix = noNote.replace(/^(?:provincia|citt[aà]|comune|regione|city|province)\s+(?:di|del|della|dell'|of)\s*/i, '');
  const head = noPrefix.split(/\s*[,;/]\s*|\s+[-–—]\s+/)[0];
  return [...new Set([s, noNote, noPrefix, head])].filter(Boolean);
}

export function findPlace(raw: unknown): Place | null {
  if (typeof raw !== 'string') return null;
  for (const candidate of candidatesOf(raw)) {
    const place = BY_FOLDED.get(foldWords(candidate));
    if (place) return place;
  }
  return null;
}

// ---------- the text, indexed once ----------

interface Tok {
  folded: string;
  /** Written with a `#` right before it. */
  hash: boolean;
  /** Begins with a capital letter. */
  cap: boolean;
  /** All capitals. */
  upper: boolean;
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/(#?)([\p{L}\p{N}]+)/gu)) {
    const raw = m[2];
    const folded = stripMarks(raw).replace(/[^a-z0-9]/g, '');
    if (!folded) continue;
    out.push({ folded, hash: m[1] === '#', cap: raw[0] !== raw[0].toLowerCase(), upper: raw === raw.toUpperCase() && raw !== raw.toLowerCase() });
  }
  return out;
}

interface TextIndex {
  tokens: Tok[];
  /** The text folded, with a space at each end: a name is a whole word sequence when « name » is in it. */
  spaced: string;
  /** The text folded, without spaces: a long name glued in a hashtag is in it. */
  compact: string;
  /** The text as it was written (the evidence of a venue is looked for in it). */
  text: string;
  /** The words and the marks that are evidence of a venue, found the first time a venue needs them. */
  cues?: Cues;
}

function indexText(text: string): TextIndex {
  const folded = foldWords(text);
  return { tokens: tokenize(text), spaced: ` ${folded} `, compact: folded.replace(/ /g, ''), text };
}

/** Is the place written in the text (its name, or one of its other written forms)? */
function placeInTokens(place: Place, toks: Tok[]): boolean {
  for (const form of FORMS_OF.get(place) ?? []) {
    const n = form.words.length;
    for (let i = 0; i + n <= toks.length; i++) {
      let same = true;
      for (let k = 0; k < n; k++) {
        if (toks[i + k].folded !== form.words[k]) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      const first = toks[i];
      if (form.acronym) {
        if (toks.slice(i, i + n).every((t) => t.upper)) return true;
        continue;
      }
      if (place.ambiguous && !first.cap) continue;
      return true;
    }
  }
  return toks.some((t) => t.hash && hashtagOwner(t.folded) === place);
}

function groundedPlace(raw: unknown, index: TextIndex): Place | null {
  const place = findPlace(raw);
  return place && placeInTokens(place, index.tokens) ? place : null;
}

/**
 * The place the model named, as the list writes it («Milan» → «Milano»), only when it is in the list AND written in the text.
 * Anything else — a place outside the list, a place the text does not contain, something that is not a text — is `null`.
 */
export function canonicalPlace(raw: unknown, text: string): string | null {
  const place = findPlace(raw);
  if (!place) return null;
  return placeInTokens(place, tokenize(text)) ? place.name : null;
}

function groundedIn(name: string, index: TextIndex): boolean {
  const words = foldWords(name.replace(/\s*\([^)]*\)\s*$/, ''));
  if (!words) return false;
  if (index.spaced.includes(` ${words} `)) return true;
  const compact = words.replace(/ /g, '');
  // glued in a hashtag («#trattoriadeinavigli»): only a long name, or a short one would be found by chance
  return compact.length >= 6 && index.compact.includes(compact);
}

/**
 * Is this name really in the text? Compared without case, accents, punctuation and spaces; a name of fewer than four letters must be a whole
 * word (a bit stricter than the one of the software names for four and five letters: «Luna» is not in «lunatico»). A trailing «(…)» the
 * model adds to explain is not part of the name.
 */
export function isGrounded(name: string, text: string): boolean {
  return groundedIn(name, indexText(text));
}

// ---------- venues ----------

export const MAX_VENUES = 20;

export const VENUE_KINDS = ['restaurant', 'pizzeria', 'bar', 'cafe', 'hotel', 'refuge', 'winery', 'shop', 'other'] as const;
export type VenueKind = (typeof VENUE_KINDS)[number];

/** Articles, prepositions and the like: they never make a name. */
const STOPWORDS = new Set(
  ('il lo la l i gli le un uno una di del dello della dei degli delle dell d da dal dallo dalla dai dalle dall in nel nello nella nei negli nelle nell ' +
    'su sul sullo sulla sui sulle sull al allo alla ai agli alle all a e ed o con per tra fra questo questa quel quello quella the of and an').split(' '),
);

/** A kind of venue, or an adjective that says nothing: a name made only of these («un ristorante», «ristorante nuovo», «il locale») is no name. */
const GENERIC_WORDS = new Set(
  ('ristorante ristoranti ristorantino trattoria trattorie osteria osterie pizzeria pizzerie pizza pizze bar pub birreria caffe cafe caffetteria ' +
    'locale locali localino posto posti posticino luogo luoghi hotel albergo alberghi rifugio rifugi cantina cantine negozio negozi shop store boutique ' +
    'libreria enoteca taverna locanda bistrot bistro agriturismo pasticceria gelateria panetteria panificio forno casa tavola paninoteca rosticceria ' +
    'macelleria salumeria gastronomia mercato market ristoro ' +
    'tavolo tavoli prenotazione prenotazioni cena cene pranzo pranzi colazione colazioni aperitivo aperitivi brunch menu piatto piatti cibo ' +
    'nuovo nuova nuovi nuove vecchio vecchia buono buona buoni buone ottimo ottima ottimi ottime migliore migliori famoso famosa famosi famose ' +
    'tipico tipica tipici tipiche bello bella belli belle piccolo piccola grande grandi tradizionale tradizionali storico storica storici storiche ' +
    'classico classica italiano italiana italiani italiane cinese cinesi giapponese giapponesi indiano indiana messicano messicana economico economica ' +
    'carino carina top best new old good great famous local typical traditional restaurant').split(' '),
);

function isGenericVenueName(name: string): boolean {
  const meaningful = foldWords(name)
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w));
  // the words that say what a venue is, in any form («HOTELS», «Pizzerie», «Club»), are no more a name than «ristorante»
  return meaningful.length === 0 || meaningful.every((w) => GENERIC_WORDS.has(w) || WORD_EVIDENCE.has(w));
}

/** What a name must not end with: quotes, markdown signs, a colon, a semicolon (a comma is cut by the judge, with everything after it). */
const NAME_TAIL = /[\s"'“”‘’«»`´*_;:]+$/;
/** A note in brackets at the end of a name: «Bar Basso (Milano)» (the space before it goes with the other spaces of the ends). */
const NAME_NOTE = /\([^)]*\)$/;

/** The ends of what the model wrote as a name: no spaces twice, no number of a list, no sign in front (a bullet, a pin, an emoji, a quote), no quote or colon behind. */
function tidyName(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim().replace(/^\d{1,2}[.)]\s+/, '');
  return s.replace(/^[^\p{L}\p{N}]+/u, '').replace(NAME_TAIL, '');
}

/** The identity of a venue (ADR-0017, one thing = one row): the cleaned name, a bar, the cleaned city. */
export function venueKey(name: string, place: string | null): string {
  return `${foldWords(name)}|${foldWords(place ?? '')}`;
}

const MAPS_SEARCH = 'https://www.google.com/maps/search/?api=1&query=';

/**
 * The address that opens a venue in Google Maps: the name and the city, encoded (the apostrophe and the ampersand of «Osteria dell'Orto & Co.»
 * too). Only the name when there is no city. No key, no call to Google, no coordinates: Maps finds the place from the name and the city.
 */
export function mapsUrl(name: string, place?: string | null): string {
  const n = name.replace(/\s+/g, ' ').trim();
  const p = typeof place === 'string' ? place.replace(/\s+/g, ' ').trim() : '';
  const query = p ? `${n}, ${p}` : n;
  // encodeURIComponent leaves ! ' ( ) * as they are: they would end up in the middle of an address
  return MAPS_SEARCH + encodeURIComponent(query).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// ---------- the evidence: the model proposes, the text decides ----------
//
// 10 November, dress rehearsal on a copy of the real entries: 73 posts gave 127 «venues» and nearly all were garbage (apps, brands, software, people,
// social accounts, text read off the screen: «Claude Code», «Cursor», «Pink Floyd», «kettlebellgrant», «Cos m ogonie»). The model calls every named
// thing a venue and its «kind» means nothing, so the code decides: a venue stays only when the text itself shows a place to go (spec §4.6: «meglio
// nessun locale che uno inventato»). Real venue posts are rare, so most posts must give none. A venue is kept when
//   1. its NAME says what it is with a strong or a common venue word («Trattoria dei Navigli», «Hotel Bellavista», «Bar Luce»): the kind of that word; or
//   2. TWO signs of a place are within `VENUE_EVIDENCE_WINDOW` characters of it: a strong venue word («ristorante», «hotel», «rifugio»…) and a mark of a
//      place (a pin 📍, a street with its number, a table to book, a menu to taste); a name with a weak venue word of its own («Club Tropicana») needs
//      only one of the two. The kind is the one of the venue word.
// In both cases the name is written in the text with a capital letter on a word that is not a venue word («tavolo al ristorante» is not a name).
// A venue word near a name is not enough alone, and neither is a mark: on the real library a brand, a film, a wine, a dish or a radio station next to
// the word «ristorante», «bakery» or a pin was the rule, not the exception. «other» is never kept, and the kind the model wrote is never used.

/** How far from the name (characters of the folded text, punctuation and accents not counted) a word or a mark still counts as evidence. */
export const VENUE_EVIDENCE_WINDOW = 120;

/**
 * The version of the rules and of the prompt: the hash of what an entry was read from includes it (`collectionsWiring`), so when the rules change
 * enough to read the posts again, this number goes up and every entry is read once more (2 = the evidence gate; 1 was the first reading).
 */
export const PLACES_RULES_VERSION = 2;

/** The kinds a venue that exists can have. «other» stays in `VENUE_KINDS` for the rows stored before: the model is not offered it and nothing keeps it. */
export type KnownVenueKind = Exclude<VenueKind, 'other'>;

/**
 * The words that say what a venue is, in the folded form of the text («caffè» is «caffe», «B&B» is «b b»), in three tiers:
 *   strong: a name that has one is a venue («Trattoria dei Navigli»), and it corroborates a name with only a weak one when it is written near it;
 *   common: a name that has one is a venue («Bar Luce», «Pub Murphy»), but written near a name it says nothing (too common: «il bar», «al pub»);
 *   weak:   a name that has one is a venue only when a strong word is written near it («Club Tropicana» next to «locali», «Coach Store» next to nothing).
 * «pizza» and «caffè» as a dish and a drink are not here.
 */
const VENUE_WORDS: Record<KnownVenueKind, Record<WordTier, string[]>> = {
  restaurant: {
    strong: ['restaurant', 'restaurants', 'ristorante', 'ristoranti', 'ristorantino', 'trattoria', 'trattorie', 'osteria', 'osterie', 'locanda', 'locande', 'bistrot', 'bistro', 'steakhouse', 'braceria', 'brasserie'],
    common: ['taverna', 'tavernetta'],
    weak: [],
  },
  pizzeria: {
    strong: ['pizzeria', 'pizzerie'],
    common: [],
    weak: [],
  },
  cafe: {
    strong: ['caffetteria', 'caffetterie', 'pasticceria', 'pasticcerie', 'gelateria', 'gelaterie', 'bakery', 'panificio', 'panifici'],
    common: [],
    weak: ['cafe', 'caffe', 'coffee', 'forno'],
  },
  bar: {
    strong: ['birreria', 'birrerie', 'enoteca', 'enoteche', 'vineria', 'vinerie'],
    common: ['bar', 'pub', 'discoteca'],
    weak: ['lounge', 'club'],
  },
  hotel: {
    strong: ['hotel', 'hotels', 'albergo', 'alberghi', 'b b', 'bnb', 'bed and breakfast', 'ostello', 'ostelli', 'hostel', 'hostels', 'agriturismo', 'agriturismi'],
    common: ['resort'],
    weak: ['residence', 'pensione'],
  },
  refuge: {
    strong: ['rifugio', 'rifugi', 'baita', 'baite', 'malga', 'malghe'],
    common: ['capanna', 'bivacco'],
    weak: [],
  },
  winery: {
    strong: ['winery', 'wineries', 'cantina', 'cantine'],
    common: ['vigneto', 'tenuta'],
    weak: [],
  },
  shop: {
    strong: ['boutique', 'bottega', 'botteghe', 'salumeria', 'salumerie', 'macelleria', 'macellerie', 'emporio', 'supermercato'],
    common: [],
    weak: ['negozio', 'negozi', 'libreria', 'librerie', 'shop', 'store', 'mercato', 'market', 'gastronomia'],
  },
};

type WordTier = 'strong' | 'common' | 'weak';

const WORD_EVIDENCE = new Map<string, { kind: KnownVenueKind; tier: WordTier }>();
for (const [kind, tiers] of Object.entries(VENUE_WORDS) as Array<[KnownVenueKind, Record<WordTier, string[]>]>) {
  for (const tier of Object.keys(tiers) as WordTier[]) for (const word of tiers[tier]) WORD_EVIDENCE.set(word, { kind, tier });
}

/** A venue word as a whole word of a folded text that has a space at each end (the spaces are looked at, not eaten: «bar pub» finds both). */
const VENUE_WORD = new RegExp(`(?<= )(${[...WORD_EVIDENCE.keys()].join('|')})(?= )`, 'g');

/** What the marks of a place become in the folded text: a word that no text has. */
const MARK = 'zzcuezz';
const MARK_WORD = new RegExp(`(?<= )${MARK}(?= )`, 'g');

/** The account of a social network: «@semidigrano», «@ba_restaurant». What is in it is neither a venue word nor the name of a venue. */
const HANDLE = /@[\p{L}\p{N}._]+/gu;
const PIN = /\u{1F4CD}/gu;
const STREET_WORD = '(?:[Vv]ia|[Vv]iale|[Pp]iazza|[Pp]iazzale|[Cc]orso|[Ll]argo|[Vv]icolo|[Ll]ungomare|VIA|VIALE|PIAZZA|PIAZZALE|CORSO|LARGO|VICOLO|LUNGOMARE)';
/** The small words of a street name: «Piazza del Duomo», «Via dell'Orto», «Via d'Azeglio», «Via Santa Maria in Trastevere». */
const STREET_CONNECTOR = "(?:di|del|dello|della|dei|degli|delle|dell['’]|dal|dalla|d['’]|de|in)";
/**
 * «Via Toledo 12», «Piazza del Duomo 3», «Corso Como, 10», «VIA XX SETTEMBRE 5»: a street word, a name of up to four words that begin with a capital letter
 * (small words between them), a house number of up to four digits (with «n.», «n°» or «n» in front, or a comma).
 */
const STREET_PATTERN =
  `(?<![\\p{L}\\p{N}])${STREET_WORD}\\s+` +
    `(?:${STREET_CONNECTOR}\\s*)?\\p{Lu}[\\p{L}'’.-]*` +
    `(?:\\s+(?:${STREET_CONNECTOR}\\s*)?\\p{Lu}[\\p{L}'’.-]*){0,3}` +
    `\\s*,?\\s*(?:n(?:\\.|°)?\\s*)?\\d{1,4}(?![\\p{L}\\p{N}])`;
const STREET = new RegExp(STREET_PATTERN, 'gu');
/** A name that is nothing but an address. */
const STREET_ONLY = new RegExp(`^${STREET_PATTERN}$`, 'u');
/** «prenota un tavolo», «prenotazione del tavolo»: a table to book (a demo or a call is not a table). */
const BOOKING = /prenot[\p{L}]*\s+(?:[\p{L}'’]+\s+){0,3}?tavol[oi]/giu;
/** «menù degustazione», «menu alla carta»…: a menu to taste (the menu of a program, «menù File», is not: «menù» alone says nothing). */
const MENU = /men[uù]\s+(?:degustazione|alla\s+carta|del\s+giorno|fisso|dello\s+chef)/giu;

/** The text with a mark of a place before and after each address, table and menu and in the place of each pin, and nothing left of the handles. */
function markCues(text: string): string {
  const around = (m: string): string => ` ${MARK} ${m} ${MARK} `;
  return text.replace(HANDLE, ' ').replace(PIN, ` ${MARK} `).replace(STREET, around).replace(BOOKING, around).replace(MENU, around);
}

interface Span {
  start: number;
  end: number;
}

interface Cues {
  /** The text folded and spaced, with the marks in it. Every position below is a position in this string. */
  cued: string;
  words: Array<Span & { kind: KnownVenueKind; tier: WordTier }>;
  marks: Span[];
}

function buildCues(text: string): Cues {
  const cued = ` ${foldWords(markCues(text))} `;
  const words = [...cued.matchAll(VENUE_WORD)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[1].length, ...(WORD_EVIDENCE.get(m[1]) as { kind: KnownVenueKind; tier: WordTier }) }));
  const marks = [...cued.matchAll(MARK_WORD)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + MARK.length }));
  return { cued, words, marks };
}

function cuesOf(index: TextIndex): Cues {
  return (index.cues ??= buildCues(index.text));
}

/** Where the words of the name are written in the folded text (each place is a whole run of words). */
function writtenAt(words: string, cued: string): Span[] {
  const needle = ` ${words} `;
  const found: Span[] = [];
  for (let at = cued.indexOf(needle); at !== -1; at = cued.indexOf(needle, at + 1)) found.push({ start: at + 1, end: at + 1 + words.length });
  return found;
}

/**
 * The characters between a cue and the nearest place the name is written (the cue is after the name or before it, never inside it: a name with a venue
 * word of its own never gets here); no place, no distance.
 */
function distanceTo(cue: Span, places: Span[]): number {
  let nearest = Infinity;
  for (const place of places) nearest = Math.min(nearest, Math.max(cue.start - place.end, place.start - cue.end));
  return nearest;
}

type EvidenceVia = 'name' | 'near';

interface Evidence {
  /** `name`: the name says it itself; `near`: the words and the marks written near the name say it. */
  via: EvidenceVia;
  kind: KnownVenueKind;
  /** How far from the name the evidence reached (the farthest of the signs it needed); null when the name says it itself. */
  distance: number | null;
}

/**
 * Is the name written somewhere in the text with a capital letter on a word that is not a venue word («Ristorante Monferrato», «ristorante Ba»: yes;
 * «tavolo al ristorante», «Shop suezzi»: no)? A dish, a thing, a word of the sentence is not a name.
 */
function writtenWithCapital(words: string[], tokens: Tok[]): boolean {
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((word, k) => tokens[i + k].folded === word) && words.some((word, k) => tokens[i + k].cap && !WORD_EVIDENCE.has(word))) return true;
  }
  return false;
}

/** Why a name is a venue (see the header of this section); null when there is nothing. */
function venueEvidence(name: string, index: TextIndex): Evidence | null {
  const folded = foldWords(name);
  const own = ` ${folded} `.matchAll(VENUE_WORD).next();
  const ownWord = own.done ? null : (WORD_EVIDENCE.get(own.value[1]) as { kind: KnownVenueKind; tier: WordTier });
  const named = writtenWithCapital(folded.split(' '), index.tokens);
  if (ownWord && ownWord.tier !== 'weak') {
    // «Bar 24», «Osteria 1950»: a number is as good as a capital letter next to the word that says what it is
    return named || /\d/.test(folded) ? { via: 'name', kind: ownWord.kind, distance: null } : null;
  }
  if (!named) return null;
  const cues = cuesOf(index);
  const places = writtenAt(folded, cues.cued);
  let word: { distance: number; kind: KnownVenueKind } | null = null;
  for (const cue of cues.words) {
    if (cue.tier !== 'strong') continue;
    const distance = distanceTo(cue, places);
    if (distance <= VENUE_EVIDENCE_WINDOW && (word === null || distance < word.distance)) word = { distance, kind: cue.kind };
  }
  const mark = Math.min(...cues.marks.map((m) => distanceTo(m, places)));
  const marked = mark <= VENUE_EVIDENCE_WINDOW;
  if (ownWord) {
    // a weak word in the name: one more sign is enough, the nearer of the two
    const distance = Math.min(word?.distance ?? Infinity, mark);
    return distance <= VENUE_EVIDENCE_WINDOW ? { via: 'near', kind: ownWord.kind, distance } : null;
  }
  return word && marked ? { via: 'near', kind: word.kind, distance: Math.max(word.distance, mark) } : null;
}

/** Names of platforms and of AI tools, and the words with which the model explains a name instead of giving it: no venue has them in its name. */
const NOT_VENUE_WORDS = new Set(
  ('citato citata citati citate menzionato menzionata mentioned marchio brand software piattaforma account profilo ' +
    'claude chatgpt gpt openai anthropic gemini copilot github gitlab instagram tiktok youtube facebook whatsapp telegram linkedin twitter').split(' '),
);
const NOT_VENUE_PHRASES = [' nel video ', ' nel post ', ' nel reel '];

/**
 * A name that cannot be the name of a venue whatever the text around it says (`@` and `#` are looked for before, in `judgeVenue`, on the name as the model
 * wrote it, because the cleaning takes the sign off): a symbol no name has, an ellipsis, an address on the web («Luce.it»,
 * «www…»), a sentence (more than six words, «citato nel video», «un ristorante ad Aspen»), the name of a platform or of an AI tool, a letter alone
 * between words, a quote that closes nothing, less than 70% letters (OCR). A number of up to four digits is a house number or a year, not junk.
 */
function isJunkName(name: string): boolean {
  if (/[+\/\\|=<>[\]{}«»_~^*…]|\.{2,}/u.test(name)) return true;
  if (/(?<![\p{L}\p{N}])(?:https?|www)(?![\p{L}\p{N}])/iu.test(name) || /[\p{L}\p{N}]{2,}\.\p{L}{2,}/u.test(name)) return true;
  // «un ristorante ad Aspen», «una pizzeria a Napoli», «un'osteria»: a description, not a name
  if (/^(?:(?:un|uno|una)\s|un['’])/iu.test(name)) return true;
  const tokens = name.split(' ');
  if (tokens.length > 6) return true;
  if (tokens.some((token) => /^\p{Ll}$/u.test(token) && !'aeioy'.includes(token))) return true;
  if (/['’‘](?=\s)/u.test(name)) return true;
  const significant = tokens.filter((token) => !/^\d{1,4}$/.test(token)).join('');
  const letters = significant.match(/\p{L}/gu)?.length ?? 0;
  if (letters / significant.length < 0.7) return true;
  const folded = ` ${foldWords(name)} `;
  return foldWords(name).split(' ').some((word) => NOT_VENUE_WORDS.has(word)) || NOT_VENUE_PHRASES.some((phrase) => folded.includes(phrase));
}

// ---------- the answer of the model ----------

export interface ParsedVenue {
  name: string;
  kind: string;
  /** The city of the venue: its own when the text names it, else the place of the post, else `null`. */
  place: string | null;
  key: string;
}

export interface ParsedPlacesAndVenues {
  place: { name: string; kind: string } | null;
  venues: ParsedVenue[];
}

/** Why a proposed venue was dropped. */
export type VenueDrop = 'shape' | 'name' | 'junk' | 'generic' | 'place' | 'not_in_text' | 'evidence';

interface Judged {
  name: string;
  venue: ParsedVenue | null;
  drop: VenueDrop | null;
  via: EvidenceVia | null;
  distance: number | null;
}

const dropped = (name: string, drop: VenueDrop): Judged => ({ name, venue: null, drop, via: null, distance: null });

/** ONE proposed venue against the text: kept (with its evidence and its kind) or dropped (with the reason). The only place where a venue is decided. */
function judgeVenue(item: unknown, index: TextIndex, postPlace: Place | null): Judged {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return dropped('', 'shape');
  const v = item as { name?: unknown; city?: unknown };
  if (typeof v.name !== 'string') return dropped('', 'shape');
  // a handle or a hashtag is not the name of a place, and the cleaning below would take the sign off and leave a plain word
  if (/[@#]/.test(v.name)) return dropped(v.name, 'junk');
  const full = tidyName(v.name);
  // «Via Sant'Ampellio 16», «Corso Como, 10»: the model took the address of a restaurant for the restaurant
  if (STREET_ONLY.test(full)) return dropped(full, 'junk');
  // «Cantina Isola, bottiglieria in via Paolo Sarpi…»: the name is what comes before the first comma, the rest is the model explaining; a note in brackets at
  // the end («Bar Basso (Milano)», «Bar Basso (Milano, Italia)», «Bar Basso (Milano), Roma») is not part of it: it goes before the cut and after it
  const name = tidyName(full.replace(NAME_NOTE, '').split(',')[0].replace(NAME_NOTE, ''));
  if (foldWords(name).replace(/ /g, '').length < 2) return dropped(name, 'name');
  if (isJunkName(name)) return dropped(name, 'junk');
  // no generic name, no city taken for a venue, nothing the text does not say
  if (isGenericVenueName(name)) return dropped(name, 'generic');
  if (findPlace(name)) return dropped(name, 'place');
  if (!groundedIn(name, index)) return dropped(name, 'not_in_text');
  const evidence = venueEvidence(name, index);
  if (!evidence) return dropped(name, 'evidence');
  const place = (groundedPlace(v.city, index) ?? postPlace)?.name ?? null;
  return { name, venue: { name, kind: evidence.kind, place, key: venueKey(name, place) }, drop: null, via: evidence.via, distance: evidence.distance };
}

/** The answer of the model, or null when it is no JSON. A number, a string or an array has neither «place» nor «venues»: it reads as an answer with nothing in it. */
function readAnswer(raw: string): { place?: unknown; venues?: unknown } | null {
  try {
    return JSON.parse(raw) as { place?: unknown; venues?: unknown } | null;
  } catch {
    return null;
  }
}

/**
 * The answer of the model, cleaned and checked against the text it was given. A JSON that does not parse, or has another shape, is «no place,
 * no venues»; a place that is not in the list or not in the text is dropped (the venues stay); a venue that is not in the text, is generic, is junk,
 * has no evidence in the text (see above) or has the key of one already kept is dropped; at most `MAX_VENUES` (the first that pass).
 */
export function parsePlacesAndVenues(raw: string, text: string): ParsedPlacesAndVenues {
  const answer = readAnswer(raw);
  if (!answer) return { place: null, venues: [] };
  const index = indexText(text);
  const postPlace = groundedPlace(answer.place, index);
  const venues: ParsedVenue[] = [];
  if (Array.isArray(answer.venues)) {
    const seen = new Set<string>();
    for (const item of answer.venues) {
      if (venues.length >= MAX_VENUES) break;
      const { venue } = judgeVenue(item, index, postPlace);
      if (!venue || seen.has(venue.key)) continue;
      seen.add(venue.key);
      venues.push(venue);
    }
  }
  return { place: postPlace ? { name: postPlace.name, kind: postPlace.kind } : null, venues };
}

/**
 * The venue words (strong and weak, in the folded form) and the number of marks of a place that a text has: what the gate has to work with. For choosing the
 * posts to look at on the real library with the very same words and marks the gate uses.
 */
export function venueCuesIn(text: string): { strong: string[]; common: string[]; weak: string[]; marks: number } {
  const cues = buildCues(text);
  const wordsOf = (tier: WordTier): string[] => cues.words.filter((word) => word.tier === tier).map((word) => cues.cued.slice(word.start, word.end));
  return { strong: wordsOf('strong'), common: wordsOf('common'), weak: wordsOf('weak'), marks: cues.marks.length };
}

export interface VenueVerdict {
  name: string;
  kept: boolean;
  /** Why it was dropped; null when kept. */
  reason: VenueDrop | null;
  /** What made it a venue: its name, or the words and marks near it; null when dropped. */
  evidence: EvidenceVia | null;
  /** How far from the name that word or mark was (characters); null when the name itself said it, or when dropped. */
  distance: number | null;
  kind: string | null;
}

/**
 * The same decisions as `parsePlacesAndVenues`, one line for each venue the model proposed (the duplicates and the cap of 20 are not decisions about a
 * venue and are not here): for the tests, and for looking at the gate on the real posts.
 */
export function explainPlacesAndVenues(raw: string, text: string): VenueVerdict[] {
  const answer = readAnswer(raw);
  if (!answer || !Array.isArray(answer.venues)) return [];
  const index = indexText(text);
  const postPlace = groundedPlace(answer.place, index);
  return answer.venues.map((item) => {
    const judged = judgeVenue(item, index, postPlace);
    return { name: judged.name, kept: judged.venue !== null, reason: judged.drop, evidence: judged.via, distance: judged.distance, kind: judged.venue?.kind ?? null };
  });
}

// ---------- the call ----------

export const PLACES_SCHEMA = {
  type: 'object',
  properties: {
    place: { type: ['string', 'null'] },
    venues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2 },
          kind: { type: 'string', enum: [...VENUE_KINDS.filter((kind) => kind !== 'other')] },
          city: { type: ['string', 'null'] },
        },
        required: ['name', 'kind'],
      },
    },
  },
  required: ['place', 'venues'],
} as const;

/** Up to 20 names of ~25 tokens each fit; a looping model is stopped long before the general ceiling. */
export const PLACES_MAX_TOKENS = 900;

export interface PlacesSource {
  caption: string | null;
  summary: string | null;
  tags: string[];
  notes: string[];
  transcript?: string | null;
  ocr?: string | null;
}

/** Tags that say nothing («#tag», «#hashtag», «@utente» and the platform ones): they are neither read nor searched for names. */
const PLACEHOLDER_TAGS = new Set(['tag', 'hashtag', 'x', 'utente', 'fyp', 'viral', 'perte', 'foryou', 'foryoupage', 'reels', 'instagram', 'explore', 'trending']);

function clipText(s: string | null | undefined, max: number): string {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

/**
 * The text the model reads AND every answer is checked against (one and the same): caption, summary, tags, notes, what is said in the video and
 * the text on the screen, each cut so that a very long transcript does not make a very long prompt. Empty when there is nothing.
 */
export function placesSourceText(source: PlacesSource): string {
  const tags = (source.tags ?? [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith('@') && !PLACEHOLDER_TAGS.has(t.replace(/^#/, '').toLowerCase()));
  const notes: string[] = [];
  let noteChars = 0;
  for (const note of source.notes ?? []) {
    const clipped = clipText(note, 300);
    if (!clipped || noteChars + clipped.length > 1000) continue;
    notes.push(clipped);
    noteChars += clipped.length;
  }
  return [
    clipText(source.caption, 1500),
    clipText(source.summary, 800),
    clipText(tags.join(' '), 400),
    ...notes,
    clipText(source.transcript, 2500),
    clipText(source.ocr, 1500),
  ]
    .filter(Boolean)
    .join('\n');
}

const RULES = `Da questo contenuto di un post social estrai due cose.

1. "place": il LUOGO di cui parla il post: una città, una regione o un paese che il testo NOMINA. Un solo luogo, il principale. Se il testo non ne nomina nessuno, null.
2. "venues": i LOCALI FISICI dove si può andare di persona a mangiare, bere, dormire o comprare, con il loro NOME PROPRIO: ristoranti, trattorie, pizzerie, bar, caffè, pasticcerie, gelaterie, hotel, rifugi, cantine, negozi. Per ognuno: "name" (il nome come compare nel testo), "kind" (restaurant, pizzeria, bar, cafe, hotel, refuge, winery oppure shop) e "city" (la città del locale solo se il testo la dice ed è diversa dal luogo del post, altrimenti null).

NON sono locali, e non vanno mai in "venues": app, software, strumenti di intelligenza artificiale, siti web, repository GitHub, marchi e prodotti, aziende, persone, account social (@nome o nome utente), artisti, gruppi musicali, libri, film, canzoni, album, università e istituzioni, il nome di una piattaforma (Instagram, YouTube, TikTok...).

Regole:
- Scrivi solo ciò che il testo dice. Non inventare: se un luogo o un nome non compare nel testo, non metterlo.
- Un locale è un posto dove si va di persona: se non puoi andarci a mangiare, bere, dormire o fare acquisti, non è un locale.
- La maggior parte dei post non nomina nessun locale: allora "venues" è [] (è la risposta giusta, non un errore).
- Niente nomi generici: "un ristorante", "il locale", "la pizzeria" non sono nomi propri.
- Se il post nomina un luogo ma nessun locale, "venues" è [].
- Al massimo 20 locali.
- Rispondi solo con un oggetto JSON.`;

const EXAMPLES = `Esempio 1
CONTENUTO:
ecco i ristoranti nuovi da provare su Milano: Trattoria Da Gigi, Osteria del Borgo e Caffè Luce
RISPOSTA:
{"place":"Milano","venues":[{"name":"Trattoria Da Gigi","kind":"restaurant","city":null},{"name":"Osteria del Borgo","kind":"restaurant","city":null},{"name":"Caffè Luce","kind":"cafe","city":null}]}

Esempio 2
CONTENUTO:
Il Barolo è il re dei vini del Piemonte: ecco perché costa tanto
RISPOSTA:
{"place":"Piemonte","venues":[]}

Esempio 3
CONTENUTO:
Claude Code ha cambiato il mio modo di programmare: ecco 5 repository GitHub da provare subito, con Cursor e Copilot a confronto. Link nei commenti.
RISPOSTA:
{"place":null,"venues":[]}

Esempio 4
CONTENUTO:
Tutti gli album dei Pink Floyd dal peggiore al migliore: The Wall, Animals, Meddle. Ascoltali su Spotify.
RISPOSTA:
{"place":null,"venues":[]}

Esempio 5
CONTENUTO:
Video di @kirtandopamine su X: la meditazione cambia il cervello. Segui @mindfulpage per altri consigli.
RISPOSTA:
{"place":null,"venues":[]}`;

export function buildPlacesPrompt(source: PlacesSource, text: string = placesSourceText(source)): string {
  return `${RULES}\n\n${EXAMPLES}\n\nCONTENUTO:\n${text}\nRISPOSTA:`;
}

export type PlacesGenerateFn = (
  prompt: string,
  images: never[],
  opts: { json: true; schema: Record<string, unknown>; maxTokens: number },
) => Promise<Pick<OllamaResponse, 'text' | 'usageMetadata' | 'truncated'>>;

/**
 * The dedicated call: ONE question to the local model (`glm-4.7-flash` through the existing client, `think: false` is set there), its own JSON
 * schema, a short ceiling; the answer is read by `parsePlacesAndVenues` against the same text. Never throws:
 * - `null`: there was nothing to read, or the call failed — the caller tries again later;
 * - `{ place: null, venues: [] }`: the model answered and the text names no place and no venue, or the answer was no good, or it was CUT at the ceiling
 *   (a long list of venues is what gets cut, about forty seconds each time): that is an answer, so the caller records it and does not ask again every night.
 */
export async function generatePlacesAndVenues(
  source: PlacesSource,
  deps: { generate?: PlacesGenerateFn } = {},
): Promise<ParsedPlacesAndVenues | null> {
  try {
    const text = placesSourceText(source);
    if (!text) return null;
    const generate = deps.generate ?? (generateText as unknown as PlacesGenerateFn);
    const response = await generate(buildPlacesPrompt(source, text), [], {
      json: true,
      schema: PLACES_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: PLACES_MAX_TOKENS,
    });
    if (response.truncated) {
      logWarning('luoghi e locali: risposta troncata, il testo conta come «niente trovato» (non si richiede finché il testo o le regole non cambiano)', { maxTokens: PLACES_MAX_TOKENS });
      return { place: null, venues: [] };
    }
    return parsePlacesAndVenues(response.text, text);
  } catch (err) {
    logWarning('luoghi e locali non riusciti (l\'analisi prosegue senza)', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
