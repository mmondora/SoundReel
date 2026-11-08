/**
 * Single entry point for links — used by Telegram, the Mondrop share endpoint and
 * the web client. Adapters only parse their own transport and format their own
 * reply; everything that decides what a link *does* lives here, so the three
 * channels cannot drift apart again.
 *
 *   Spotify track/album/playlist → journal entry (library) + Spooty download,
 *                                  tracked by the Spooty watcher until it finishes
 *   Shazam song link             → journal entry (library) read from the Shazam page, no job
 *   everything else              → stub entry + analysis job (as before)
 */
import type { ActionLogItem, Entry, SocialPlatform, Song } from '../types';
import { normalizeUrl } from './urlNormalize';
import { withEntryKeyLock } from '../utils/entryKeyLock';
import {
  findEntryByUrl,
  createEntry,
  updateEntry,
  appendActionLog,
  createActionLog,
} from '../utils/db';
import { mergeEntryResults } from './entryMerge';
import { enqueueSongEnrichment } from './songEnrichmentHook';
import { enqueueJob, type JobPlatform } from '../utils/jobQueue';
import {
  canonicalSpotifyUrl,
  isSpotifyShortLink,
  parseSpotifyLink,
  resolveSpotifyShortLink,
  type SpotifyRef,
} from './spotifyLink';
import {
  addToSpooty,
  findSpootyPlaylistByUrl,
  listSpootyTracks,
  retrySpootyTrack,
  SpootyStatus,
  type SpootyPlaylist,
  type SpootyTrack,
} from './spootyClient';
import { getSpootyRequestByEntry, insertSpootyRequest, patchSpootyRequest } from './spootyRequests';
import {
  fetchShazamTrack,
  parseShazamLink,
  ShazamFetchError,
  type ShazamRef,
  type ShazamTrackInfo,
} from './shazamLink';
import { songKey, setSongCoverIfMissing } from './songMeta';
import { logWarning } from '../utils/logger';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface LinkClass {
  kind: 'spotify' | 'shazam' | 'generic';
  platform: SocialPlatform;
  spotify?: SpotifyRef;
  shazam?: ShazamRef;
}

const HOST_PLATFORMS: Array<[string[], SocialPlatform]> = [
  [['instagram.com'], 'instagram'],
  [['tiktok.com'], 'tiktok'],
  [['youtube.com', 'youtu.be'], 'youtube'],
  [['twitter.com', 'x.com'], 'twitter'],
  [['reddit.com'], 'reddit'],
  [['facebook.com', 'fb.watch'], 'facebook'],
  [['threads.net'], 'threads'],
  [['vimeo.com'], 'vimeo'],
  [['soundcloud.com'], 'soundcloud'],
  [['linkedin.com'], 'linkedin'],
  [['spotify.com'], 'spotify'],
  [['shazam.com'], 'shazam'],
];

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Exact host matching (the old `includes('x.com')` also matched netflix.com). */
export function platformFromUrl(url: string): SocialPlatform {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    for (const [domains, platform] of HOST_PLATFORMS) {
      if (domains.some((d) => hostMatches(host, d))) return platform;
    }
  } catch {
    /* invalid URL → 'other' */
  }
  return 'other';
}

export function classifyLink(url: string): LinkClass {
  const spotify = parseSpotifyLink(url);
  if (spotify) return { kind: 'spotify', platform: 'spotify', spotify };
  const shazam = parseShazamLink(url);
  if (shazam) return { kind: 'shazam', platform: 'shazam', shazam };
  return { kind: 'generic', platform: platformFromUrl(url) };
}

