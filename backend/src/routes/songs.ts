import type { FastifyInstance } from 'fastify';
import { join } from 'path';
import { listEntries } from '../utils/db';
import { resolveUser } from '../utils/requestUser';
import { songKey, listSongMeta, patchSongUserMeta, getSongMeta } from '../services/songMeta';
import type { SongUserMetaPatch } from '../services/songMeta';
import { resolveDeezerPreviewUrl } from '../services/songEnrichment';
import { syncDownloadedFlags, findLibraryTrack } from '../services/musicLibrary';
import { getLibraryTracks, invalidateLibraryTracks } from '../services/libraryCache';
import { listReadySongKeys } from '../services/songFiles';
import { locateSongs, type SongLocation } from '../services/songLocation';
import { getUserSongs } from '../services/userSongs';
import { getTrack, ORDER_WEB, requestSongDownload, resolveSongServing } from '../services/offlineManifest';
import { serveSong } from '../services/songStream';
import { describeActor, logActivity, shouldLogOnce, songLabel, type Actor } from '../services/activityLog';
import type { LibraryTrack } from '../services/musicLibrary';
import { resolveYoutubePlaySource } from '../services/youtubeResolve';
import type { AggregatedSong, Entry, Song, SongMetaRecord } from '../types';
import { logError } from '../utils/logger';

const RATINGS = new Set(['like', 'dislike']);

// listEntries() defaults to the 100 most recent entries, which would hide
// songs mentioned in older entries from this aggregation. This is a
// single-user app with roughly a few hundred entries total today, so an
// explicit high limit is cheap and keeps every entry's songs visible.
export const LIST_ENTRIES_LIMIT = 10000;

// GET /api/songs fires a background library sync on every request, but the
// sync itself does a full directory walk + DB scan, so it's throttled to
// once per this interval. Module-level state, reset via
// _resetSyncThrottleForTest for test isolation.
const SYNC_THROTTLE_MS = 10 * 60 * 1000;
let lastSyncTriggeredAt = 0;

// The library scan is cached (services/libraryCache) so every GET /api/songs does not re-walk
// hundreds of MP3s: same window as the background sync throttle, and a finished download
// invalidates it so the new file is visible at once.
export function _resetSyncThrottleForTest(): void {
  lastSyncTriggeredAt = 0;
  invalidateLibraryTracks();
}

/**
 * Marks each aggregated song with `inLibrary` by matching against a scanned
 * library track list. Pure — easy to unit-test without Fastify.
 */
export function attachLibraryFlags(
  songs: Iterable<AggregatedSong>,
  tracks: LibraryTrack[],
  /** Songs whose MP3 is recorded in `song_files` (counts even when its file name cannot be matched). */
  readyKeys: ReadonlySet<string> = new Set(),
  /** Where each song is (services/songLocation): when a song has an entry, the flags come from it. */
  locations?: ReadonlyMap<string, SongLocation>,
): AggregatedSong[] {
  return [...songs].map((song) => {
    const loc = locations?.get(song.songKey);
    if (loc) {
      // the green dot is EXACTLY "on the file system or on the media server" (spec W8, S8)
      return { ...song, inLibrary: loc.fs || loc.mediaServer, fs: loc.fs, mediaServer: loc.mediaServer, fsPath: loc.fsPath, mediaUrl: loc.mediaUrl };
    }
    return { ...song, inLibrary: readyKeys.has(song.songKey) || findLibraryTrack(tracks, song.artist, song.title) != null };
  });
}

async function getCachedLibraryTracks(): Promise<LibraryTrack[]> {
  return getLibraryTracks(SYNC_THROTTLE_MS);
}

function maybeTriggerLibrarySync(): void {
  const now = Date.now();
  if (now - lastSyncTriggeredAt < SYNC_THROTTLE_MS) return;
  lastSyncTriggeredAt = now;
  void syncDownloadedFlags().catch((err) => logError('background music library sync failed', { err: String(err) }));
}

function isSongMention(value: unknown): value is Song {
  if (
    typeof value !== 'object' || value === null ||
    typeof (value as { title?: unknown }).title !== 'string' ||
    (value as { title: string }).title.trim().length === 0
  ) {
    return false;
  }
  // JSONB-stored song mentions are not schema-validated on write; an artist
  // of an unexpected type would otherwise reach songKey() and either throw
  // or silently produce a garbage key. Only string, null and undefined are
  // accepted — a missing artist is treated as ''.
  const artist = (value as { artist?: unknown }).artist;
  return artist === undefined || artist === null || typeof artist === 'string';
}

/**
 * Aggregates every entry's song mentions into one record per song (deduped
 * by songKey), joined against the persisted song_meta record. `listEntries`
 * orders rows newest-first, and songs are visited in that same entry order,
 * so `mentions` come out newest-first without an extra sort.
 */
