/**
 * What a client (Mondrop, the web player) needs to know about a song's MP3, and the actions that get
 * one made. Contract: docs/mondrop-sync.md.
 *
 * A song's file comes from, in order: a file we already have (the music library; the media server's own file,
 * which the song simply IS — never copied, ADR-0010) and only then a download from YouTube. State is read from
 * `song_files` + the disk; nothing here downloads —
 * "prepare" only puts songs in the queue that services/songDownloader.ts drains.
 *
 *   ready      the file exists and can be fetched now
 *   preparing  queued / downloading on the server (or Spooty is still on it)
 *   failed     an error that can be retried
 *   no_source  no video found: a person has to supply a YouTube link
 *   missing    never asked for
 */
import { getEntry } from '../utils/db';
import { albumOf, genresOf, yearOf } from './libraryFacets';
import { getPlaylist } from './playlists';
import { resolveDetail } from './playlistResolver';
import { getSongPlayStats } from './listeningStats';
import { getUserSongs } from './userSongs';
import { findLibraryMatch, findMediaServerMatch } from './fileResolver';
import { mediaUrlForVolumePath, volumePathFromUrl } from './mediaServer';
import { absFromRel, fileFacts, fileVersion, type FileFacts } from './musicStore';
import type { FileOrigin } from './songStream';
import {
  enqueueSongDownload,
  getSongFile,
  getSongFiles,
  markReady,
  PRIORITY_PLAY,
  PRIORITY_SYNC,
  resetToQueued,
  setVideoOverride,
  type SongFile,
  type SongFileSource,
} from './songFiles';
import { listOpenSpootyEntryIds } from './spootyRequests';
import { wakeSongDownloader } from './songDownloader';
import { postToSpooty } from './spootyClient';
import { rebuildLocalPaths } from './localMedia';
import type { AggregatedSong } from '../types';

export type TrackState = 'ready' | 'preparing' | 'failed' | 'no_source' | 'missing';
export type TrackSource = 'library' | 'ytdlp' | 'existing' | 'none';

export interface OfflineTrack {
  songKey: string;
  title: string;
  artist: string;
  /** Album (the provider's name when known, else the mention's): what a client groups and filters by. */
  album: string | null;
  /** Canonical genre names (the "tipo"), sorted; empty when unknown. */
  genres: string[];
  /** Release year (ADR-0013); null = unknown. A decade is `year / 10 * 10`. */
  year: number | null;
  /** Legacy (apps already installed): `ready` only when `state` is, else `missing`. */
  status: 'ready' | 'missing';
  state: TrackState;
  source: TrackSource;
  /** Relative API path to download (prefix with the backend base URL); always valid when `ready`. */
  downloadPath: string | null;
  /** Direct URL on the home media server, LAN only, present only once the replica was verified there. */
  mediaUrl: string | null;
  /** Changes when the file changes: a client that already has this version skips the download. */
  version: string | null;
  bytes: number | null;
  durationS: number | null;
  error: string | null;
  spotifyUrl: string | null;
  entryId: string | null;
  canEnqueueSpooty: boolean;
  coverUrl: string | null;
  /** Optional lyrics / transcript snippet when known. */
  lyrics: string | null;
  /** Counted plays of this user on ALL devices, ever (docs/mondrop-stats.md §3): the phone ranks "least played" with it. */
  plays: number;
  /** Last counted play of this user (ISO, UTC), or null. */
  lastPlayedAt: string | null;
}

export interface OfflineManifest {
  playlistId: string;
  name: string;
  tracks: OfflineTrack[];
  readyCount: number;
  /** Everything that is not ready (compat with older apps). */
  missingCount: number;
  preparingCount: number;
  failedCount: number;
  /** True for a dynamic playlist: its songs were computed from the rule just now (docs/mondrop-stats.md §4). */
  dynamic?: boolean;
  /** When a dynamic playlist's songs were computed (ISO, UTC). */
  generatedAt?: string;
}

export const songFilePath = (songKey: string): string => `/api/mondrop/songs/${encodeURIComponent(songKey)}/file`;

