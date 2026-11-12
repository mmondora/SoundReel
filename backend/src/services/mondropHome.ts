/**
 * The front page of Mondrop (ADR-0020, spec 2026-11-08-mondrop-home-spotify-design.md): the SECTIONS, ready to draw.
 *
 * The server decides which sections exist, in what order, with what title and with which songs (rule P: the app draws what it
 * gets and computes nothing); a section with nothing in it is not sent, and one that fails costs only itself. The songs are
 * the same objects as in the library and in «Cerca» (`buildTracks`): state, `coverPath`, `downloadPath`, `mediaUrl: null`.
 *
 * Two sections: «Le tue playlist» and «Nuovi dai tuoi reel». There is NO «Ascoltati di recente» since 2.27.0 (Michele, 12 November:
 * «gli Ascoltati di recente non mi interessano in homepage»; spec 2026-11-12-mondrop-home-play-loop-reels-design.md M3).
 *
 * Reads only: nothing is queued and nothing is recorded. «Riprendi» is not here: it is the phone's own queue.
 */
import type { AggregatedSong, PlaylistSummary } from '../types';
import { FAMILY_DISPLAY, normalizeFamilyUser } from '../utils/requestUser';
import { logError } from '../utils/logger';
import { firstSongKeys, listPlaylists } from './playlists';
import { resolveSongKeys, resolveSummaries } from './playlistResolver';
import { getUserSongs } from './userSongs';
import { buildTracks, type OfflineTrack } from './offlineManifest';
import { getPlayedSongKeys } from './listeningStats';

/** How much each section carries: the Home is a front page, not a catalogue (Cerca and the Playlist tab hold the rest). */
export const HOME_LIMITS = { playlists: 12, fresh: 20, coverKeys: 4 } as const;

export interface HomePlaylist {
  id: string;
  name: string;
  songCount: number;
  createdAt: string;
  updatedAt: string;
  kind: 'static' | 'dynamic';
  ruleSummary: string | null;
  /** Only the user's OWN static playlists take songs by hand (same meaning as in `GET /api/mondrop/playlists`). */
  canEdit: boolean;
  /** Up to four song keys for the mosaic of the cover; the app asks for the covers as always. */
  coverKeys: string[];
}

export type HomeSection =
  | { id: 'playlists'; title: string; kind: 'playlists'; playlists: HomePlaylist[] }
  | { id: 'fresh'; title: string; kind: 'tracks'; tracks: OfflineTrack[] };

export interface HomeResponse {
  user: string;
  /** The name the app greets with (Michele, Archimede, Sara), or null for a user it does not know. */
  displayName: string | null;
  sections: HomeSection[];
}

type StoredPlaylist = PlaylistSummary & { ownerUser?: string };

/** What the Home reads, injectable so the rules can be tested without a database. */
export interface HomeDeps {
  /** The playlists the user sees (own and shared), newest first, dynamic ones with the count of what their rule selects now. */
  playlists(userId: string): Promise<StoredPlaylist[]>;
  coverKeys(playlists: StoredPlaylist[], userId: string): Promise<Map<string, string[]>>;
  /** Every song the user has a counted play of: what «Nuovi dai tuoi reel» leaves out. */
  playedKeys(userId: string): Promise<Set<string>>;
  /** The user's journal songs. */
  journal(userId: string): Promise<Map<string, AggregatedSong>>;
  tracks(songs: AggregatedSong[], userId: string): Promise<OfflineTrack[]>;
}

export const realHomeDeps: HomeDeps = {
  async playlists(userId) {
    const viewer = { userId, isAdmin: false };
    return (await resolveSummaries(await listPlaylists(viewer), viewer)) as StoredPlaylist[];
  },
  async coverKeys(playlists, userId) {
    const viewer = { userId, isAdmin: false };
    const out = await firstSongKeys(
      playlists.filter((p) => p.kind !== 'dynamic').map((p) => p.id),
      HOME_LIMITS.coverKeys,
    );
    for (const playlist of playlists) {
      if (playlist.kind !== 'dynamic') continue;
      const { songKeys } = await resolveSongKeys(playlist, viewer);   // cached for a minute by the resolver
      out.set(playlist.id, songKeys.slice(0, HOME_LIMITS.coverKeys));
    }
    return out;
  },
  playedKeys: getPlayedSongKeys,
  journal: (userId) => getUserSongs(userId, false),
  tracks: (songs, userId) => buildTracks(songs, userId),
};

export function displayNameOf(userId: string): string | null {
  const family = normalizeFamilyUser(userId);
  return family ? FAMILY_DISPLAY[family] : null;
}

/** The most recent post that mentions the song, as milliseconds (0 when no mention has a readable date). */
function latestMentionMs(song: AggregatedSong): number {
  let best = 0;
  for (const mention of song.mentions) {
    const at = Date.parse(mention.createdAt);
    if (Number.isFinite(at) && at > best) best = at;
  }
  return best;
}

async function playlistsSection(userId: string, deps: HomeDeps): Promise<HomeSection | null> {
  // A playlist with nothing to play is noise on a front page (the Playlist tab lists every one).
  const shown = (await deps.playlists(userId)).filter((p) => p.songCount > 0).slice(0, HOME_LIMITS.playlists);
  if (shown.length === 0) return null;
  // A failing mosaic costs the mosaic (the app draws its own tiles), not the playlists.
  const covers = await deps.coverKeys(shown, userId).catch((err) => {
    logError('home: playlist covers failed', { err: String(err) });
    return new Map<string, string[]>();
  });
  return {
    id: 'playlists',
    title: 'Le tue playlist',
    kind: 'playlists',
    playlists: shown.map((p) => ({
      id: p.id,
      name: p.name,
      songCount: p.songCount,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      kind: p.kind === 'dynamic' ? 'dynamic' : 'static',
      ruleSummary: p.ruleSummary ?? null,
      canEdit: p.kind !== 'dynamic' && p.ownerUser === userId,
      coverKeys: (covers.get(p.id) ?? []).slice(0, HOME_LIMITS.coverKeys),
    })),
  };
}

async function freshSection(userId: string, deps: HomeDeps): Promise<HomeSection | null> {
  const [journal, played] = await Promise.all([deps.journal(userId), deps.playedKeys(userId)]);
  const songs = [...journal.values()]
    .filter((song) => !played.has(song.songKey))
    .map((song) => ({ song, at: latestMentionMs(song) }))
    // The newest post first; the title only breaks a tie, so the order does not wobble between two requests.
    .sort((a, b) => b.at - a.at || a.song.title.localeCompare(b.song.title))
    .slice(0, HOME_LIMITS.fresh)
    .map((x) => x.song);
  if (songs.length === 0) return null;
  const tracks = await deps.tracks(songs, userId);
  return tracks.length > 0 ? { id: 'fresh', title: 'Nuovi dai tuoi reel', kind: 'tracks', tracks } : null;
}

async function guarded(id: string, build: () => Promise<HomeSection | null>): Promise<HomeSection | null> {
  try {
    return await build();
  } catch (err) {
    logError(`home: section ${id} failed`, { err: String(err) });
    return null;
  }
}

export async function buildHome(userId: string, deps: HomeDeps = realHomeDeps): Promise<HomeResponse> {
  const built = await Promise.all([
    guarded('playlists', () => playlistsSection(userId, deps)),
    guarded('fresh', () => freshSection(userId, deps)),
  ]);
  return {
    user: userId,
    displayName: displayNameOf(userId),
    sections: built.filter((section): section is HomeSection => section !== null),
  };
}
