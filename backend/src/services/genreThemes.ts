/**
 * The themes of the closed list (`autoPlaylistTitle.ts`) that NAME a genre the metadata of the songs knows. Their playlist is a RULE on the genre
 * (a dynamic playlist: every song that has the tag, the last added first), not a list of the songs of some posts.
 *
 * Michele, 10 November (after the first application of the automatic playlists): «"Soul da ascoltare" mi aspetto che sia una dinamica deve avere
 * il tag soul la canzone. oppure tutto il soul deve conferire in quella play list.» (ADR-0024, spec 2026-11-10-auto-playlists-and-playlist-list-design.md §3.A.12)
 *
 * The genres are the CANONICAL ones of `utils/genres.ts` (what the genre chips of the Songs page and the dynamic playlists work with). A theme the
 * metadata has NO tag for (Synthwave, Darkwave, Italo disco, Disco, Lo-fi, Musica italiana, the decades) is not here: it stays a list of the songs of
 * the posts that fed it. The same goes for the occasions («Musica per la notte») and for the free titles of the lists.
 */
import { canonicalGenres } from '../utils/genres';
import { parseRule, type DynamicRule } from './dynamicRules';

/** What every theme title of the closed list ends with. */
export const THEME_SUFFIX = ' da ascoltare';

/** A playlist of a genre shows at most this many songs (the largest a dynamic rule can ask for). */
export const GENRE_PLAYLIST_LIMIT = 200;

/** The word of the theme (the part before « da ascoltare») → the canonical genres whose songs belong to it. */
export const GENRE_OF_THEME: Readonly<Record<string, readonly string[]>> = {
  Jazz: ['Jazz'],
  Rock: ['Rock', 'Hard Rock'],
  Pop: ['Pop'],
  Elettronica: ['Elettronica'],
  House: ['House', 'Techno/House'],
  Techno: ['Techno', 'Techno/House'],
  'Hip hop': ['Hip-Hop/Rap'],
  Rap: ['Hip-Hop/Rap'],
  'R&B': ['R&B/Soul'],
  Soul: ['R&B/Soul'],
  Funk: ['Funk'],
  Blues: ['Blues'],
  Metal: ['Metal'],
  Punk: ['Punk'],
  Indie: ['Indie Pop', 'Indie Rock'],
  Folk: ['Folk'],
  Reggae: ['Reggae'],
  Latina: ['Latina'],
  Classica: ['Classica'],
  'Colonne sonore': ['Colonne sonore'],
  Cantautori: ['Cantautori'],
  Ambient: ['Ambient'],
  Dance: ['Dance'],
};

/** The canonical genres a theme title names («Soul da ascoltare» → R&B/Soul), or null when the title is not a theme of a genre. */
export function genresOfThemeTitle(title: string): string[] | null {
  const trimmed = title.trim();
  if (!trimmed.endsWith(THEME_SUFFIX)) return null;
  const word = trimmed.slice(0, -THEME_SUFFIX.length).trim();
  const genres = Object.prototype.hasOwnProperty.call(GENRE_OF_THEME, word) ? GENRE_OF_THEME[word] : undefined;
  return genres ? [...genres] : null;
}

/**
 * ONE theme per set of genres: «Rap da ascoltare» and «Hip hop da ascoltare» are the same playlist, «R&B» and «Soul» too. It is the `theme_key` of the
 * playlist, so the unique index of the database makes it true even when two runs overlap.
 */
export function genreThemeKey(genres: readonly string[]): string {
  return `genre:${canonicalGenres(genres).join('+')}`;
}

/** The rule of the playlist of a genre: every song with the tag, the last added first, for the owner. Always a rule `parseRule` keeps as it is. */
export function genreRule(genres: readonly string[]): DynamicRule {
  const parsed = parseRule({ v: 1, scope: 'me', period: 'all', order: 'newest', limit: GENRE_PLAYLIST_LIMIT, minPlays: 1, genres: [...genres], downloadedOnly: false });
  if (!parsed.ok) throw new Error(`genre rule is not a rule: ${parsed.error}`);
  return parsed.rule;
}