export function aggregateSongs(entries: Entry[], metaMap: Map<string, SongMetaRecord>): Map<string, AggregatedSong> {
  const byKey = new Map<string, AggregatedSong>();
  // Track the createdAt of the mention whose fields currently populate the
  // aggregate's display fields, so we can pick the most recent one regardless
  // of the order listEntries returns rows in.
  const latestSeenCreatedAt = new Map<string, string>();
  // What the playlist manager filters on: how the song was found, where it came from, how it was tagged.
  const facets = new Map<string, { sources: Set<string>; platforms: Set<string>; tags: Set<string> }>();
  const noteFacets = (key: string, entry: Entry, raw: Song): void => {
    let f = facets.get(key);
    if (!f) {
      f = { sources: new Set(), platforms: new Set(), tags: new Set() };
      facets.set(key, f);
    }
    if (typeof raw.source === 'string' && raw.source) f.sources.add(raw.source);
    if (typeof entry.sourcePlatform === 'string' && entry.sourcePlatform) f.platforms.add(entry.sourcePlatform);
    const tags = entry.results?.tags;
    if (Array.isArray(tags)) for (const t of tags) if (typeof t === 'string' && t) f.tags.add(t);
  };

  for (const entry of entries) {
    const songs = entry.results?.songs;
    if (!Array.isArray(songs)) continue;
    for (const raw of songs) {
      if (!isSongMention(raw)) continue;
      const artist = raw.artist ?? '';
      const key = songKey(artist, raw.title);
      const createdAt = String(entry.createdAt ?? '');
      const existing = byKey.get(key);
      noteFacets(key, entry, raw);
      if (!existing) {
        byKey.set(key, {
          songKey: key,
          title: raw.title,
          artist,
          album: raw.album ?? null,
          youtubeUrl: raw.youtubeUrl ?? null,
          spotifyUrl: raw.spotifyUrl ?? null,
          mentions: [{ entryId: entry.id, createdAt }],
          meta: metaMap.get(key) ?? null,
          inLibrary: false,
        });
        latestSeenCreatedAt.set(key, createdAt);
      } else {
        existing.mentions.push({ entryId: entry.id, createdAt });
        const bestSoFar = latestSeenCreatedAt.get(key) ?? '';
        if (createdAt > bestSoFar) {
          existing.title = raw.title;
          existing.artist = artist;
          existing.album = raw.album ?? null;
          existing.youtubeUrl = raw.youtubeUrl ?? null;
          existing.spotifyUrl = raw.spotifyUrl ?? null;
          latestSeenCreatedAt.set(key, createdAt);
        }
      }
    }
  }

  for (const [key, f] of facets) {
    const song = byKey.get(key);
    if (!song) continue;
    song.sources = [...f.sources].sort();
    song.platforms = [...f.platforms].sort();
    song.tags = [...f.tags].sort();
  }

  return byKey;
}

/**
 * One song for a user, from the short-lived per-user cache (services/userSongs) instead of re-aggregating the whole
 * journal for every request: that rebuild cost ~0.45 s on each play and made "play" feel slow next to the
 * instant Deezer/iTunes preview. Looked up fresh once when it is not cached (an entry created seconds ago).
 */
async function findVisibleSong(userId: string, isAdmin: boolean, key: string): Promise<AggregatedSong | undefined> {
  const cached = (await getUserSongs(userId, isAdmin)).get(key);
  return cached ?? (await getUserSongs(userId, isAdmin, 0)).get(key);
}

