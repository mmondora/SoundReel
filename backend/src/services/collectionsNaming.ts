/**
 * The names of the collections (ADR-0022, spec 2026-11-09-library-collections-auto-topics-design.md §3, §4.5, §5.5, §9).
 *
 * The trial of 9 November on the real library showed that the free names of the local model are dirty: symbols (`#Vini italiani`, `@Tecnologia`),
 * misspellings («Tinitus», «Alzhaimer»), a broken JSON as a name, a wrong parent (sustainable fashion under «Cibo e bevande»), the Milan restaurants
 * called «Colazioni e caffè» with no place, an invented name («Modafair»). A list of about 30 Italian names to CHOOSE from, a cleaning and an
 * evidence check fix almost all of it. So, in order (spec §5.5):
 *   (a) a name of the list: the model chooses, the code finds the exact name again (case, accents, `Intelligenza_artificiale`, `#ai`) and accepts it;
 *   (b) a new name, accepted only if it has 1–3 words, letters only, one of its words is in at least 30 % of the members and it is not «Post»,
 *       «Contenuti», «Varie»…, and not the name of one of the five virtual types;
 *   (c) otherwise the tag that at least 50 % of the members share (a name of the list when the tag is one);
 *   (d) otherwise NO name: the group is not published and is tried again the night after. Never a name the posts do not back.
 * A name changed by the user is never touched again (`mayBeNamed`).
 *
 * The model proposes, the code decides: the model call goes through `deps` (the local `glm-4.7-flash`, never Claude, nothing leaves the house) and
 * nothing here can throw. The heading under which a collection is shown comes from the TABLE of the list, never from the model (a wrong parent decides
 * nothing); a name that is not in the list goes under «Altre» (`group: null`, spec §4.4).
 */
import { generateText, type OllamaResponse } from './ollamaClient';

// ---------------------------------------------------------------------------
// The seed list (spec §4.5): ONE place in the code
// ---------------------------------------------------------------------------

/** The heading of the five virtual types: computed collections, never named by the model and never a heading of the page. */
export const VIRTUAL_TYPE_GROUP = 'Tipi (virtuali)';

export interface SeedCollection {
  name: string;
  group: string;
}

/** The table of spec §4.5, in order: the headings of the page of the collections and the clean names a group can take. */
export const SEED_COLLECTIONS: ReadonlyArray<SeedCollection> = [
  { group: VIRTUAL_TYPE_GROUP, name: 'Musica' },
  { group: VIRTUAL_TYPE_GROUP, name: 'Film e serie' },
  { group: VIRTUAL_TYPE_GROUP, name: 'Software e app' },
  { group: VIRTUAL_TYPE_GROUP, name: 'Luoghi' },
  { group: VIRTUAL_TYPE_GROUP, name: 'Libri' },
  { group: 'Cibo e bevande', name: 'Vino' },
  { group: 'Cibo e bevande', name: 'Ristoranti' },
  { group: 'Cibo e bevande', name: 'Ricette' },
  { group: 'Casa', name: 'Casa e design' },
  { group: 'Casa', name: 'Fai da te' },
  { group: 'Casa', name: 'Energia e domotica' },
  { group: 'Fuori casa', name: 'Viaggi' },
  { group: 'Fuori casa', name: 'Montagna e outdoor' },
  { group: 'Fuori casa', name: 'Animali e natura' },
  { group: 'Persone e salute', name: 'Salute' },
  { group: 'Persone e salute', name: 'Sport e fitness' },
  { group: 'Persone e salute', name: 'Mente e spiritualità' },
  { group: 'Persone e salute', name: 'Famiglia e genitori' },
  { group: 'Tecnologia', name: 'Intelligenza artificiale' },
  { group: 'Tecnologia', name: 'Sicurezza informatica' },
  { group: 'Tecnologia', name: 'Auto e moto' },
  { group: 'Soldi e lavoro', name: 'Finanza e investimenti' },
  { group: 'Soldi e lavoro', name: 'Lavoro e carriera' },
  { group: 'Cultura e svago', name: 'Anime' },
  { group: 'Cultura e svago', name: 'Giochi' },
  { group: 'Cultura e svago', name: 'Arte e cultura' },
  { group: 'Cultura e svago', name: 'Scienza' },
  { group: 'Cultura e svago', name: 'Umorismo' },
  { group: 'Cultura e svago', name: 'Moda e stile' },
  { group: 'Cultura e svago', name: 'Foto e video' },
  { group: 'Cultura e svago', name: 'Sfondi' },
];

