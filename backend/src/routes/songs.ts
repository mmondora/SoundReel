import type { FastifyInstance } from 'fastify';
import { listEntries } from '../utils/db';
import { songKey, listSongMeta, patchSongUserMeta, getSongMeta } from '../services/songMeta';
import type { SongUserMetaPatch } from '../services/songMeta';
import { resolveDeezerPreviewUrl } from '../services/songEnrichment';
import type { AggregatedSong, Entry, Song, SongMetaRecord } from '../types';
import { logError } from '../utils/logger';

const RATINGS = new Set(['like', 'dislike']);

// listEntries() defaults to the 100 most recent entries, which would hide
// songs mentioned in older entries from this aggregation. This is a
// single-user app with roughly a few hundred entries total today, so an
// explicit high limit is cheap and keeps every entry's songs visible.
const LIST_ENTRIES_LIMIT = 10000;

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
function aggregateSongs(entries: Entry[], metaMap: Map<string, SongMetaRecord>): Map<string, AggregatedSong> {
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
    try {
      const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listSongMeta()]);
      const byKey = aggregateSongs(entries, metaMap);
      return reply.send({ songs: [...byKey.values()] });
    } catch (err) {
      logError('GET /api/songs failed', { err: String(err) });
      return reply.code(500).send({ error: 'songs aggregation failed' });
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
