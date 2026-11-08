/**
 * Text normalisation for the library search (spec 2026-11-07-library-search-music-folders-design.md, L2):
 * no case, no accents, every run of non-letters/digits is one space, and the ORDER of the words does not matter,
 * so "Maestro Bassi" finds "Bassi Maestro".
 */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(query: string): string[] {
  return normalizeSearch(query).split(' ').filter(Boolean);
}

/** Every word of the query appears somewhere in the (already normalised) text. */
export function matchesAll(normalizedText: string, tokens: readonly string[]): boolean {
  for (const t of tokens) if (!normalizedText.includes(t)) return false;
  return true;
}
