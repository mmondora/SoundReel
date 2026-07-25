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

/** True when a value is usable — the inverse, for readable filter predicates. */
export function isRealValue(value: string | null | undefined): value is string {
  return !isPlaceholderValue(value);
}