/** The names a group can be given from the list: the table without the five virtual types. */
export const NAMEABLE_SEEDS: ReadonlyArray<SeedCollection> = SEED_COLLECTIONS.filter((s) => s.group !== VIRTUAL_TYPE_GROUP);

/** The headings of the page «Raccolte», in the order of the table (no «Tipi (virtuali)»). */
export const SEED_GROUPS: readonly string[] = [...new Set(NAMEABLE_SEEDS.map((s) => s.group))];

const TYPE_NAMES: readonly string[] = SEED_COLLECTIONS.filter((s) => s.group === VIRTUAL_TYPE_GROUP).map((s) => s.name);

/**
 * The few other ways of writing the same thing that the model (or a tag) really uses, found in the trial: the plural of a name, the word of the
 * user («Wallpaper»), `#ai`. Kept SHORT and exact: a wrong match would put a group under a name the posts do not support, and the list names are
 * accepted without looking at the posts. Anything else that is not in the list is a NEW name and needs evidence.
 */
const SEED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Vino: ['Vini', 'Vini italiani', 'Vitigni'],
  Ristoranti: ['Ristorante'],
  Ricette: ['Ricetta'],
  'Casa e design': ['Casa'],
  'Energia e domotica': ['Domotica'],
  Viaggi: ['Viaggio'],
  'Montagna e outdoor': ['Montagna', 'Outdoor'],
  'Animali e natura': ['Animali', 'Natura'],
  'Sport e fitness': ['Sport', 'Fitness'],
  'Mente e spiritualità': ['Spiritualità', 'Mindfulness'],
  'Famiglia e genitori': ['Famiglia', 'Genitori'],
  'Intelligenza artificiale': ['AI', 'IA', 'Artificial intelligence'],
  'Sicurezza informatica': ['Cybersecurity'],       // «Cyber security», «cyber_security» and «#CyberSecurity» are the same key: spaces, case and symbols do not count
  'Auto e moto': ['Auto', 'Moto'],
  'Finanza e investimenti': ['Finanza', 'Investimenti'],
  'Lavoro e carriera': ['Lavoro', 'Carriera'],
  Giochi: ['Gioco', 'Videogiochi'],
  'Arte e cultura': ['Arte', 'Cultura'],
  Scienza: ['Scienze'],
  Umorismo: ['Humor'],
  'Moda e stile': ['Moda'],
  'Foto e video': ['Foto', 'Fotografia'],
  Sfondi: ['Sfondo', 'Wallpaper', 'Wallpapers'],
};

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

/** A name is a short label, not a sentence. */
export const MAX_LABEL_CHARS = 60;
/** A new name has one to three words. */
export const MAX_NAME_WORDS = 3;
/** One of the words of a new name must be in at least this share (per cent) of the members. */
export const MIN_WORD_SHARE_PERCENT = 30;
/** The tag that gives the name when the model's name is not good: shared by at least this share (per cent) of the members. */
export const MIN_TAG_SHARE_PERCENT = 50;
/** What the model is shown of a group (spec §3.1: 8 posts, 170 characters each, and the most frequent tags). */
export const SAMPLE_SIZE = 8;
export const SAMPLE_CHARS = 170;
export const TAGS_IN_PROMPT = 15;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Lower case, no accents, only letters and digits separated by single spaces. */
const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The same with no spaces: `Intelligenza_artificiale`, `IntelligenzaArtificiale` and `#intelligenzaartificiale` are one key. */
const squash = (s: string): string => fold(s).replace(/ /g, '');

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Takes away the symbols of the trial (`#@"*` and their kin), the emoji, the underscores, the quotes at the edges; null when what is left is not a
 * label: nothing, no letter, longer than a label, or a piece of JSON (braces and brackets are never part of a name: cleaning them would leave
 * garbage, like the «JSON rotto» the trial gave as a name).
 */
