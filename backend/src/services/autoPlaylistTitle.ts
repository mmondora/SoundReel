/**
 * The title of the playlist a post about music becomes, and whether it is a precise one or a generic one (ADR-0023, spec
 * 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.2). Michele, 10 November:
 *   «ecco le 5 musiche di natale» → a playlist «con il titolo adeguato» (one for the post);
 *   «ecco gli album jaaz da ascoltare» → «jazz da ascoltare», «e deve essere una sola» (one for the theme, fed by every such post).
 *
 * A SMALL second call that looks for nothing else (like the software one): its own schema, two examples, the local model, never
 * Claude. The model proposes; the code cleans (a title with `#`, «ecco i…», emoji or a generic word is not a title) and checks (a
 * theme the model says already exists must be IDENTICAL to one that does). A failure here never fails an analysis: it only means no
 * playlist yet (the entry stays pending).
 */
import { generateText, type OllamaResponse } from './ollamaClient';

export const TITLE_SCHEMA = {
  type: 'object',
  properties: {
    aboutMusic: { type: 'boolean' },
    title: { type: 'string', maxLength: 100 },
    kind: { type: 'string', enum: ['one_off', 'theme'] },
    existingTheme: { type: ['string', 'null'] },
  },
  required: ['aboutMusic', 'title', 'kind', 'existingTheme'],
} as const;

/** The answer is three short fields: this keeps a looping model from running to the general ceiling. */
export const TITLE_MAX_TOKENS = 200;
export const MAX_TITLE_CHARS = 60;
const MAX_THEMES_IN_PROMPT = 40;
const MAX_SONGS_IN_PROMPT = 12;

export type PlaylistKind = 'one_off' | 'theme';

export interface TitlePlan {
  /**
   * false = the songs the analysis found are not what the post is about (the background track, the titles of films, an incidental
   * mention): no playlist. The title is then empty.
   */
  aboutMusic: boolean;
  /** Clean, 60 characters at most. */
  title: string;
  kind: PlaylistKind;
  /** A theme that already exists, written exactly as it is there; null when the post is a new one. */
  existingTheme: string | null;
}

