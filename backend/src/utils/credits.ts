/**
 * «Hell Raton, Ensi, Salmo feat. Gemitaiz» → each credited name, as the app shows it. Names are separated by a comma, a
 * semicolon, «feat.» / «ft.» / «featuring», « x » and « vs ». NOT by «&» or «and»: «Simon & Garfunkel» is one name, and a
 * word that merely starts with «feat» («Feather») or is an «X» («X Japan», «Malcolm X») is a name too.
 *
 * Shared by the search (grouping the same recording found twice) and by the cover lookup (which asks the Internet for the FIRST
 * credited artist only).
 */
const CREDIT_SPLIT = /\s*[,;]\s*|\s+(?:feat\.\s*|feat\s+|ft\.\s*|ft\s+|featuring\s+|x\s+|vs\.?\s+)/i;

export function creditsOf(artist: string): string[] {
  return artist
    .split(CREDIT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
}