function cleanLabel(raw: string): string | null {
  if (/[{}[\]]/.test(raw)) return null;
  let t = raw
    .replace(CONTROL, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[#@"“”«»`*\\<>]/g, ' ')
    .replace(/_/g, ' ')
    // a quote at the edges is quoting; inside a word it is an apostrophe and stays («d'autore»)
    .replace(/(^|\s)['’]+|['’]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^[\s.,:;!?\-–—/]+|[\s.,:;!?\-–—/]+$/g, '').trim();
  // no letter = nothing to name (this also covers the empty string)
  if (t.length > MAX_LABEL_CHARS || !/\p{L}/u.test(t)) return null;
  return t;
}

/**
 * A capital first letter; several words all in capitals are shouting («FOTOVOLTAICO E ACCUMULO») and become a sentence; one word in capitals, or
 * capitals made only of short words («DJ SET», «AI VR»), are acronyms and stay as they are.
 */
function sentenceCase(t: string): string {
  const words = t.split(' ');
  const shouting = t === t.toUpperCase() && words.length >= 2 && words.some((w) => w.replace(/[^\p{L}]/gu, '').length >= 4);
  const text = shouting ? t.toLowerCase() : t;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** squashed spelling → exact name of the list (the names and their few aliases). */
const SEED_KEYS = new Map<string, string>();
for (const seed of NAMEABLE_SEEDS) SEED_KEYS.set(squash(seed.name), seed.name);
for (const seed of NAMEABLE_SEEDS) {
  for (const alias of SEED_ALIASES[seed.name] ?? []) if (!SEED_KEYS.has(squash(alias))) SEED_KEYS.set(squash(alias), seed.name);
}
const NAMEABLE_NAMES = new Set(NAMEABLE_SEEDS.map((s) => s.name));
const TYPE_KEYS = new Set(TYPE_NAMES.map(squash));

/** The heading of a name of the list as the table writes it; null for any other name, and for the five virtual types. */
export function seedGroupOf(name: string): string | null {
  return NAMEABLE_SEEDS.find((s) => s.name === name)?.group ?? null;
}

/**
 * What the model (or a tag) wrote → the name: the EXACT name of the list when it is that (any case, accents, underscores, `#ai`, `IntelligenzaArtificiale`),
 * otherwise the same text clean and with a capital; null when there is nothing usable (not text, only symbols, a piece of JSON, too long).
 */
export function canonicalName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = cleanLabel(raw);
  if (!cleaned) return null;
  return SEED_KEYS.get(squash(cleaned)) ?? sentenceCase(cleaned);
}

// ---------------------------------------------------------------------------
// The rules for a new name
// ---------------------------------------------------------------------------

/** Words that are not a subject: a name made of these alone is not a name, and they carry no evidence. */
const STOP_WORDS = new Set([
  'a', 'ad', 'al', 'alla', 'alle', 'allo', 'agli', 'con', 'da', 'dal', 'dalla', 'dalle', 'dei', 'del', 'della', 'delle', 'degli', 'dello', 'di',
  'e', 'ed', 'il', 'in', 'la', 'le', 'lo', 'i', 'gli', 'nel', 'nella', 'nelle', 'negli', 'nei', 'per', 'su', 'sul', 'sulla', 'tra', 'fra', 'un',
  'una', 'uno', 'o', 'ma', 'che', 'd', 'l', 'dell', 'all', 'dall', 'nell', 'sull', 'the', 'of', 'and', 'for', 'to',
]);

/** Generic words that say nothing («Post», «Contenuti», «Varie»…): a name made of these alone is not a name. */
const GENERIC_WORDS = new Set(['post', 'posts', 'contenuti', 'contenuto', 'varie', 'vari', 'altro', 'altri', 'altre', 'generale', 'generali', 'raccolta', 'raccolte', 'misto', 'miscellanea']);

/** A word: letters, with an apostrophe or a hyphen between letters («d'autore», «anti-spreco»). */
const WORD = /^\p{L}+(?:['’-]\p{L}+)*$/u;

/** The name if it is a name in form (1–3 words, letters only, not generic, not a virtual type), else null. */
function nameInForm(name: string): string | null {
  const words = name.split(' ');
  if (words.length > MAX_NAME_WORDS) return null;
  if (!words.every((w) => WORD.test(w))) return null;
  if (TYPE_KEYS.has(squash(name))) return null;
  const meaning = fold(name).split(' ').filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  if (meaning.length > 0 && meaning.every((w) => GENERIC_WORDS.has(w))) return null;
  return name;
}

/** The root of a word, so that singular and plural are one: the last vowels go (`fotovoltaico` and `fotovoltaici` → `fotovoltaic`). */
const stem = (word: string): string => {
  const root = word.replace(/[aeiou]+$/, '');
  return root.length >= 3 ? root : word;
};

export interface NamingMember {
  /** What the post says (the summary, else the caption): the evidence is looked for here. */
  text: string;
  /** The tags of the post. */
  tags: string[];
}

/** A member as the rules read it: text and tags are always what they should be, whatever the caller sent. */
function readMember(m: unknown): NamingMember {
  const raw = (m ?? {}) as { text?: unknown; tags?: unknown };
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

/** True when one of the meaningful words of the name is in at least 30 % of the members (their text and their tags). */
function hasEvidence(name: string, members: NamingMember[]): boolean {
  if (members.length === 0) return false;
  const words = fold(name).split(' ').filter((w) => w.length > 0 && !STOP_WORDS.has(w)).map(stem);
  const seen = members.map((m) => new Set(fold(`${m.text} ${m.tags.join(' ')}`).split(' ').filter(Boolean).map(stem)));
  return words.some((w) => seen.filter((s) => s.has(w)).length * 100 >= members.length * MIN_WORD_SHARE_PERCENT);
}

/** Tags that say nothing about the subject: the placeholders the model copies from the prompt, the tags of the platforms and of the feed. */
const NOISE_TAGS = new Set([
  'tag', 'hashtag', 'utente', 'fyp', 'viral', 'virale', 'perte', 'foryou', 'foryoupage', 'explore', 'trending', 'reels', 'reel', 'instagram', 'tiktok', 'youtube',
  'shorts', 'x', 'follow', 'like',
]);

function isNoiseTag(tag: string): boolean {
  const t = tag.trim();
  return t.startsWith('@') || NOISE_TAGS.has(squash(t));
}

/**
 * The name from the tags: the tag that at least 50 % of the members share (counted once for each member, whatever its case or hash; `#vini` and
 * `#vino` are one). A tag that is a name of the list comes first, then the one that most members have, then alphabetical order; a tag that is not
 * a name (digits, too many words, a type, a generic word) is skipped for the next.
 */
function dominantTag(members: NamingMember[]): ChosenName | null {
  const counts = new Map<string, { name: string; count: number }>();
  for (const member of members) {
    const mine = new Set<string>();
    for (const tag of member.tags) {
      if (isNoiseTag(tag)) continue;
      const name = canonicalName(tag);
      if (!name) continue;
      const key = squash(name);
      if (mine.has(key)) continue;
      mine.add(key);
      const entry = counts.get(key) ?? { name, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  const ranked = [...counts.values()]
    .filter((c) => c.count * 100 >= members.length * MIN_TAG_SHARE_PERCENT)
    .map((c) => ({ ...c, seed: NAMEABLE_NAMES.has(c.name) }))
    .sort((a, b) => Number(b.seed) - Number(a.seed) || b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const c of ranked) {
    if (c.seed) return { name: c.name, fromSeed: true };
    const ok = nameInForm(c.name);
    if (ok) return { name: ok, fromSeed: false };
  }
  return null;
}

export interface ChosenName {
  name: string;
  /** True when the name is one of the list (accepted without looking at the posts). */
  fromSeed: boolean;
}

/**
 * The name of a group, in order (spec §5.5): a name of the list; a new name with evidence in the posts; the tag most posts share; else null (the group
 * is not published and is tried again). `candidate` is what the model said (null when it said nothing usable).
 */
export function chooseName(candidate: string | null, members: NamingMember[]): ChosenName | null {
  const list = (Array.isArray(members) ? members : []).map(readMember);
  const named = canonicalName(candidate);
  if (named) {
    if (NAMEABLE_NAMES.has(named)) return { name: named, fromSeed: true };
    const ok = nameInForm(named);
    if (ok && hasEvidence(ok, list)) return { name: ok, fromSeed: false };
  }
  return dominantTag(list);
}

// ---------------------------------------------------------------------------
// The prompt, the answer, the call
// ---------------------------------------------------------------------------

/** Two short fields: ask nothing else, and a looping model cannot run to the general ceiling. */
export const NAMING_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: MAX_LABEL_CHARS },
    parent: { type: ['string', 'null'] },
  },
  required: ['label', 'parent'],
} as const;

export const NAMING_MAX_TOKENS = 120;

const LIST_BY_HEADING = SEED_GROUPS.map((group) => `- ${group}: ${NAMEABLE_SEEDS.filter((s) => s.group === group).map((s) => s.name).join('; ')}`).join('\n');

const RULES = `Hai davanti alcuni post di una libreria personale che parlano della stessa cosa. Dai un nome alla raccolta.

Regole:
- "label": il nome della raccolta. Se uno dei nomi dell'elenco va bene, SCEGLILO e scrivilo IDENTICO. Se nessuno va bene, scrivine uno nuovo e breve: da 1 a 3 parole, solo lettere (niente numeri, hashtag, simboli, virgolette), in italiano, e almeno una sua parola deve comparire nei post.
- "parent": l'intestazione dell'elenco sotto cui sta il nome (una di quelle dell'elenco), oppure null.
- Mai "Post", "Contenuti", "Varie" o "Altro": non dicono niente.
- Non usare mai i nomi dei tipi, che sono già raccolte a parte: ${TYPE_NAMES.join(', ')}.`;

const EXAMPLES = `Esempio 1
Post: "Come scegliere un vino rosso per l'inverno" | "I vitigni italiani più amati" | "Quanto costa una buona bottiglia"
Tag: vino, cantina
Risposta: {"label":"Vino","parent":"Cibo e bevande"}

Esempio 2
Post: "Come scegliere un drone per le riprese dall'alto" | "I droni più leggeri sotto i 500 euro" | "Le regole per far volare un drone"
Tag: drone, riprese
Risposta: {"label":"Droni","parent":null}`;

/**
 * The prompt: the rules, the list of names under their headings (the five virtual types are not in it), two examples, the names already in use, the
 * most frequent tags and the posts (at most 8, numbered, 170 characters each). In Italian, like the rest of the answers of the site.
 */
export function buildNamingPrompt(sample: string[], tags: string[], existing: string[]): string {
  const posts = sample
    .map((s) => clip(s, SAMPLE_CHARS))
    .filter((s) => s.length > 0)
    .slice(0, SAMPLE_SIZE)
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n');
  const inUse = existing.map((e) => clip(e, MAX_LABEL_CHARS)).filter((e) => e.length > 0);
  return (
    `${RULES}\n\nELENCO DEI NOMI (con la loro intestazione):\n${LIST_BY_HEADING}\n\n${EXAMPLES}\n\n` +
    `NOMI GIÀ IN USO (non ripeterli per un argomento diverso): ${inUse.length ? inUse.join('; ') : '(nessuno)'}\n` +
    `TAG PIÙ FREQUENTI: ${tags.length ? tags.join(', ') : '(nessuno)'}\n\n` +
    `POST\n${posts || '(nessuno)'}\n`
  );
}

/** The heading as the table writes it (any case and accents), or null: «Tipi (virtuali)» and anything invented are not headings. */
function headingOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const wanted = squash(raw);
  return SEED_GROUPS.find((g) => squash(g) === wanted) ?? null;
}

/**
 * Reads the answer of the model: the label (clean, found again in the list) and the heading (as the table writes it, else null). A broken or odd
 * answer is `{ label: null, parent: null }`, never an exception (a value that is not even a string included: the model's text comes off the wire).
 * An answer inside a code fence is read too.
 */
export function parseNaming(raw: string): { label: string | null; parent: string | null } {
  const nothing = { label: null, parent: null };
  if (typeof raw !== 'string') return nothing;
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return nothing;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return nothing;
  const answer = parsed as { label?: unknown; parent?: unknown };
  return { label: canonicalName(answer.label), parent: headingOf(answer.parent) };
}

/** A collection the user renamed (`name_by = 'user'`) is never named again; one with no name, or named by the engine, may be. */
export function mayBeNamed(nameBy: 'auto' | 'user' | null | undefined): boolean {
  return nameBy !== 'user';
}

export interface NamingGroup {
  /** The posts of the group: the text and the tags the evidence is looked for in. */
  members: NamingMember[];
  /** The names the user's other collections already have: the model is told not to repeat them for another subject. */
  existing?: string[];
  /** `name_by` of the collection when it already exists: a name written by the user is never replaced. */
  nameBy?: 'auto' | 'user' | null;
}

export interface NamingDeps {
  generate: (prompt: string, opts: { json: true; schema: Record<string, unknown>; maxTokens: number; model?: string }) => Promise<OllamaResponse>;
}

const realNamingDeps: NamingDeps = { generate: (prompt, opts) => generateText(prompt, [], opts) };

/** `k` items spread over the whole list (the first and the last are in), so the model sees the group and not only its oldest posts. */
function spread<T>(items: T[], k: number): T[] {
  if (items.length <= k) return items;
  return Array.from({ length: k }, (_, i) => items[Math.round((i * (items.length - 1)) / (k - 1))]);
}

/** The most frequent tags of the group, once for each member, as the prompt shows them (no `#`, the noise left out). */
function topTags(members: NamingMember[]): string[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const member of members) {
    const mine = new Set<string>();
    for (const raw of member.tags) {
      if (isNoiseTag(raw)) continue;
      const tag = raw.trim().replace(/^#+/, '').trim();
      const key = squash(tag);
      if (!key || mine.has(key)) continue;
      mine.add(key);
      const entry = counts.get(key) ?? { tag, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .slice(0, TAGS_IN_PROMPT)
    .map((c) => c.tag);
}

export interface NamedGroup {
  name: string;
  /** The heading of the page «Raccolte» (from the table of the list) or null = «Altre» (a name that is not in the list). Never the model's guess. */
  group: string | null;
}

/**
 * Names one group: one call to the local model, then the rules of `chooseName` (the name of the list, a new name with evidence, the dominant tag).
 * null = no name (the group is not published, stays `watching` and is tried again the night after): the model did not answer, said something odd or
 * invented a name, and no tag is shared by half of the posts. Never throws. A group with no member, or whose collection the user renamed, is not named
 * and the model is not asked (the engine keeps the user's name: it must not read this null as «no name»).
 */
export async function nameGroup(group: NamingGroup, deps: NamingDeps = realNamingDeps): Promise<NamedGroup | null> {
  try {
    if (!group || !Array.isArray(group.members) || group.members.length === 0) return null;
    if (!mayBeNamed(group.nameBy)) return null;
    const members = group.members.map(readMember);
    const prompt = buildNamingPrompt(
      spread(members, SAMPLE_SIZE).map((m) => m.text),
      topTags(members),
      Array.isArray(group.existing) ? group.existing.filter((e): e is string => typeof e === 'string') : [],
    );
    let label: string | null = null;
    try {
      const out = await deps.generate(prompt, { json: true, schema: NAMING_SCHEMA as unknown as Record<string, unknown>, maxTokens: NAMING_MAX_TOKENS });
      if (!out.truncated) label = parseNaming(out.text).label;
    } catch {
      // the model is down, asleep or odd: no label; the tag may still give a name
    }
    const chosen = chooseName(label, members);
    if (!chosen) return null;
    // the heading comes from the table: a name of the list has its own, any other name has none (and goes under «Altre»)
    return { name: chosen.name, group: seedGroupOf(chosen.name) };
  } catch {
    return null;
  }
}
