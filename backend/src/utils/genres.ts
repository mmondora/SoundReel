/**
 * Music "type" (rock, jazz, trap…) as the user means it. Deezer and iTunes name the same genre differently and in
 * different languages ("Alternative" / "Alternativa", "Hip-Hop/Rap" / "Rap/Hip Hop", "Elettronica" / "Electro"),
 * which splits one genre into several filter chips. This maps the variants seen in the real data to one label;
 * anything unknown passes through unchanged (trimmed), so nothing is ever lost.
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

/** The one label for a genre name ("Alternativa" → "Alternative"); unknown names are returned trimmed. */
export function canonicalGenre(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return BY_VARIANT.get(normalize(trimmed)) ?? trimmed;
}

/** Canonical, deduplicated, sorted — the shape the filters and the dynamic playlists work with. */
export function canonicalGenres(raw: readonly string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const g of raw ?? []) if (typeof g === 'string' && g.trim()) out.add(canonicalGenre(g));
  return [...out].sort((a, b) => a.localeCompare(b, 'it'));
}
