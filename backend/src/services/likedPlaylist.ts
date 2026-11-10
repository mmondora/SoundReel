/**
 * The playlist «Mi piace» (Michele, 10 November: «1 si»; ADR-0028, spec 2026-11-10-mondrop-like-and-repeat-design.md L7): the songs a person liked, the most
 * recently liked first. It is DYNAMIC (a rule of `dynamicRules.ts`, evaluated at read time: `order: 'liked'`), automatic, ONE per person, made at his FIRST like
 * (never an empty one) and never made again when he deletes it.
 *
 * It is made by the same place that makes the other automatic playlists (`createPlaylist` of the store and the registry of themes): the unique index
 * `(owner, theme_key)` makes «one per person» true even when two likes arrive together, and a theme in the registry with no playlist means «deleted by
 * the user». It is a THEME of the registry only for that: no post made it (`sourceEntryId` null), and `autoPlaylists.ts` never offers it to a post.
 *
 * The rule of two songs (`MIN_PLAYLIST_SONGS`, ADR-0024) is about the playlists made from the POSTS; this one is born with one song, as Michele asked.
 */
import type { AutoPlaylistStore } from './autoPlaylists';
import { parseRule, type DynamicRule } from './dynamicRules';

/** The `theme_key` of the playlist, per person. A key no post theme can have (those are words of a title or `genre:…`). */
export const LIKED_THEME_KEY = 'liked';
export const LIKED_PLAYLIST_NAME = 'Mi piace';
/** The most a rule can ask for. */
export const LIKED_PLAYLIST_LIMIT = 200;

/** The rule of the playlist: always a rule `parseRule` keeps as it is. */
export function likedRule(): DynamicRule {
  const parsed = parseRule({ v: 1, scope: 'me', period: 'all', order: 'liked', limit: LIKED_PLAYLIST_LIMIT, minPlays: 1, downloadedOnly: false });
  if (!parsed.ok) throw new Error(`liked rule is not a rule: ${parsed.error}`);
  return parsed.rule;
}

export type LikedPlaylistOutcome =
  | { status: 'made' | 'there'; id: string }
  | { status: 'skipped'; reason: 'deleted' | 'no_owner' };

/**
 * Makes the playlist for this person if it is not there and was never deleted. Throws what the store throws: the caller (the route of the like) turns it into
 * a warning, because a like never fails for its playlist.
 */
export async function ensureLikedPlaylist(
  store: Pick<AutoPlaylistStore, 'listThemes' | 'createPlaylist'>,
  input: { owner: string; at: Date },
): Promise<LikedPlaylistOutcome> {
  const owner = input.owner.trim();
  if (!owner || owner === 'anonymous') return { status: 'skipped', reason: 'no_owner' };

  const known = (await store.listThemes(owner)).find((t) => t.themeKey === LIKED_THEME_KEY);
  if (known) return known.playlistId ? { status: 'there', id: known.playlistId } : { status: 'skipped', reason: 'deleted' };

  const made = await store.createPlaylist({
    owner, name: LIKED_PLAYLIST_NAME, kind: 'theme', themeKey: LIKED_THEME_KEY, sourceEntryId: null, createdAt: input.at, rule: likedRule(),
  });
  return { status: made.created ? 'made' : 'there', id: made.id };
}