// ---------------------------------------------------------------------------
// Lyrics (a transcript snippet from the entries that mention the song), cached: a client polling while
// songs are being prepared would otherwise re-read the same entries every few seconds.
// ---------------------------------------------------------------------------

const LYRICS_TTL_MS = 10 * 60_000;
const lyricsCache = new Map<string, { at: number; text: string | null }>();

async function transcriptOf(entryId: string): Promise<string | null> {
  const hit = lyricsCache.get(entryId);
  if (hit && Date.now() - hit.at < LYRICS_TTL_MS) return hit.text;
  const entry = await getEntry(entryId);
  const t = entry?.results?.transcript?.trim();
  const text = t && t.length > 20 ? t.slice(0, 8000) : null;
  lyricsCache.set(entryId, { at: Date.now(), text });
  return text;
}

async function lyricsForSong(song: AggregatedSong): Promise<string | null> {
  for (const m of song.mentions.slice(0, 3)) {
    const t = await transcriptOf(m.entryId);
    if (t) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolving one song
// ---------------------------------------------------------------------------

/** A song's file on the media server: the box's own file (adopted) or our replica once it was verified there. */
export interface MediaLocation {
  url: string;
  /** Path on the box's volume, as its URLs carry it. */
  volumeRel: string;
}

export function mediaOfRow(row: SongFile | null): MediaLocation | null {
  if (!row || row.status !== 'ready') return null;
  if (row.mediaRelPath) return { volumeRel: row.mediaRelPath, url: row.mediaUrl ?? mediaUrlForVolumePath(row.mediaRelPath) };
  if (row.mediaUrl && row.publishedAt) {
    const volumeRel = volumePathFromUrl(row.mediaUrl);
    return volumeRel ? { volumeRel, url: row.mediaUrl } : null;
  }
  return null;
}

/** The API keeps its documented vocabulary: a media-server file reads as the older `existing` ("reused"). */
const trackSource = (s: SongFileSource | 'none'): TrackSource => (s === 'mediaserver' ? 'existing' : s);

interface Resolved {
  state: TrackState;
  source: SongFileSource | 'none';
  facts: FileFacts | null;
  relPath: string | null;
  /** The song's file on the media server, when it has one. */
  media: MediaLocation | null;
  row: SongFile | null;
  error: string | null;
  /** The file we recorded is gone from the disk. */
  vanished: boolean;
}

async function resolveSong(song: AggregatedSong, row: SongFile | null, awaitingSpooty: boolean): Promise<Resolved> {
  let vanished = false;

  if (row?.status === 'ready' && row.relPath) {
    const abs = absFromRel(row.relPath);
    const facts = abs ? await fileFacts(abs) : null;
    if (facts) {
      return { state: 'ready', source: row.source ?? 'library', facts, relPath: row.relPath, media: mediaOfRow(row), row, error: null, vanished: false };
    }
    vanished = true;
  }

  // The song IS a file of the media server (no local file): its size and date are recorded on the row.
  if (row?.status === 'ready' && !row.relPath && row.bytes) {
    const media = mediaOfRow(row);
    if (media) {
      const facts = { bytes: row.bytes, mtimeMs: row.mtimeMs ?? 0 };
      return { state: 'ready', source: row.source ?? 'mediaserver', facts, relPath: null, media, row, error: null, vanished: false };
    }
  }

  const lib = await findLibraryMatch(song.artist, song.title);
  if (lib) {
    return { state: 'ready', source: 'library', facts: lib.facts, relPath: lib.relPath, media: mediaOfRow(row), row, error: null, vanished: false };
  }

  const base = { facts: null, relPath: null, media: null, row, vanished };
  if (row?.status === 'queued' || row?.status === 'downloading') {
    return { ...base, state: 'preparing', source: 'none', error: null };
  }
  if (row?.status === 'failed') return { ...base, state: 'failed', source: 'none', error: row.error };
  if (row?.status === 'no_source') return { ...base, state: 'no_source', source: 'none', error: row.error };
  if (awaitingSpooty) return { ...base, state: 'preparing', source: 'none', error: null };
  return { ...base, state: 'missing', source: 'none', error: vanished ? 'file non più presente' : null };
}

function toTrack(song: AggregatedSong, r: Resolved, lyrics: string | null): OfflineTrack {
  const ready = r.state === 'ready' && r.facts !== null;
  // The replica only counts while it is the same file we have.
  const replicaOk = ready && r.row?.mediaUrl && r.row.publishedAt && r.row.bytes === r.facts?.bytes;
  return {
    songKey: song.songKey,
    title: song.title,
    artist: song.artist,
    album: albumOf(song),
    genres: genresOf(song),
    year: yearOf(song),
    status: ready ? 'ready' : 'missing',
    state: r.state,
    source: trackSource(r.source),
    downloadPath: ready ? songFilePath(song.songKey) : null,
    mediaUrl: replicaOk ? r.row!.mediaUrl : null,
    version: ready ? fileVersion(r.facts!) : null,
    bytes: ready ? r.facts!.bytes : null,
    durationS: r.row?.durationS ?? null,
    error: ready ? null : r.error,
    spotifyUrl: song.spotifyUrl,
    entryId: song.mentions[0]?.entryId ?? null,
    canEnqueueSpooty: !!song.spotifyUrl,
    coverUrl: song.meta?.coverUrl ?? r.row?.coverUrl ?? null,
    lyrics,
    plays: 0,
    lastPlayedAt: null,
  };
}

/** The user's own listening numbers on each track (one query); a failure only costs the numbers, never the manifest. */
async function withPlayStats<T extends OfflineTrack>(tracks: T[], userId: string): Promise<T[]> {
  const stats = await getSongPlayStats(userId, [...new Set(tracks.map((t) => t.songKey))]).catch(() => null);
  if (!stats) return tracks;
  return tracks.map((t) => {
    const s = stats.get(t.songKey);
    return s ? { ...t, plays: s.plays, lastPlayedAt: s.lastPlayedAt } : t;
  });
}

const placeholderTrack = (songKey: string): OfflineTrack => ({
  songKey, title: songKey, artist: '', album: null, genres: [], year: null, status: 'missing', state: 'missing', source: 'none', downloadPath: null, mediaUrl: null,
  version: null, bytes: null, durationS: null, error: null, spotifyUrl: null, entryId: null, canEnqueueSpooty: false,
  coverUrl: null, lyrics: null, plays: 0, lastPlayedAt: null,
});

const countsOf = (tracks: OfflineTrack[]) => ({
  readyCount: tracks.filter((t) => t.state === 'ready').length,
  missingCount: tracks.filter((t) => t.state !== 'ready').length,
  preparingCount: tracks.filter((t) => t.state === 'preparing').length,
  failedCount: tracks.filter((t) => t.state === 'failed' || t.state === 'no_source').length,
});

/** Entries (of these songs) whose Spotify link Spooty is still downloading. */
async function openSpootyEntries(songs: AggregatedSong[]): Promise<Set<string>> {
  return listOpenSpootyEntryIds([...new Set(songs.flatMap((s) => s.mentions.map((m) => m.entryId)))]);
}

const awaiting = (song: AggregatedSong, open: Set<string>): boolean => song.mentions.some((m) => open.has(m.entryId));

/** The song for this user: from the short-lived cache, else once more from the journal (an entry created seconds ago). */
async function findSong(songKey: string, ownerUser: string, isAdmin: boolean): Promise<AggregatedSong | undefined> {
  const cached = (await getUserSongs(ownerUser, isAdmin)).get(songKey);
  if (cached) return cached;
  return (await getUserSongs(ownerUser, isAdmin, 0)).get(songKey);
}

// ---------------------------------------------------------------------------
// Making files happen
// ---------------------------------------------------------------------------

/** After a failure, a "play" request does not hammer YouTube again before this long. */
const PLAY_RETRY_COOLDOWN_MS = 10 * 60_000;

interface PrepareOptions {
  user: string;
  priority: number;
  /** Put failed / no_source songs back in the queue. */
  retry: boolean;
  awaitingSpooty: boolean;
}

async function ensurePrepared(song: AggregatedSong, row: SongFile | null, opts: PrepareOptions): Promise<void> {
  const r = await resolveSong(song, row, opts.awaitingSpooty);

  if (r.state === 'ready') {
    // Library hits get a row too, so their replica on the media server can be verified and published.
    if (r.source === 'library' && r.relPath && r.facts && (row?.status !== 'ready' || row.relPath !== r.relPath)) {
      await markReady(
        song.songKey,
        { source: 'library', relPath: r.relPath, bytes: r.facts.bytes, mtimeMs: r.facts.mtimeMs, match: 'name' },
        { artist: song.artist, title: song.title, album: song.album, coverUrl: song.meta?.coverUrl ?? null },
      );
    }
    return;
  }

  if (r.vanished) await resetToQueued(song.songKey); // somebody deleted the file: it becomes a job again
  if (opts.awaitingSpooty && !row) return; // Spooty is delivering it; a YouTube copy would only duplicate

  let retry = opts.retry;
  if (opts.priority >= PRIORITY_PLAY && (row?.status === 'failed' || row?.status === 'no_source')) {
    const sinceLastTry = Date.now() - row.updatedAt.getTime();
    retry = retry || sinceLastTry > PLAY_RETRY_COOLDOWN_MS; // somebody waits: try again, but not on every click
  }

  await enqueueSongDownload({
    songKey: song.songKey,
    artist: song.artist,
    title: song.title,
    album: song.album,
    coverUrl: song.meta?.coverUrl ?? null,
    requestedBy: opts.user,
    priority: opts.priority,
    retry,
  });
  wakeSongDownloader();
}

// ---------------------------------------------------------------------------
// Public API (routes)
// ---------------------------------------------------------------------------

export async function buildPlaylistOfflineManifest(
  playlistId: string,
  ownerUser: string,
  isAdmin = false,
  options: { lyrics?: boolean } = {},
): Promise<OfflineManifest | null> {
  const stored = await getPlaylist(playlistId, { userId: ownerUser, isAdmin });
  if (!stored) return null;
  // a dynamic playlist holds what its rule selects NOW, for this viewer (ADR-0008): every sync downloads what is true today
  const playlist = await resolveDetail(stored, { userId: ownerUser, isAdmin });

  const songs = await getUserSongs(ownerUser, isAdmin);
  const known = playlist.songKeys.map((k) => songs.get(k)).filter((s): s is AggregatedSong => !!s);
  const [rows, open] = await Promise.all([getSongFiles(playlist.songKeys), openSpootyEntries(known)]);

  const built: OfflineTrack[] = [];
  for (const key of playlist.songKeys) {
    const song = songs.get(key);
    if (!song) {
      built.push(placeholderTrack(key));
      continue;
    }
    const resolved = await resolveSong(song, rows.get(key) ?? null, awaiting(song, open));
    built.push(toTrack(song, resolved, options.lyrics === false ? null : await lyricsForSong(song)));
  }
  const tracks = await withPlayStats(built, ownerUser);
  return {
    playlistId: playlist.id,
    name: playlist.name,
    tracks,
    ...countsOf(tracks),
    ...(playlist.kind === 'dynamic' ? { dynamic: true, generatedAt: playlist.generatedAt } : {}),
  };
}

/**
 * The tracks (state, version, plays, facets) of these songs, in the order given: what `GET /api/mondrop/library`
 * sends for one page. Reads only; nothing is queued. Lyrics are left out unless asked for (a list does not need them).
 */
export async function buildTracks(
  songs: AggregatedSong[],
  ownerUser: string,
  options: { lyrics?: boolean } = {},
): Promise<OfflineTrack[]> {
  if (songs.length === 0) return [];
  const [rows, open] = await Promise.all([getSongFiles(songs.map((s) => s.songKey)), openSpootyEntries(songs)]);
  const built: OfflineTrack[] = [];
  for (const song of songs) {
    const resolved = await resolveSong(song, rows.get(song.songKey) ?? null, awaiting(song, open));
    built.push(toTrack(song, resolved, options.lyrics === true ? await lyricsForSong(song) : null));
  }
  return withPlayStats(built, ownerUser);
}

/** Queue everything in the playlist that is not ready yet, then report the new state. Returns fast. */
export async function preparePlaylist(
  playlistId: string,
  ownerUser: string,
  isAdmin = false,
  options: { retryFailed?: boolean; lyrics?: boolean } = {},
): Promise<OfflineManifest | null> {
  const stored = await getPlaylist(playlistId, { userId: ownerUser, isAdmin });
  if (!stored) return null;
  const playlist = await resolveDetail(stored, { userId: ownerUser, isAdmin }); // dynamic: the songs of the rule, now

  const songs = await getUserSongs(ownerUser, isAdmin);
  const known = playlist.songKeys.map((k) => songs.get(k)).filter((s): s is AggregatedSong => !!s);
  const [rows, open] = await Promise.all([getSongFiles(playlist.songKeys), openSpootyEntries(known)]);

  for (const song of known) {
    await ensurePrepared(song, rows.get(song.songKey) ?? null, {
      user: ownerUser,
      priority: PRIORITY_SYNC,
      retry: options.retryFailed === true,
      awaitingSpooty: awaiting(song, open),
    });
  }
  return buildPlaylistOfflineManifest(playlistId, ownerUser, isAdmin, { lyrics: options.lyrics });
}

export async function getTrack(songKey: string, ownerUser: string, isAdmin = false): Promise<OfflineTrack | null> {
  const song = await findSong(songKey, ownerUser, isAdmin);
  if (!song) return null;
  const open = await openSpootyEntries([song]);
  const resolved = await resolveSong(song, await getSongFile(songKey), awaiting(song, open));
  const [track] = await withPlayStats([toTrack(song, resolved, await lyricsForSong(song))], ownerUser);
  return track;
}

/** One song, now. `play` = somebody is waiting: it jumps the whole sync queue. */
export async function requestSongDownload(
  songKey: string,
  ownerUser: string,
  options: { priority?: 'play' | 'sync'; retry?: boolean; isAdmin?: boolean } = {},
): Promise<OfflineTrack | null> {
  const song = await findSong(songKey, ownerUser, options.isAdmin ?? false);
  if (!song) return null;
  const open = await openSpootyEntries([song]);
  await ensurePrepared(song, await getSongFile(songKey), {
    user: ownerUser,
    priority: options.priority === 'play' ? PRIORITY_PLAY : PRIORITY_SYNC,
    retry: options.retry === true,
    awaitingSpooty: awaiting(song, open),
  });
  return getTrack(songKey, ownerUser, options.isAdmin ?? false);
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** True for a plain link to one YouTube video (never an arbitrary URL: the sidecar fetches it). */
export function isYoutubeVideoUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) return false;
    if (u.hostname.toLowerCase() === 'youtu.be') return VIDEO_ID.test(u.pathname.split('/').filter(Boolean)[0] ?? '');
    if (u.pathname === '/watch') return VIDEO_ID.test(u.searchParams.get('v') ?? '');
    return /^\/(?:shorts|embed|live|v)\/[A-Za-z0-9_-]{11}(?:[/?#]|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Force the source of a song (a wrong version, or no source found): it goes back in the queue at once. */
export async function setSongSource(
  songKey: string,
  ownerUser: string,
  youtubeUrl: string,
  isAdmin = false,
): Promise<{ ok: true } | { ok: false; reason: 'song_not_found' | 'bad_url' }> {
  if (!isYoutubeVideoUrl(youtubeUrl)) return { ok: false, reason: 'bad_url' };
  const song = await findSong(songKey, ownerUser, isAdmin);
  if (!song) return { ok: false, reason: 'song_not_found' };
  await enqueueSongDownload({
    songKey,
    artist: song.artist,
    title: song.title,
    album: song.album,
    coverUrl: song.meta?.coverUrl ?? null,
    requestedBy: ownerUser,
    priority: PRIORITY_PLAY,
    retry: true,
  });
  await setVideoOverride(songKey, youtubeUrl.trim());
  wakeSongDownloader();
  return { ok: true };
}

/** Which origin comes first when a song can be served from more than one place. */
export type ServeOrder = ReadonlyArray<FileOrigin['kind']>;
/** Web player: the media server first, the disk as the fallback (spec W5/S4). */
export const ORDER_WEB: ServeOrder = ['media', 'local'];
/** Mondrop: the disk first (the origin, nearest), the media server as the fallback. */
export const ORDER_MONDROP: ServeOrder = ['local', 'media'];

export interface ServedSong {
  filename: string;
  /** Changes when the file changes; a client that already has this version skips the transfer. */
  version: string;
  title: string;
  artist: string;
  /** In the order asked for; never empty. */
  origins: FileOrigin[];
}

export type Serving = { ok: true; served: ServedSong } | { ok: false; reason: 'song_not_found' | 'file_not_ready' };

/**
 * Where to read a song's bytes from, in the order asked for; says why when there is nothing. The media origin also
 * covers a song that is on the box but nobody has asked a download for yet (the catalogue knows it): no copy, no
 * database write — it simply plays from there.
 */
export async function resolveSongServing(
  songKey: string,
  ownerUser: string,
  isAdmin = false,
  order: ServeOrder = ORDER_WEB,
): Promise<Serving> {
  const song = await findSong(songKey, ownerUser, isAdmin);
  if (!song) return { ok: false, reason: 'song_not_found' };
  const resolved = await resolveSong(song, await getSongFile(songKey), false);

  const have: Partial<Record<FileOrigin['kind'], FileOrigin>> = {};
  if (resolved.state === 'ready' && resolved.relPath) {
    const absPath = absFromRel(resolved.relPath);
    if (absPath) have.local = { kind: 'local', absPath };
  }
  let mediaRel = resolved.media?.volumeRel ?? null;
  if (resolved.media) have.media = { kind: 'media', url: resolved.media.url };
  let bytes = resolved.facts?.bytes ?? null;
  if (!have.media && order.includes('media')) {
    const hit = await findMediaServerMatch(song.artist, song.title).catch(() => null);
    if (hit) {
      have.media = { kind: 'media', url: mediaUrlForVolumePath(hit.relPath) };
      mediaRel = hit.relPath;
      bytes = bytes ?? hit.bytes;
    }
  }

  const origins = order.map((kind) => have[kind]).filter((o): o is FileOrigin => !!o);
  if (origins.length === 0) return { ok: false, reason: 'file_not_ready' };
  const named = resolved.relPath ?? mediaRel;
  return {
    ok: true,
    served: {
      filename: named?.split('/').pop() || `${song.artist} - ${song.title}.mp3`,
      version: resolved.facts ? fileVersion(resolved.facts) : `${bytes ?? 0}-0`,
      title: song.title,
      artist: song.artist,
      origins,
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy helpers still used by the routes
// ---------------------------------------------------------------------------

export async function enqueueSongToSpooty(
  songKey: string,
  ownerUser: string,
  isAdmin = false,
): Promise<{ ok: boolean; reason?: string }> {
  const song = await findSong(songKey, ownerUser, isAdmin);
  if (!song) return { ok: false, reason: 'song_not_found' };
  if (!song.spotifyUrl) return { ok: false, reason: 'no_spotify_url' };
  const sent = await postToSpooty(song.spotifyUrl);
  return sent ? { ok: true } : { ok: false, reason: 'spooty_failed' };
}

export async function resolveEntryMediaAbs(
  entryId: string,
  kind: 'audio' | 'video',
): Promise<{ absPath: string; filename: string; contentType: string } | null> {
  const paths = await rebuildLocalPaths(entryId);
  if (!paths) return null;
  if (kind === 'audio' && paths.audioPath) {
    return { absPath: paths.audioPath, filename: 'audio.wav', contentType: 'audio/wav' };
  }
  if (kind === 'video' && paths.videoPath) {
    return { absPath: paths.videoPath, filename: 'video.mp4', contentType: 'video/mp4' };
  }
  // Prefer audio if kind omitted weirdly
  if (paths.audioPath) {
    return { absPath: paths.audioPath, filename: 'audio.wav', contentType: 'audio/wav' };
  }
  if (paths.videoPath) {
    return { absPath: paths.videoPath, filename: 'video.mp4', contentType: 'video/mp4' };
  }
  return null;
}