export function registerSongsRoutes(app: FastifyInstance): void {
  app.get('/api/songs', async (req, reply) => {
    maybeTriggerLibrarySync();
    try {
      const user = resolveUser(req);
      const visibility = { userId: user.id, isAdmin: user.isAdmin };
      const [entries, metaMap, tracks, readyKeys] = await Promise.all([
        listEntries(LIST_ENTRIES_LIMIT, visibility),
        listSongMeta(),
        getCachedLibraryTracks(),
        // a failure here only costs the extra flags, never the list
        listReadySongKeys().catch(() => new Set<string>()),
      ]);
      const byKey = aggregateSongs(entries, metaMap);
      // where each song is (disk / media server, with the path and URL); a failure only costs the extra fields
      const locations = await locateSongs(byKey.values(), tracks).catch((err) => {
        logError('song locations failed', { err: String(err) });
        return undefined;
      });
      return reply.send({ songs: attachLibraryFlags(byKey.values(), tracks, readyKeys, locations) });
    } catch (err) {
      logError('GET /api/songs failed', { err: String(err) });
      return reply.code(500).send({ error: 'songs aggregation failed' });
    }
  });

  // Backs the downloaded arrow's inline player: where the track lives on
  // the music share (if it does) plus the Spooty frontend URL, so the card
  // can show the location and offer a Spooty jump without a redirect dance.
  app.get<{ Params: { songKey: string } }>('/api/songs/:songKey/file-info', async (req, reply) => {
    const spootyUrl = process.env.SPOOTY_FRONTEND_URL || 'https://spooty.casamon.dev';
    try {
      const user = resolveUser(req);
      const song = await findVisibleSong(user.id, user.isAdmin, req.params.songKey);
      if (!song) {
        return reply.code(404).send({ error: 'song not found' });
      }
      const root = process.env.MUSIC_LIBRARY_PATH;
      const track = root ? findLibraryTrack(await getCachedLibraryTracks(), song.artist, song.title) : null;
      return reply.send({
        inLibrary: !!track,
        relPath: track?.relPath ?? null,
        // Absolute path on the host share — informational, shown in the UI.
        absPath: track && root ? join(root, track.relPath) : null,
        spootyUrl,
      });
    } catch (err) {
      logError('GET /api/songs/:songKey/file-info failed', { songKey: req.params.songKey, err: String(err) });
      return reply.code(500).send({ error: 'file info failed' });
    }
  });

  // The song's bytes for the web player and the downloaded arrow (ADR-0010). The media server's file comes first and
  // is PROXIED over HTTPS with Range support (so it plays from the internet too and nothing is copied onto the disk);
  // geekom's disk is the fallback. `?from=media|fs` forces one origin, `?download=1` switches to attachment. The
  // paths and URLs come from our own records and indexes — never from user input — so no traversal surface. With no
  // file anywhere the answer is a redirect to the Spooty frontend (the song may be queued there).
  app.get<{ Params: { songKey: string }; Querystring: { download?: string; from?: string } }>('/api/songs/:songKey/file', async (req, reply) => {
    const spootyFrontend = process.env.SPOOTY_FRONTEND_URL || 'https://spooty.casamon.dev';
    try {
      const user = resolveUser(req);
      const order = req.query.from === 'media' ? (['media'] as const) : req.query.from === 'fs' ? (['local'] as const) : ORDER_WEB;
      const serving = await resolveSongServing(req.params.songKey, user.id, user.isAdmin, order);
      if (!serving.ok) {
        if (serving.reason === 'song_not_found') return reply.code(404).send({ error: 'song not found' });
        return reply.redirect(spootyFrontend, 302);
      }
      const sent = await serveSong(req, reply, serving.served.origins, {
        filename: serving.served.filename,
        disposition: req.query.download === '1' ? 'attachment' : 'inline',
        version: serving.served.version,
      });
      if (!sent) return reply.redirect(spootyFrontend, 302); // every origin failed (box asleep and no local file)
      return sent.reply;
    } catch (err) {
      logError('GET /api/songs/:songKey/file failed', { songKey: req.params.songKey, err: String(err) });
      return reply.redirect(spootyFrontend, 302);
    }
  });

  // First play: ask for the song's MP3 while it plays from the fallback, so the next play is local.
  // `priority: "play"` jumps the playlist-sync queue (docs/mondrop-sync.md, "Primo play").
  app.post<{ Params: { songKey: string }; Body: { priority?: string } | undefined }>(
    '/api/songs/:songKey/download',
    async (req, reply) => {
      try {
        const user = resolveUser(req);
        const priority = req.body?.priority === 'play' ? 'play' : 'sync';
        const track = await requestSongDownload(req.params.songKey, user.id, {
          priority,
          retry: priority !== 'play',
          isAdmin: user.isAdmin,
        });
        if (!track) return reply.code(404).send({ ok: false, error: 'song not found' });
        // the web's first play asks for the file too: it shows in the activity trail like a phone's request
        const actor: Actor = { user: user.id, device: 'web', channel: 'web' };
        if (shouldLogOnce(`web-download:${user.id}:${req.params.songKey}`, 60_000)) {
          logActivity('download', 'request', `${describeActor(actor)} chiede «${songLabel(track, req.params.songKey)}» (priorità ${priority}) → ${track.state}`, actor, {
            songKey: req.params.songKey, priority, state: track.state, source: track.source,
          });
        }
        return reply.send({ ok: true, state: track.state, track });
      } catch (err) {
        logError('POST /api/songs/:songKey/download failed', { songKey: req.params.songKey, err: String(err) });
        return reply.code(500).send({ ok: false, error: 'download request failed' });
      }
    },
  );

  app.get<{ Params: { songKey: string } }>('/api/songs/:songKey/state', async (req, reply) => {
    try {
      const user = resolveUser(req);
      const track = await getTrack(req.params.songKey, user.id, user.isAdmin);
      if (!track) return reply.code(404).send({ error: 'song not found' });
      // where the song is (spec W2/W8): disk, media server, their path/URL and the video link
      const loc = (await locateSongs([{ songKey: track.songKey, artist: track.artist, title: track.title }], await getCachedLibraryTracks())
        .catch(() => new Map<string, SongLocation>())).get(track.songKey) ?? null;
      return reply.send({
        state: track.state,
        source: track.source,
        version: track.version,
        bytes: track.bytes,
        error: track.error,
        inLibrary: loc ? loc.fs || loc.mediaServer : track.state === 'ready',
        location: loc && { fs: loc.fs, mediaServer: loc.mediaServer, fsPath: loc.fsPath, mediaUrl: loc.mediaUrl, streamUrl: loc.streamUrl },
      });
    } catch (err) {
      logError('GET /api/songs/:songKey/state failed', { songKey: req.params.songKey, err: String(err) });
      return reply.code(500).send({ error: 'song state failed' });
    }
  });

  // Manual/UI-triggered sync, bypasses the throttle and awaits completion.
  app.post('/api/songs/sync-library', async (_req, reply) => {
    try {
      const result = await syncDownloadedFlags();
      return reply.send(result);
    } catch (err) {
      logError('POST /api/songs/sync-library failed', { err: String(err) });
      return reply.code(500).send({ error: 'music library sync failed' });
    }
  });

  // Online play source for the web player: a YouTube video id. Prefers an id
  // already present on the song's youtubeUrl; otherwise resolves via the
  // instaloader /yt/url (yt-dlp ytsearch1). No Spooty / local MP3 involved.
  app.get<{ Params: { songKey: string } }>('/api/songs/:songKey/youtube', async (req, reply) => {
    try {
      const user = resolveUser(req);
      const song = await findVisibleSong(user.id, user.isAdmin, req.params.songKey);
      if (!song) {
        return reply.code(404).send({ error: 'song not found' });
      }
      const source = await resolveYoutubePlaySource({
        songKey: song.songKey,
        artist: song.artist,
        title: song.title,
        youtubeUrl: song.youtubeUrl,
      });
      if (!source) {
        return reply.code(404).send({ error: 'youtube video not found' });
      }
      return reply.send(source);
    } catch (err) {
      logError('GET /api/songs/:songKey/youtube failed', { songKey: req.params.songKey, err: String(err) });
      return reply.code(500).send({ error: 'youtube resolution failed' });
    }
  });

  // On-demand preview resolution. Deezer's stored preview_url is never
  // persisted (see songEnrichment.tryDeezer — it's a signed URL that expires
  // ~14min after issue), so this route is the only place a Deezer preview
  // URL is ever handed to a client: resolved live, right before playback,
  // and never written back to song_meta. The iTunes-backed case is durable,
  // so it's just a straight read of the stored value.
  app.get<{ Params: { songKey: string } }>('/api/songs/:songKey/preview', async (req, reply) => {
    try {
      const meta = await getSongMeta(req.params.songKey);
      if (!meta) {
        return reply.code(404).send({ error: 'song not found' });
      }

      if (meta.previewUrl) {
        return reply.send({ url: meta.previewUrl });
      }

      if (meta.deezerId) {
        const url = await resolveDeezerPreviewUrl(meta.deezerId);
        if (url) {
          return reply.send({ url });
        }
      }

      return reply.code(404).send({ error: 'preview not available' });
    } catch (err) {
      logError('GET /api/songs/:songKey/preview failed', { songKey: req.params.songKey, err: String(err) });
      return reply.code(500).send({ error: 'preview resolution failed' });
    }
  });

  app.patch<{ Params: { songKey: string }; Body: SongUserMetaPatch }>(
    '/api/songs/:songKey',
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.listened !== undefined && typeof body.listened !== 'boolean') {
        return reply.code(400).send({ error: 'listened must be boolean' });
      }
      if (body.favorite !== undefined && typeof body.favorite !== 'boolean') {
        return reply.code(400).send({ error: 'favorite must be boolean' });
      }
      if (body.downloaded !== undefined && typeof body.downloaded !== 'boolean') {
        return reply.code(400).send({ error: 'downloaded must be boolean' });
      }
      if (body.rating !== undefined && body.rating !== null && !RATINGS.has(body.rating)) {
        return reply.code(400).send({ error: 'rating must be like|dislike|null' });
      }
      if (
        body.score !== undefined && body.score !== null &&
        (!Number.isInteger(body.score) || body.score < 0 || body.score > 100)
      ) {
        return reply.code(400).send({ error: 'score must be an integer 0-100 or null' });
      }

      try {
        const meta = await patchSongUserMeta(req.params.songKey, body);
        return reply.send({ meta });
      } catch (err) {
        logError('PATCH /api/songs failed', { songKey: req.params.songKey, err: String(err) });
        return reply.code(500).send({ error: 'song meta update failed' });
      }
    }
  );
}
