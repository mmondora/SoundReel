/**
 * The software a post names, found by a SMALL second call that looks for nothing else.
 *
 * Why a second call: the big analysis schema (songs, films, notes, software, links, tags, summary) leaves `software[]`
 * empty or full of placeholders ("/repo", "tool"). Measured on 8 November on the 135 entries re-analysed after the
 * 2.9.1 repair: no item at all, while 48 of them clearly name tools; the same entries through a focused call (own
 * schema, two examples) gave real names in about a second each — "Security Audit Skill" for the Cloudflare reel,
 * "FreeLLMAPI" and "Strix" for the five plugins — and nothing on posts about wine or rice cookers.
 *
 * Three guards keep it honest: it runs only when the text hints at software, a title must really appear in the text
 * (the model is asked to copy the name, and a name it invents is dropped), and a URL must appear there too (never
 * invented). A failure of this call never fails the analysis: it only means no extra software.
 */
import type { SoftwareItem, SoftwareTag } from '../types';
import { generateText, type OllamaResponse } from './ollamaClient';
import { isJunkSoftwareTitle } from './placeholderFilter';
import { logWarning } from '../utils/logger';

export const SOFTWARE_SCHEMA = {
  type: 'object',
  properties: {
    software: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 2 },
          url: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['repo', 'product'] },
        },
        required: ['title', 'kind'],
      },
    },
  },
  required: ['software'],
} as const;

/** The answer is a short list: this keeps a looping model from running to the general ceiling. */
export const SOFTWARE_MAX_TOKENS = 500;
export const MAX_EXTRACTED = 8;

/**
 * Words that say a post may be about software. A cheap gate, deliberately wide: a post that says none of them gets no
 * second call (and cannot get an invented tool), a post that says one is looked at.
 */
const SOFTWARE_HINTS =
  /(github|gitlab|codeberg|\brepo\b|repository|plugin|\bskill\b|open[- ]?source|\bnpm\b|\bpip\b|\bbrew\b|\bmcp\b|\bllm\b|\bapi\b|\bsdk\b|claude|cursor|copilot|chatgpt|openai|gemini|ollama|\bapp\b|\bapps\b|\bsoftware\b|\btools?\b|sviluppat|developer|\bcoding\b|framework|librerie|libreria|\blibrary\b|extension|estensione|terminal|\bcli\b|docker|linux|\bai\b|\bia\b|agente|\bagents?\b|saas|programma|\bscarica\b|download|\.app\b|\.io\b|\.dev\b)/i;

export function looksLikeSoftware(text: string): boolean {
  return SOFTWARE_HINTS.test(text);
}

const RULES = `Da questo contenuto di un post social estrai i SOFTWARE citati per nome: programmi, app, librerie, framework, strumenti da riga di comando, plugin, skill, servizi online, repository GitHub o GitLab, modelli AI.

Regole:
- "title": il nome proprio esattamente come compare nel testo. Mai una parola generica ("repo", "tool", "software", "app", "plugin", "link").
- "url": solo se un indirizzo compare nel testo, altrimenti null. Non inventarlo.
- "kind": "repo" per un repository (GitHub, GitLab), altrimenti "product".
- Elenca solo ciò che il testo nomina davvero. Se non cita nessun software per nome, restituisci {"software": []}.`;

const EXAMPLES = `

Esempio 1
Testo: "Ho provato Cursor e poi Claude Code: con il plugin Playwright MCP il codice gira da solo. Repo: github.com/microsoft/playwright-mcp"
Risposta: {"software":[{"title":"Cursor","url":null,"kind":"product"},{"title":"Claude Code","url":null,"kind":"product"},{"title":"Playwright MCP","url":"https://github.com/microsoft/playwright-mcp","kind":"repo"}]}

Esempio 2
Testo: "Colazione al mare con la mia famiglia, che giornata fantastica #estate"
Risposta: {"software":[]}`;