export interface TitleSource {
  caption: string | null;
  summary: string | null;
  songs: Array<{ title: string; artist: string }>;
  /** The titles of the themes the user already has. */
  themes: string[];
  /** The language of the interface (`features.outputLanguage`). */
  language: 'it' | 'en';
  /**
   * `list` (default): the post names several songs: a precise title is a playlist of its own, a generic one is a theme.
   * `single`: the post has ONE song (named in the text or recognised from the audio): it can only go into a THEME («Elettronica da
   * ascoltare»), and only when the post is really about music (the background track of a recipe is not).
   */
  mode?: 'list' | 'single';
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const RULES = (language: 'it' | 'en') => `Un post social ha delle canzoni, che un'analisi ha trovato nel testo o nel parlato. Decidi se il post parla davvero di musica e, se sì, dagli il titolo di una playlist.

Regole:
- "aboutMusic": true solo se il post è davvero un elenco o un consiglio di canzoni, album o artisti da ascoltare. false se le canzoni sono secondarie: musica di sottofondo, colonna sonora, titoli di film o di serie, una citazione. Se è false, "title" è "" e "kind" è "one_off".
- "title": il nome della playlist, ${language === 'it' ? 'SEMPRE in italiano, anche se il post è in un\'altra lingua (traducilo; restano com\'erano solo i nomi propri)' : 'always in English, even if the post is in another language'}, breve (al massimo 6 parole), come lo scriverebbe una persona: lettere minuscole e maiuscole normali (mai tutto maiuscolo), i nomi propri come compaiono nel testo, senza errori di battitura. Mai hashtag, mai "ecco", mai virgolette, mai emoji.
- "kind":
  - "one_off" se la lista è PRECISA: ha un numero, un'occasione, un anno o un artista ("Le 5 musiche di Natale", "Canzoni del 2026", "Le più belle di Battisti").
  - "theme" se la lista è GENERICA: un genere, un umore, un'occasione o un'abitudine che tornerà in altri post. Il titolo di un tema è un'etichetta breve e durevole (2-4 parole): il genere, l'umore o l'occasione, e "da ascoltare" o "per ..." se serve. Niente numeri, anni o superlativi come "più belli" ("ecco gli album jazz da ascoltare" diventa "Jazz da ascoltare", "10 dischi per una cena con gli amici" diventa "Musica per la cena").
- "existingTheme": se "kind" è "theme" e uno dei TEMI GIÀ ESISTENTI è lo stesso argomento, scrivilo IDENTICO; altrimenti null.`;

const EXAMPLES = `

Esempio 1
Post: "ecco le 5 musiche di Natale che non possono mancare nella tua playlist"
Risposta: {"aboutMusic":true,"title":"Le 5 musiche di Natale","kind":"one_off","existingTheme":null}

Esempio 2
Temi già esistenti: Jazz da ascoltare
Post: "ecco gli album jazz da ascoltare questo weekend"
Risposta: {"aboutMusic":true,"title":"Jazz da ascoltare","kind":"theme","existingTheme":"Jazz da ascoltare"}

Esempio 3
Post: "3 film da vedere stasera su RaiPlay, con la colonna sonora di Morricone"
Canzoni: Ennio Morricone - Il buono il brutto il cattivo
Risposta: {"aboutMusic":false,"title":"","kind":"one_off","existingTheme":null}

Esempio 4
Post: "5 perfect songs for a late night drive, save this"
Canzoni: Kavinsky - Nightcall; The Weeknd - Blinding Lights; Chromatics - Tick of the Clock
Risposta: {"aboutMusic":true,"title":"5 canzoni per guidare di notte","kind":"one_off","existingTheme":null}`;

/**
 * The themes ONE song can go into: a closed list of exact titles. The model only CHOOSES (a schema `enum`), the code never lets it write one:
 * on 483 real posts a free title gave «Synthwave de Ascolare», «Jazz de Ascolare», «Synchpunk/BladeRunner vibe» and thirty near-copies, and a
 * closed list gives few, clean, stable themes («una sola per tema» is only true if the same theme always has the same title).
 */
export const THEME_GENRES = [
  'Jazz', 'Rock', 'Pop', 'Elettronica', 'House', 'Techno', 'Synthwave', 'Darkwave', 'Italo disco', 'Disco', 'Hip hop', 'Rap', 'R&B', 'Soul', 'Funk',
  'Blues', 'Metal', 'Punk', 'Indie', 'Folk', 'Reggae', 'Latina', 'Classica', 'Colonne sonore', 'Musica italiana', 'Cantautori', 'Ambient', 'Lo-fi',
  'Dance', 'Anni 80', 'Anni 90',
] as const;

export const SINGLE_THEMES: readonly string[] = [
  ...THEME_GENRES.map((g) => `${g} da ascoltare`),
  'Musica per la notte', 'Musica per allenarsi', 'Musica per studiare', 'Musica per rilassarsi', 'Musica per la cena',
];

export const SINGLE_SCHEMA = {
  type: 'object',
  properties: {
    aboutMusic: { type: 'boolean' },
    theme: { type: 'string', enum: ['', ...SINGLE_THEMES] },
  },
  required: ['aboutMusic', 'theme'],
} as const;

const SINGLE_RULES = `Un post social ha UNA canzone, citata nel testo o riconosciuta dall'audio. Decidi se il post parla davvero di musica e, se sì, in quale playlist di TEMA metterla.

Regole:
- "aboutMusic": true solo se il post riguarda la musica: è un brano o un clip musicale, un consiglio di ascolto, un artista, un concerto, un DJ set, la colonna sonora di un film. false se la canzone è solo il sottofondo di altro (una ricetta, il vino, lo sport, un video divertente, la tecnologia, un balletto di tendenza). Se è false, "theme" è "".
- "theme": SCEGLI UNO dei temi di questo elenco, scrivilo identico: ${SINGLE_THEMES.join('; ')}.`;

const SINGLE_EXAMPLES = `

Esempio 1
Post: "Kavinsky - Nightcall, la colonna sonora perfetta per guidare di notte con i neon"
Canzoni: Kavinsky - Nightcall
Risposta: {"aboutMusic":true,"theme":"Synthwave da ascoltare"}

Esempio 2
Post: "carbonara in cinque minuti, solo uova guanciale e pecorino"
Canzoni: Dua Lipa - Levitating
Risposta: {"aboutMusic":false,"theme":""}`;

export function buildTitlePrompt(source: TitleSource): string {
  const themes = source.themes.slice(0, MAX_THEMES_IN_PROMPT);
  const songs = source.songs
    .slice(0, MAX_SONGS_IN_PROMPT)
    .map((s) => `${clip(s.artist, 60)} - ${clip(s.title, 80)}`)
    .join('; ');
  const single = source.mode === 'single';
  const rules = single ? `${SINGLE_RULES}${SINGLE_EXAMPLES}` : `${RULES(source.language)}${EXAMPLES}`;
  return (
    `${rules}\n\n${single ? '' : `TEMI GIÀ ESISTENTI: ${themes.length ? themes.join('; ') : '(nessuno)'}\n\n`}POST\n` +
    `Didascalia: ${clip(source.caption, 900) || '(nessuna)'}\n` +
    `Riassunto: ${clip(source.summary, 700) || '(nessuno)'}\n` +
    `Canzoni: ${songs || '(nessuna)'}\n`
  );
}

// ---------------------------------------------------------------------------
// Cleaning: a title is what a person would write
// ---------------------------------------------------------------------------

/** A title made of these alone says nothing («Playlist», «Musica»): it is not a title. */
const GENERIC_ONLY = new Set([
  'playlist', 'musica', 'music', 'canzoni', 'canzone', 'brani', 'brano', 'songs', 'song', 'lista', 'list', 'post', 'reel', 'video',
  'album', 'tracce', 'traccia', 'ascolti', 'da ascoltare', 'suoni',
]);

const BOILERPLATE = /^(ecco|ecco qui|eccoti|guarda|ascolta|here are|here is|check out|look at)\b[\s,:-]*(i|gli|le|la|il|lo|l'|un|una|dei|degli|delle|the|these|my)?\s*/i;

const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** «#Jazz da ascoltare!» → «Jazz da ascoltare»; null when nothing usable is left. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let t = raw
    .replace(CONTROL, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[#@"“”«»`*\\{}[\]<>]/g, ' ')
    // a quote at the edges is quoting («'Jazz da ascoltare'»); inside a word it is an apostrophe and stays («L'estate», «dell'anno»)
    .replace(/(^|\s)['’]+|['’]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(BOILERPLATE, '').trim();
  t = t.replace(/^[\s.,:;!?\-–—_/]+|[\s.,:;!?\-–—_/]+$/g, '').trim();
  if (t.length > MAX_TITLE_CHARS) {
    const cut = t.slice(0, MAX_TITLE_CHARS);
    t = cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
    t = t.replace(/[\s.,:;!?\-–—_/]+$/g, '').trim();
  }
  if (t.length < 3 || !/\p{L}/u.test(t)) return null;
  // «GARA DURÁN» is shouting, not a name: sentence case. A title with any lower-case letter is left as it is, and so is one single
  // word in capitals («ABBA», «SADE»: a name, an acronym).
  if (t === t.toUpperCase() && t.split(' ').length >= 2 && t.replace(/[^\p{L}]/gu, '').length >= 4) t = t.toLowerCase();
  if (GENERIC_ONLY.has(fold(t))) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const STOP_WORDS = new Set(['da', 'di', 'del', 'della', 'dei', 'delle', 'degli', 'per', 'il', 'lo', 'la', 'le', 'i', 'gli', 'un', 'una', 'the', 'of', 'to', 'for', 'a', 'and', 'e']);

/** The words of a title that carry its meaning: no case, no accents, no little words, in a fixed order. */
export function themeWords(title: string): string[] {
  return [...new Set(fold(title).split(' ').filter((w) => w.length > 0 && !STOP_WORDS.has(w)))].sort();
}

/** «Jazz da ascoltare» and «ascoltare jazz» are one theme: the key is the sorted meaningful words. */
export function themeKey(title: string): string {
  const words = themeWords(title);
  return words.length ? words.join(' ') : fold(title);
}

/** Share of words two titles have in common (0…1): the last resort to see that two titles are one theme. */
export function titleOverlap(a: string, b: string): number {
  const x = new Set(themeWords(a));
  const y = new Set(themeWords(b));
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

/** Reads the model's answer. A theme it says exists must be IDENTICAL (once folded) to one that does, or it is dropped. */
/** ONE song: the model only chooses a theme of the closed list; anything else is no answer. */
function parseSingleResponse(raw: string): TitlePlan | null {
  let parsed: { aboutMusic?: unknown; theme?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.aboutMusic === false) return { aboutMusic: false, title: '', kind: 'theme', existingTheme: null };
  if (typeof parsed.theme !== 'string') return null;
  const wanted = fold(parsed.theme);
  const chosen = SINGLE_THEMES.find((t) => fold(t) === wanted);
  return chosen ? { aboutMusic: true, title: chosen, kind: 'theme', existingTheme: null } : null;
}

export function parseTitleResponse(raw: string, existingThemes: string[], mode: 'list' | 'single' = 'list'): TitlePlan | null {
  if (mode === 'single') return parseSingleResponse(raw);
  let parsed: { aboutMusic?: unknown; title?: unknown; kind?: unknown; existingTheme?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  // the songs are not what the post is about: no title is wanted (and none is missed)
  if (parsed.aboutMusic === false) return { aboutMusic: false, title: '', kind: 'one_off', existingTheme: null };
  const title = cleanTitle(parsed.title);
  if (!title) return null;
  if (parsed.kind !== 'one_off' && parsed.kind !== 'theme') return null;
  const kind: PlaylistKind = parsed.kind;
  let existingTheme: string | null = null;
  if (kind === 'theme' && typeof parsed.existingTheme === 'string') {
    const wanted = fold(parsed.existingTheme);
    existingTheme = existingThemes.find((t) => fold(t) === wanted) ?? null;
  }
  return { aboutMusic: true, title, kind, existingTheme };
}

export interface TitleDeps {
  generate: (prompt: string, opts: { json: true; schema: Record<string, unknown>; maxTokens: number; model?: string }) => Promise<OllamaResponse>;
}

/**
 * `AUTO_PLAYLIST_MODEL`: a bigger local model for the titles (the default small one leaves typos in names). The big models «think» before they
 * answer and the thinking counts against the ceiling of tokens, so a chosen model gets a ceiling that leaves room for it.
 */
export const BIG_MODEL_MAX_TOKENS = 1500;

const realTitleDeps: TitleDeps = { generate: (prompt, opts) => generateText(prompt, [], opts) };

/**
 * One call to the local model; null when it does not answer, is cut short or says nothing usable. Never throws.
 * With `AUTO_PLAYLIST_MODEL` a LIST post is first asked to that (bigger) model and, if it does not give a usable answer (down, cold, cut short, no
 * title), to the default one: a title is never lost to a big model that is asleep. A post with ONE song is always asked to the default model: its
 * theme is picked from a short list of genres, so the small model does not misspell it, and there are hundreds of them.
 */
export async function generatePlaylistTitle(source: TitleSource, deps: TitleDeps = realTitleDeps): Promise<TitlePlan | null> {
  const mode = source.mode ?? 'list';
  const big = mode === 'list' ? process.env.AUTO_PLAYLIST_MODEL?.trim() || undefined : undefined;
  const attempts: Array<string | undefined> = big ? [big, undefined] : [undefined];
  for (const model of attempts) {
    try {
      const out = await deps.generate(buildTitlePrompt(source), {
        json: true,
        schema: (mode === 'single' ? SINGLE_SCHEMA : TITLE_SCHEMA) as unknown as Record<string, unknown>,
        maxTokens: model ? BIG_MODEL_MAX_TOKENS : TITLE_MAX_TOKENS,
        ...(model ? { model } : {}),
      });
      if (out.truncated) continue;
      const plan = parseTitleResponse(out.text, source.themes, mode);
      if (plan) return plan;
    } catch {
      // the next model, if there is one
    }
  }
  return null;
}
