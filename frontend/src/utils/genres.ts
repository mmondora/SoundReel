/**
 * Music "type" (rock, jazz, trap…) as the user means it. Deezer and iTunes name the same genre differently and in
 * different languages ("Alternative" / "Alternativa", "Hip-Hop/Rap" / "Rap/Hip Hop", "Elettronica" / "Electro"),
 * which would split one genre into several filter chips. This maps the variants seen in the real data to one name;
 * anything unknown passes through unchanged (trimmed), so nothing is ever lost.
 *
 * A copy of `backend/src/utils/genres.ts`: the web filters and Mondrop's library endpoint must group genres the same
 * way (ADR-0013, "no second filtering engine": same rules, one list). Keep the two lists identical.
 */
const GROUPS: Array<[canonical: string, variants: string[]]> = [
  ['Alternative', ['alternative', 'alternativa', 'alternativa adulti', 'alternative rock']],
  ['Hip-Hop/Rap', ['hip-hop/rap', 'rap/hip hop', 'hip hop', 'hip-hop', 'hiphop', 'rap', 'rap tradizionale']],
  ['Elettronica', ['elettronica', 'electro', 'electronic', 'electronica']],
  ['Colonne sonore', ['colonne sonore', 'film/videogiochi', 'soundtrack', 'soundtracks']],
  ['Classica', ['classica', 'musica classica', 'classica crossover', 'classical', 'epoca contemporanea']],
  ['R&B/Soul', ['r&b/soul', 'r&b', 'soul', 'soul & funk']],
  ['Latina', ['musica latina', 'latina', 'latin']],
  ['Indie Pop', ['indie pop', 'indie pop/folk']],
  ['Indie Rock', ['indie rock', 'indie rock/pop rock']],
  ['Hard Rock', ['hard rock']],
  ['Bambini', ['bambini', 'musica per bambini', 'natale: per bambini']],
  ['Pop', ['pop', 'pop internazionale']],
  ['Cantautori', ['cantautori', 'singer & songwriter', 'singer/songwriter']],
];

const BY_VARIANT = new Map<string, string>();
for (const [canonical, variants] of GROUPS) for (const v of variants) BY_VARIANT.set(v, canonical);

const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The one name for a genre ("Alternativa" → "Alternative"); unknown names are returned trimmed. */
export function canonicalGenre(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return BY_VARIANT.get(normalize(trimmed)) ?? trimmed;
}

/** True when `name` is one of the canonical names above (it is then the preferred spelling of its group). */
export const isCanonicalGenre = (name: string): boolean => GROUPS.some(([canonical]) => canonical === name);