export interface SoftwareSource {
  caption: string | null;
  transcript: string | null;
  ocrText: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The text the model reads, and the text a title is checked against (one and the same, so nothing is invented). */
export function sourceTextOf(source: SoftwareSource): string {
  return [clip(source.caption, 1800), clip(source.transcript, 2500), clip(source.ocrText, 1200)].filter(Boolean).join('\n');
}

export function buildSoftwarePrompt(source: SoftwareSource): string {
  return (
    `${RULES}${EXAMPLES}\n\nCONTENUTO\n` +
    `Didascalia: ${clip(source.caption, 1800) || '(nessuna)'}\n` +
    `Trascrizione: ${clip(source.transcript, 2500) || '(nessuna)'}\n` +
    `Testo a schermo: ${clip(source.ocrText, 1200) || '(nessuno)'}\n`
  );
}

const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9/.+#]+/g, ' ')
    .trim();

/**
 * Is this name really in the text? Compared without case, accents, punctuation and spaces, so "Free LLM API" finds
 * "FreeLLMAPI"; a very short name ("uv", "Go", "jq") must be a whole word, or "go" would be found in "algoritmo".
 * A trailing "(…)" the model adds to explain is not part of the name.
 */
export function isGrounded(title: string, text: string): boolean {
  const name = fold(title.replace(/\s*\([^)]*\)\s*$/, ''));
  if (name.length < 2) return false;
  const haystack = fold(text);
  if (name.replace(/ /g, '').length < 4) {
    // whole word only (the full stop that ends a sentence is a boundary: "scritto in Go.")
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
  }
  return haystack.replace(/ /g, '').includes(name.replace(/ /g, ''));
}

function groundedUrl(raw: unknown, text: string): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const bare = fold(url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '')).replace(/ /g, '');
  return bare.length >= 4 && fold(text).replace(/ /g, '').includes(bare) ? url : null;
}

/** Reads the model's answer into software items, keeping only real, grounded, distinct names. */
export function parseSoftwareResponse(raw: string, text: string): SoftwareItem[] {
  let parsed: { software?: unknown };
  try {
    parsed = JSON.parse(raw) as { software?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.software)) return [];
  const seen = new Set<string>();
  const out: SoftwareItem[] = [];
  for (const item of parsed.software as Array<{ title?: unknown; url?: unknown; kind?: unknown }>) {
    const title = typeof item?.title === 'string' ? item.title.replace(/\s*\([^)]*\)\s*$/, '').trim() : '';
    if (!title || isJunkSoftwareTitle(title) || !isGrounded(title, text)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const tag: SoftwareTag = item.kind === 'repo' ? 'repo' : 'product';
    out.push({ title, url: groundedUrl(item.url, text), tag, description: null });
    if (out.length >= MAX_EXTRACTED) break;
  }
  return out;
}

export type GenerateFn = (
  prompt: string,
  images: never[],
  opts: { json: true; schema: Record<string, unknown>; maxTokens: number },
) => Promise<Pick<OllamaResponse, 'text' | 'usageMetadata' | 'truncated'>>;

export interface SoftwareExtraction {
  items: SoftwareItem[];
  usage: OllamaResponse['usageMetadata'] | null;
  /** `skipped`: nothing hinted at software; `failed`: the call or its answer was no good (never an error to the caller). */
  outcome: 'found' | 'none' | 'skipped' | 'failed';
}

/** The second call. Never throws. */
export async function extractSoftware(
  source: SoftwareSource,
  generate: GenerateFn = generateText as unknown as GenerateFn,
): Promise<SoftwareExtraction> {
  const text = sourceTextOf(source);
  if (!text || !looksLikeSoftware(text)) return { items: [], usage: null, outcome: 'skipped' };
  try {
    const response = await generate(buildSoftwarePrompt(source), [], {
      json: true,
      schema: SOFTWARE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: SOFTWARE_MAX_TOKENS,
    });
    if (response.truncated) return { items: [], usage: response.usageMetadata ?? null, outcome: 'failed' };
    const items = parseSoftwareResponse(response.text, text);
    return { items, usage: response.usageMetadata ?? null, outcome: items.length > 0 ? 'found' : 'none' };
  } catch (err) {
    logWarning('estrazione software non riuscita (l\'analisi prosegue senza)', { error: err instanceof Error ? err.message : String(err) });
    return { items: [], usage: null, outcome: 'failed' };
  }
}

/** The big call's list and the focused one's, once each: the first keeps its url and description when both name a tool. */
export function mergeSoftware(main: SoftwareItem[], extra: SoftwareItem[], max = 12): SoftwareItem[] {
  const seen = new Set<string>();
  const out: SoftwareItem[] = [];
  for (const item of [...main, ...extra]) {
    const key = item.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}
