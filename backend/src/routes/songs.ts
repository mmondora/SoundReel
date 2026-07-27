import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { listEntries } from '../utils/db';
import { songKey, listSongMeta, patchSongUserMeta, getSongMeta } from '../services/songMeta';
import type { SongUserMetaPatch } from '../services/songMeta';
import { resolveDeezerPreviewUrl } from '../services/songEnrichment';
import { syncDownloadedFlags, scanLibrary, findLibraryTrack } from '../services/musicLibrary';
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

export function _resetSyncThrottleForTest(): void {
  lastSyncTriggeredAt = 0;
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

  for (const entry of entries) {
    const songs = entry.results?.songs;
    if (!Array.isArray(songs)) continue;
    for (const raw of songs) {
      if (!isSongMention(raw)) continue;
      const artist = raw.artist ?? '';
      const key = songKey(artist, raw.title);
      const createdAt = String(entry.createdAt ?? '');
      const existing = byKey.get(key);
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

  return byKey;
}

export function registerSongsRoutes(app: FastifyInstance): void {
  app.get('/api/songs', async (_req, reply) => {
    maybeTriggerLibrarySync();
    try {
      const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listSongMeta()]);
      const byKey = aggregateSongs(entries, metaMap);
      return reply.send({ songs: [...byKey.values()] });
    } catch (err) {
      logError('GET /api/songs failed', { err: String(err) });
      return reply.code(500).send({ error: 'songs aggregation failed' });
    }
  });

  // The downloaded arrow in the UI: plays the matched MP3 from the music
  // share in the browser (inline disposition + Range support so the native
  // player can seek), else falls back to a redirect to the Spooty frontend
  // (the song was queued on Spooty but the file isn't in the share, or the
  // share isn't mounted). The path served always comes from our own library
  // scan — never from user input — so no traversal surface.
  app.get<{ Params: { songKey: string } }>('/api/songs/:songKey/file', async (req, reply) => {
    const spootyFrontend = process.env.SPOOTY_FRONTEND_URL || 'https://spooty.casamon.dev';
    try {
      const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listSongMeta()]);
      const song = aggregateSongs(entries, metaMap).get(req.params.songKey);
      if (!song) {
        return reply.code(404).send({ error: 'song not found' });
      }

      const tracks = await scanLibrary();
      const track = findLibraryTrack(tracks, song.artist, song.title);
      const root = process.env.MUSIC_LIBRARY_PATH;
      if (!track || !root) {
        return reply.redirect(spootyFrontend, 302);
      }

      const filePath = join(root, track.relPath);
      const { size } = await stat(filePath);
      const filename = track.relPath.split('/').pop() ?? 'song.mp3';

      reply
        .header('Accept-Ranges', 'bytes')
        .header('Content-Type', 'audio/mpeg')
        .header('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);

      // Single-range requests only (what <audio> seeking actually sends);
      // anything unparsable falls through to a full 200 response.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      let start = 0;
      let end = size - 1;
      if (range && (range[1] !== '' || range[2] !== '')) {
        if (range[1] === '') {
          // suffix form "bytes=-N": last N bytes
          start = Math.max(0, size - Number(range[2]));
        } else {
          start = Number(range[1]);
          if (range[2] !== '') end = Math.min(end, Number(range[2]));
        }
        if (start > end || start >= size) {
          return reply.code(416).header('Content-Range', `bytes */${size}`).send();
        }
        reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
      }

      const stream = createReadStream(filePath, { start, end });
      stream.on('error', (err) => {
        logError('GET /api/songs/:songKey/file stream failed', { songKey: req.params.songKey, err: String(err) });
      });
      return reply.header('Content-Length', end - start + 1).send(stream);
    } catch (err) {
      logError('GET /api/songs/:songKey/file failed', { songKey: req.params.songKey, err: String(err) });
      return reply.redirect(spootyFrontend, 302);
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
