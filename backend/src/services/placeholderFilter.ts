/**
 * Reject values where the model echoed the prompt template's own placeholders
 * instead of filling them in — e.g. a song stored as `{title: "...", artist:
 * "..."}` or a film year of `"anno o null"`, both copied verbatim from the
 * JSON skeleton the prompt shows as an example.
 *
 * Deliberately narrow: it matches placeholder *shapes*, never short values.
 * Real data is full of legitimately tiny titles — "Ink" (Coldplay), "Red"
 * (King Crimson), "F1" (Hans Zimmer), "o3" — so a length heuristic would
 * silently delete genuine entries.
 */

/** Only dots/ellipsis, or a null-ish literal the model wrote out as text. */
const PLACEHOLDER_EXACT = /^(?:\.{2,}|…+|null|undefined|n\/?a)$/i;

/** The template renders optional fields as "<descrizione> o null". */
const PLACEHOLDER_O_NULL = /\bo\s+null\s*$/i;

export function isPlaceholderValue(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return true;

  const trimmed = value.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_EXACT.test(trimmed)) return true;
  if (PLACEHOLDER_O_NULL.test(trimmed)) return true;

  return false;
}

/** The bare category words the prompt uses, which a model sometimes writes in place of a name. */
const SOFTWARE_PLACEHOLDER_WORDS = new Set([
  'repo', 'repository', 'tool', 'tools', 'software', 'product', 'article', 'other', 'name', 'title', 'url', 'link',
  'nome', 'prodotto', 'titolo',
]);

/**
 * A software "title" that is not a name: what the local model writes when it has nothing to say but the schema wants
 * a string. Measured on 8 November on a Cloudflare reel and a "5 plugins for Claude Code" reel: `"/repo"`, `"/"`,
 * `"/name"`. Narrow like the rest of this file, never by length (real tools are short: Go, uv, jq, Zed, Bun):
 * a path fragment (it starts with a slash), nothing but punctuation, or a bare category word.
 */
export function isJunkSoftwareTitle(value: string | null | undefined): boolean {
  if (isPlaceholderValue(value)) return true;
  const t = (value as string).trim();
  if (/^[/\\]/.test(t)) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return SOFTWARE_PLACEHOLDER_WORDS.has(t.toLowerCase());
}

/** True when a value is usable — the inverse, for readable filter predicates. */
export function isRealValue(value: string | null | undefined): value is string {
  return !isPlaceholderValue(value);
}

/**
 * True only when the field actually holds placeholder *text* that needs
 * removing — as opposed to being absent, null or empty, which carry no junk
 * and are already "no value".
 *
 * Repair passes over existing records must use this rather than
 * isPlaceholderValue(), which treats missing/empty as placeholders and would
 * rewrite untouched records purely to normalise undefined to null.
 */
export function isPlaceholderText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && isPlaceholderValue(value);
}