/** Resolve Spotify short links, then classify. */
export async function resolveLink(url: string): Promise<{ url: string; cls: LinkClass }> {
  let resolved = url.trim();
  if (isSpotifyShortLink(resolved)) {
    const target = await resolveSpotifyShortLink(resolved);
    if (target) resolved = target;
  }
  return { url: resolved, cls: classifyLink(resolved) };
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface IngestInput {
  url: string;
  channel: 'telegram' | 'web' | 'ios';
  inputUser: string | null;
  ownerUser: string;
  /** Tags from the user's comment (already extracted by the adapter). */
  tags?: string[];
  /** Telegram chat: forwarded to the analysis job, and notified when a Spooty download ends. */
  chatId?: number;
  /** Analysis jobs only. Defaults to the queue's own default (notify). */
  notify?: boolean;
  /** Audit trail items only the adapter knows how to write. */
  logs?: {
    onNew?: ActionLogItem[];
    onExisting?: ActionLogItem[];
    /** Action name used when the comment carries tags (default `comment_tags`). */
    tagsAction?: string;
  };
}

export interface SpotifyIngestInfo {
  ref: SpotifyRef;
  title: string | null;
  artist: string | null;
  coverUrl: string | null;
  caption: string | null;
  trackCount: number;
  /** Spooty took the link (false = Spooty down; the watcher keeps retrying). */
  spootyAccepted: boolean;
  spootyPlaylistId: number | null;
  error: string | null;
}

export interface ShazamIngestInfo {
  ref: ShazamRef;
  title: string | null;
  artist: string | null;
  album: string | null;
  coverUrl: string | null;
  caption: string | null;
  /** Why the Shazam page could not be read (the link is stored anyway; sharing it again retries). */
  error: string | null;
}

export interface IngestResult {
  kind: 'spotify' | 'shazam' | 'generic';
  platform: SocialPlatform;
  entryId: string;
  existing: boolean;
  /** Generic: the analysis job entered the queue. Spotify: stored and tracked. Shazam: stored (read or flagged). */
  enqueued: boolean;
  tags: string[];
  spotify?: SpotifyIngestInfo;
  shazam?: ShazamIngestInfo;
}

export class IngestError extends Error {
  constructor(message: string, readonly entryId: string | null = null) {
    super(message);
    this.name = 'IngestError';
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Entry ⇄ Spooty mapping (shared with the watcher)
// ---------------------------------------------------------------------------

export function youtubeSearchUrl(artist: string, title: string): string {
  return `https://youtube.com/results?search_query=${encodeURIComponent(`${artist} ${title}`.trim())}`;
}

export function songsFromSpooty(tracks: SpootyTrack[], playlist: SpootyPlaylist | null, ref: SpotifyRef): Song[] {
  const songs: Song[] = [];
  for (const t of tracks) {
    const title = t.name.trim();
    if (!title) continue;
    songs.push({
      title,
      artist: t.artist.trim(),
      album: ref.kind === 'track' ? null : playlist?.name.trim() || null,
      source: 'spotify_link',
      spotifyUri: null,
      spotifyUrl: canonicalSpotifyUrl(t.spotifyUrl) ?? (t.spotifyUrl || null),
      youtubeUrl: youtubeSearchUrl(t.artist, title),
      soundcloudUrl: null,
      addedToPlaylist: false,
    });
  }
  return songs;
}

export function captionFor(ref: SpotifyRef, playlist: SpootyPlaylist | null, songs: Song[]): string {
  if (ref.kind === 'track' && songs[0]) {
    return songs[0].artist ? `${songs[0].artist} – ${songs[0].title}` : songs[0].title;
  }
  return playlist?.name.trim() || ref.url;
}

export interface SpootyState {
  accepted: boolean;
  playlist: SpootyPlaylist | null;
  tracks: SpootyTrack[];
  error: string | null;
}

/**
 * Make sure Spooty has this link (find before add, so a retry never duplicates)
 * and return what it knows. Never throws.
 */
export async function ensureAtSpooty(ref: SpotifyRef): Promise<SpootyState> {
  try {
    let playlist = await findSpootyPlaylistByUrl(ref.url);
    if (!playlist) {
      const added = await addToSpooty(ref.url);
      if (!added.ok) return { accepted: false, playlist: null, tracks: [], error: added.error };
      playlist = await findSpootyPlaylistByUrl(ref.url);
    }
    if (!playlist) return { accepted: true, playlist: null, tracks: [], error: null };
    const tracks = await listSpootyTracks(playlist.id);
    return { accepted: true, playlist, tracks, error: playlist.error };
  } catch (err) {
    return { accepted: false, playlist: null, tracks: [], error: errMsg(err) };
  }
}

/** Best effort: covers must never block an ingest. */
export async function persistCovers(tracks: SpootyTrack[], playlist: SpootyPlaylist | null, ref: SpotifyRef): Promise<void> {
  for (const t of tracks) {
    if (!t.name.trim()) continue;
    const cover = t.coverUrl ?? playlist?.coverUrl ?? null;
    const album = ref.kind === 'track' ? null : playlist?.name.trim() || null;
    try {
      await setSongCoverIfMissing(songKey(t.artist.trim(), t.name.trim()), cover, album);
    } catch (err) {
      logWarning('persistCovers failed', { err: errMsg(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// ingestLink
// ---------------------------------------------------------------------------

export async function ingestLink(input: IngestInput): Promise<IngestResult> {
  const { url, cls } = await resolveLink(input.url);
  // Look-up and creation run one at a time per (owner, post): two shares at the same instant make one entry.
  return withEntryKeyLock(input.ownerUser, url, async () => {
    if (cls.kind === 'spotify' && cls.spotify) return ingestSpotify(cls.spotify, input);
    if (cls.kind === 'shazam' && cls.shazam) return ingestShazam(cls.shazam, url, input);
    return ingestGeneric(url, cls.platform, input);
  });
}

/** Stub entry + analysis job: the flow Telegram and share used to implement twice. */
async function ingestGeneric(url: string, platform: SocialPlatform, input: IngestInput): Promise<IngestResult> {
  const normalized = normalizeUrl(url);
  const tags = input.tags ?? [];
  const tagsAction = input.logs?.tagsAction ?? 'comment_tags';
  const tagsLog = tags.length ? [createActionLog(tagsAction, { tags, channel: input.channel })] : [];

  let entryId: string;
  let existingEntry = false;
  try {
    const existing = await findEntryByUrl(normalized, input.ownerUser);
    if (existing) {
      existingEntry = true;
      entryId = existing.id;
      if (tags.length > 0) {
        const merged = mergeEntryResults(existing.results, {
          songs: [], films: [], notes: [], links: [], tags, summary: null,
        });
        await updateEntry(existing.id, { results: merged });
        for (const l of tagsLog) await appendActionLog(existing.id, l);
      }
      for (const l of input.logs?.onExisting ?? []) await appendActionLog(existing.id, l);
    } else {
      entryId = await createEntry({
        sourceUrl: normalized,
        sourcePlatform: platform,
        inputChannel: input.channel,
        inputUser: input.inputUser,
        ownerUser: input.ownerUser,
        caption: null,
        thumbnailUrl: null,
        mediaUrl: null,
        status: 'processing',
        results: { songs: [], films: [], notes: [], links: [], tags, summary: null },
        actionLog: [...(input.logs?.onNew ?? []), ...tagsLog],
      });
    }
  } catch (err) {
    throw new IngestError(errMsg(err));
  }

  const jobPlatform: JobPlatform = platform === 'instagram' ? 'instagram' : 'other';
  try {
    await enqueueJob({
      entryId,
      sourceUrl: url,
      platform: jobPlatform,
      chatId: input.chatId ?? 0,
      inputUser: input.inputUser,
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
    });
  } catch (err) {
    throw new IngestError(errMsg(err), entryId);
  }

  return { kind: 'generic', platform, entryId, existing: existingEntry, enqueued: true, tags };
}

/** Cover, genres and links for the songs a link brought in, like for every other song (fire and forget). */
const enrichSongs = (songs: Array<{ artist: string | null; title: string }>): void =>
  enqueueSongEnrichment(songs.map((s) => ({ artist: s.artist, title: s.title })));

async function ingestSpotify(ref: SpotifyRef, input: IngestInput): Promise<IngestResult> {
  const tags = input.tags ?? [];
  const tagsAction = input.logs?.tagsAction ?? 'comment_tags';
  const tagsLog = tags.length ? [createActionLog(tagsAction, { tags, channel: input.channel })] : [];

  let existing: Entry | null;
  try {
    existing = await findEntryByUrl(ref.url, input.ownerUser);
  } catch (err) {
    throw new IngestError(errMsg(err));
  }
  if (existing) return reingestSpotify(existing, ref, input, tags, tagsLog);

  // First attempt is synchronous so the reply can already name the track and show the cover.
  const sp = await ensureAtSpooty(ref);
  const songs = songsFromSpooty(sp.tracks, sp.playlist, ref);
  const caption = songs.length ? captionFor(ref, sp.playlist, songs) : sp.playlist?.name.trim() || null;

  let entryId: string;
  try {
    entryId = await createEntry({
      sourceUrl: ref.url,
      sourcePlatform: 'spotify',
      inputChannel: input.channel,
      inputUser: input.inputUser,
      ownerUser: input.ownerUser,
      caption,
      thumbnailUrl: sp.playlist?.coverUrl ?? sp.tracks[0]?.coverUrl ?? null,
      mediaUrl: null,
      status: 'processing',
      results: { songs, films: [], notes: [], links: [], tags, summary: null },
      actionLog: [
        ...(input.logs?.onNew ?? []),
        createActionLog('spotify_link_received', { kind: ref.kind, url: ref.url, channel: input.channel }),
        ...tagsLog,
        sp.accepted
          ? createActionLog('spooty_enqueued', { playlistId: sp.playlist?.id ?? null, tracks: sp.tracks.length })
          : createActionLog('spooty_enqueue_failed', { error: sp.error }),
      ],
    });
    await insertSpootyRequest({
      entryId,
      ownerUser: input.ownerUser,
      spotifyUrl: ref.url,
      kind: ref.kind,
      spootyPlaylistId: sp.playlist?.id ?? null,
      chatId: input.chatId ?? null,
      status: sp.accepted ? 'tracking' : 'queued',
    });
    enrichSongs(songs);
  } catch (err) {
    throw new IngestError(errMsg(err));
  }

  await persistCovers(sp.tracks, sp.playlist, ref);

  return {
    kind: 'spotify',
    platform: 'spotify',
    entryId,
    existing: false,
    enqueued: true,
    tags,
    spotify: infoFrom(ref, songs, caption, sp.playlist?.coverUrl ?? sp.tracks[0]?.coverUrl ?? null, sp),
  };
}

function infoFrom(
  ref: SpotifyRef,
  songs: Song[],
  caption: string | null,
  coverUrl: string | null,
  sp: Pick<SpootyState, 'accepted' | 'playlist' | 'error'>,
): SpotifyIngestInfo {
  return {
    ref,
    title: songs[0]?.title ?? null,
    artist: songs[0]?.artist || null,
    coverUrl,
    caption,
    trackCount: songs.length,
    spootyAccepted: sp.accepted,
    spootyPlaylistId: sp.playlist?.id ?? null,
    error: sp.error,
  };
}

/** The same link again: merge tags, adopt old entries, retry failed downloads. */
async function reingestSpotify(
  existing: Entry,
  ref: SpotifyRef,
  input: IngestInput,
  tags: string[],
  tagsLog: ActionLogItem[],
): Promise<IngestResult> {
  try {
    if (tags.length > 0) {
      const merged = mergeEntryResults(existing.results, {
        songs: [], films: [], notes: [], links: [], tags, summary: null,
      });
      await updateEntry(existing.id, { results: merged });
      for (const l of tagsLog) await appendActionLog(existing.id, l);
    }
    for (const l of input.logs?.onExisting ?? []) await appendActionLog(existing.id, l);

    const request = await getSpootyRequestByEntry(existing.id);
    let sp: SpootyState = { accepted: true, playlist: null, tracks: [], error: null };

    if (!request) {
      // Entry created before this flow existed (generic page analysis): start tracking it now.
      sp = await ensureAtSpooty(ref);
      const songs = songsFromSpooty(sp.tracks, sp.playlist, ref);
      if (songs.length) {
        const keep = (existing.results.songs ?? []).filter((s) => s.source !== 'spotify_link');
        await updateEntry(existing.id, {
          results: { ...existing.results, songs: [...keep, ...songs] },
          caption: captionFor(ref, sp.playlist, songs),
          thumbnailUrl: sp.playlist?.coverUrl ?? existing.thumbnailUrl,
          status: 'processing',
        });
        enrichSongs(songs);
      }
      await insertSpootyRequest({
        entryId: existing.id,
        ownerUser: input.ownerUser,
        spotifyUrl: ref.url,
        kind: ref.kind,
        spootyPlaylistId: sp.playlist?.id ?? null,
        chatId: input.chatId ?? null,
        status: sp.accepted ? 'tracking' : 'queued',
      });
      await appendActionLog(existing.id, createActionLog('spooty_enqueued', { adopted: true, playlistId: sp.playlist?.id ?? null }));
    } else if (request.status === 'failed') {
      // Sharing a failed link again is an explicit "retry".
      sp = await ensureAtSpooty(ref);
      for (const t of sp.tracks.filter((x) => x.status === SpootyStatus.Error)) await retrySpootyTrack(t.id);
      await patchSpootyRequest(request.id, {
        status: sp.accepted ? 'tracking' : 'queued',
        lastError: null,
        attempts: 0,
        spootyPlaylistId: sp.playlist?.id ?? request.spootyPlaylistId,
        nextCheckInMs: 3000,
      });
      await updateEntry(existing.id, { status: 'processing' });
      await appendActionLog(existing.id, createActionLog('spooty_retry', { channel: input.channel }));
    }

    const songs = existing.results.songs ?? [];
    const first = songs.find((s) => s.source === 'spotify_link') ?? songs[0];
    return {
      kind: 'spotify',
      platform: 'spotify',
      entryId: existing.id,
      existing: true,
      enqueued: true,
      tags,
      spotify: {
        ref,
        title: first?.title ?? null,
        artist: first?.artist || null,
        coverUrl: existing.thumbnailUrl,
        caption: existing.caption,
        trackCount: songs.filter((s) => s.source === 'spotify_link').length,
        spootyAccepted: sp.accepted,
        spootyPlaylistId: request?.spootyPlaylistId ?? sp.playlist?.id ?? null,
        error: sp.error,
      },
    };
  } catch (err) {
    throw new IngestError(errMsg(err), existing.id);
  }
}

// ---------------------------------------------------------------------------
// Shazam
// ---------------------------------------------------------------------------

/** A Shazam page has no Spotify link: the song enters the library with a YouTube search, like any other. */
export function songFromShazam(info: ShazamTrackInfo): Song {
  return {
    title: info.title,
    artist: info.artist,
    album: info.album,
    source: 'shazam_link',
    spotifyUri: null,
    spotifyUrl: null,
    youtubeUrl: youtubeSearchUrl(info.artist, info.title),
    soundcloudUrl: null,
    addedToPlaylist: false,
  };
}

const shazamCaption = (info: Pick<ShazamTrackInfo, 'artist' | 'title'>): string => `${info.artist} – ${info.title}`;

const isSettledShazam = (entry: Entry): boolean =>
  entry.sourcePlatform === 'shazam' &&
  entry.status === 'completed' &&
  (entry.results.songs ?? []).some((s) => s.source === 'shazam_link');

/** Reading the Shazam page never throws: the link is stored either way (sharing it again retries). */
async function readShazam(ref: ShazamRef): Promise<{ info: ShazamTrackInfo | null; error: Error | null }> {
  try {
    return { info: await fetchShazamTrack(ref), error: null };
  } catch (err) {
    return { info: null, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

async function ingestShazam(ref: ShazamRef, rawUrl: string, input: IngestInput): Promise<IngestResult> {
  const tags = input.tags ?? [];
  const tagsAction = input.logs?.tagsAction ?? 'comment_tags';
  const tagsLog = tags.length ? [createActionLog(tagsAction, { tags, channel: input.channel })] : [];

  let existing: Entry | null;
  try {
    // Entries saved before Shazam links were understood carry the raw shared URL (…?referrer=share).
    existing =
      (await findEntryByUrl(ref.url, input.ownerUser)) ?? (await findEntryByUrl(normalizeUrl(rawUrl), input.ownerUser));
  } catch (err) {
    throw new IngestError(errMsg(err));
  }
  if (existing && isSettledShazam(existing)) return settledShazam(existing, ref, input, tags, tagsLog);

  const { info, error } = await readShazam(ref);
  const song = info ? songFromShazam(info) : null;
  const caption = info ? shazamCaption(info) : null;
  const outcomeLog = info
    ? createActionLog('shazam_resolved', { title: info.title, artist: info.artist, album: info.album, pageUrl: info.pageUrl })
    : createActionLog('shazam_failed', {
        code: error instanceof ShazamFetchError ? error.code : 'unknown',
        error: error ? errMsg(error) : null,
      });
  const receivedLog = createActionLog('shazam_link_received', { kind: ref.kind, id: ref.id, url: ref.url, channel: input.channel });

  let entryId: string;
  try {
    if (existing) {
      // Retry of a failed read, or adoption of an entry that was analysed as a generic page.
      const merged = mergeEntryResults(existing.results, { songs: [], films: [], notes: [], links: [], tags, summary: null });
      const keep = (merged.songs ?? []).filter((s) => s.source !== 'shazam_link');
      await updateEntry(existing.id, {
        sourceUrl: ref.url,
        sourcePlatform: 'shazam',
        caption: caption ?? existing.caption,
        thumbnailUrl: info?.coverUrl ?? existing.thumbnailUrl,
        status: info || existing.status === 'completed' ? 'completed' : 'error',
        results: { ...merged, songs: song ? [...keep, song] : keep },
      });
      for (const l of [...(input.logs?.onExisting ?? []), receivedLog, ...tagsLog, outcomeLog]) {
        await appendActionLog(existing.id, l);
      }
      entryId = existing.id;
    } else {
      entryId = await createEntry({
        sourceUrl: ref.url,
        sourcePlatform: 'shazam',
        inputChannel: input.channel,
        inputUser: input.inputUser,
        ownerUser: input.ownerUser,
        caption,
        thumbnailUrl: info?.coverUrl ?? null,
        mediaUrl: null,
        status: info ? 'completed' : 'error',
        results: { songs: song ? [song] : [], films: [], notes: [], links: [], tags, summary: null },
        actionLog: [...(input.logs?.onNew ?? []), receivedLog, ...tagsLog, outcomeLog],
      });
    }
  } catch (err) {
    throw new IngestError(errMsg(err), existing?.id ?? null);
  }
  if (song) enrichSongs([song]);

  if (info) {
    try {
      await setSongCoverIfMissing(songKey(info.artist, info.title), info.coverUrl, info.album);
    } catch (err) {
      logWarning('shazam cover failed', { err: errMsg(err) });
    }
  }

  return {
    kind: 'shazam',
    platform: 'shazam',
    entryId,
    existing: existing !== null,
    enqueued: true,
    tags,
    shazam: {
      ref,
      title: info?.title ?? null,
      artist: info?.artist ?? null,
      album: info?.album ?? null,
      coverUrl: info?.coverUrl ?? null,
      caption,
      error: error ? errMsg(error) : null,
    },
  };
}

/** The same Shazam link again, already in the library: only merge tags and write the adapter's audit items. */
async function settledShazam(
  existing: Entry,
  ref: ShazamRef,
  input: IngestInput,
  tags: string[],
  tagsLog: ActionLogItem[],
): Promise<IngestResult> {
  try {
    if (tags.length > 0) {
      const merged = mergeEntryResults(existing.results, { songs: [], films: [], notes: [], links: [], tags, summary: null });
      await updateEntry(existing.id, { results: merged });
      for (const l of tagsLog) await appendActionLog(existing.id, l);
    }
    for (const l of input.logs?.onExisting ?? []) await appendActionLog(existing.id, l);
  } catch (err) {
    throw new IngestError(errMsg(err), existing.id);
  }
  const song = (existing.results.songs ?? []).find((s) => s.source === 'shazam_link') ?? null;
  return {
    kind: 'shazam',
    platform: 'shazam',
    entryId: existing.id,
    existing: true,
    enqueued: true,
    tags,
    shazam: {
      ref,
      title: song?.title ?? null,
      artist: song?.artist || null,
      album: song?.album ?? null,
      coverUrl: existing.thumbnailUrl,
      caption: existing.caption,
      error: null,
    },
  };
}
