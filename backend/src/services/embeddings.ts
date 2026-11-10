/**
 * The vector of an entry (Raccolte, task 1; spec 2026-11-09-library-collections-auto-topics-design.md §3.1, ADR-0022): the text that stands for it, and the
 * call to the LOCAL router that turns texts into vectors (`nomic-embed-text` through `/api/embed`; never Claude, nothing leaves the house).
 *
 * Pure apart from `postToRouter`, which is the only thing that touches the network and is injected (`deps.post`) everywhere it matters, so no test calls
 * Ollama. The vectors are compared in memory (no pgvector: ADR-0001), see `collectionsCluster.ts`.
 */
import { createHash } from 'crypto';

export const EMBED_MODEL = 'nomic-embed-text';
/** The task prefix of `nomic-embed-text` for «group these texts by what they are about». */
export const EMBED_PREFIX = 'clustering: ';
/** Texts per call to the router. */
export const EMBED_BATCH = 32;

/** An entry that says less than this in all is not turned into a vector (55 of 1698 on 9 November): it still shows in the type collections. */
export const MIN_TEXT_CHARS = 25;
export const MAX_TEXT_CHARS = 1400;
/** The caption stands for the summary when there is none, cut at this. */
export const CAPTION_CHARS = 400;
export const MAX_TAGS = 12;

/** Tags that say nothing (the model copies some from its own prompt, the platforms add others): without the `#`, lower case. */
const NOISE_TAGS = new Set(['tag', 'hashtag', 'fyp', 'viral', 'perte', 'foryou', 'foryoupage', 'reels', 'instagram', 'explore', 'trending', 'x']);

export interface EmbeddingSource {
  caption: string | null;
  results: { summary?: string | null; tags?: string[] };
}

/** The tags that mean something: no `@…`, no noise, the `#` off, each once (case does not make another), in their order, at most `MAX_TAGS`. */
function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('@')) continue;
    const word = trimmed.replace(/^#+/, '').trim();
    const key = word.toLowerCase();
    if (word === '' || NOISE_TAGS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

/**
 * What stands for the entry: its summary (else its caption cut at 400 characters), then its clean tags on a line of their own, at most 1400 characters
 * in all; `null` when the whole is shorter than 25 characters (too little to say what it is about).
 */
export function entryEmbeddingText(entry: EmbeddingSource): string | null {
  const summary = typeof entry.results?.summary === 'string' ? entry.results.summary.trim() : '';
  const caption = typeof entry.caption === 'string' ? entry.caption.trim().slice(0, CAPTION_CHARS) : '';
  const base = summary !== '' ? summary : caption;
  const tags = cleanTags(entry.results?.tags);
  const text = (tags.length > 0 ? `${base}\n${tags.join(' ')}` : base).trim().slice(0, MAX_TEXT_CHARS);
  return text.length >= MIN_TEXT_CHARS ? text : null;
}

/** The fingerprint of a text (the store keeps it: a vector is made again only when the text changes). */
export function embeddingTextHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export interface EmbedDeps {
  post: (url: string, body: unknown) => Promise<{ embeddings: number[][] }>;
}

/** The router is slow to wake (a cold model takes seconds); a call that takes longer than this is a failure, and the caller tries again later. */
const REQUEST_TIMEOUT_MS = 180_000;

/** The real call: JSON to the router, JSON back with `embeddings`. A refusal, a bad answer and a timeout are errors. */
export async function postToRouter(url: string, body: unknown): Promise<{ embeddings: number[][] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`embedding router answered ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const json = (await response.json()) as { embeddings?: unknown };
    if (!Array.isArray(json.embeddings)) throw new Error('embedding router answered without embeddings');
    return { embeddings: json.embeddings as number[][] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The vectors of these texts, in the same order: `nomic-embed-text` on the router, every text prefixed with `clustering: `, `EMBED_BATCH` per call. An
 * answer with a different number of vectors than texts is an error (never a shifted result). A failure goes up: whoever calls decides when to try again.
 */
export async function embedTexts(texts: string[], deps: EmbedDeps = { post: postToRouter }): Promise<number[][]> {
  const url = `${process.env.OLLAMA_URL || 'http://gpu-router:9000'}/api/embed`;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const { embeddings } = await deps.post(url, { model: EMBED_MODEL, input: batch.map((t) => `${EMBED_PREFIX}${t}`) });
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error(`embedding router gave ${Array.isArray(embeddings) ? embeddings.length : 0} vectors for ${batch.length} texts`);
    }
    out.push(...embeddings);
  }
  return out;
}
