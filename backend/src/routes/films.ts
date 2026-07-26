import type { FastifyInstance } from 'fastify';
import { listEntries } from '../utils/db';
import { filmKey, listFilmMeta, patchFilmUserMeta } from '../services/filmMeta';
import type { FilmUserMetaPatch } from '../services/filmMeta';
import { streamingConfigured } from '../services/streamingAvailability';
import { refreshStreamingForFilm, extractImdbId } from '../services/streamingRefresher';
import type { AggregatedFilm, Entry, Film, FilmMetaRecord } from '../types';
import { logError } from '../utils/logger';

const RATINGS = new Set(['fresh', 'rotten']);
const AVAILABILITY = new Set(['free', 'paid', 'absent']);

// listEntries() defaults to the 100 most recent entries, which would hide
// films mentioned in older entries from this aggregation. This is a
// single-user app with roughly a few hundred entries total today, so an
// explicit high limit is cheap and keeps every entry's films visible.
const LIST_ENTRIES_LIMIT = 10000;

function isFilm(value: unknown): value is Film {
  if (
    typeof value !== 'object' || value === null ||
    typeof (value as { title?: unknown }).title !== 'string' ||
    (value as { title: string }).title.trim().length === 0
  ) {
    return false;
  }
  // JSONB-stored film mentions are not schema-validated on write; a `year`
  // of an unexpected type (e.g. an object) would otherwise reach filmKey()
  // and either throw or silently produce a garbage key. Only string, number,
  // null and undefined are accepted here — anything else is skipped rather
  // than surfaced as a 500.
  const year = (value as { year?: unknown }).year;
  return year === undefined || year === null || typeof year === 'string' || typeof year === 'number';
}

/**
 * Aggregates every entry's film mentions into one record per film (deduped by
 * filmKey), joined against the persisted film_meta record. Shared by GET
 * /api/films and the refresh-streaming route, which both need to resolve a
 * film's current display fields (imdbUrl in particular) from entries.
 */
function aggregateFilms(entries: Entry[], metaMap: Map<string, FilmMetaRecord>): Map<string, AggregatedFilm> {
  const byKey = new Map<string, AggregatedFilm>();
  // Track the createdAt of the mention whose fields currently populate the
  // aggregate's display fields, so we can pick the most recent one regardless
  // of the order listEntries returns rows in.
  const latestSeenCreatedAt = new Map<string, string>();

  for (const entry of entries) {
    const films = entry.results?.films;
    if (!Array.isArray(films)) continue;
    for (const raw of films) {
      if (!isFilm(raw)) continue;
      const key = filmKey(raw.title, raw.year);
      const createdAt = String(entry.createdAt ?? '');
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          filmKey: key,
          title: raw.title,
          director: raw.director ?? null,
          year: raw.year ?? null,
          imdbUrl: raw.imdbUrl ?? null,
          posterUrl: raw.posterUrl ?? null,
          streamingUrls: raw.streamingUrls ?? null,
          mentions: [{ entryId: entry.id, createdAt }],
          meta: metaMap.get(key) ?? null,
        });
        latestSeenCreatedAt.set(key, createdAt);
      } else {
        existing.mentions.push({ entryId: entry.id, createdAt });
        const bestSoFar = latestSeenCreatedAt.get(key) ?? '';
        if (createdAt > bestSoFar) {
          existing.title = raw.title;
          existing.director = raw.director ?? null;
          existing.year = raw.year ?? null;
          existing.imdbUrl = raw.imdbUrl ?? null;
          existing.posterUrl = raw.posterUrl ?? null;
          existing.streamingUrls = raw.streamingUrls ?? null;
          latestSeenCreatedAt.set(key, createdAt);
        }
      }
    }
  }

  return byKey;
}

export function registerFilmsRoutes(app: FastifyInstance): void {
  app.get('/api/films', async (_req, reply) => {
    try {
      const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listFilmMeta()]);
      const byKey = aggregateFilms(entries, metaMap);
      return reply.send({ films: [...byKey.values()] });
    } catch (err) {
      logError('GET /api/films failed', { err: String(err) });
      return reply.code(500).send({ error: 'films aggregation failed' });
    }
  });

  app.patch<{ Params: { filmKey: string }; Body: FilmUserMetaPatch }>(
    '/api/films/:filmKey',
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.watched !== undefined && typeof body.watched !== 'boolean') {
        return reply.code(400).send({ error: 'watched must be boolean' });
      }
      if (body.rating !== undefined && body.rating !== null && !RATINGS.has(body.rating)) {
        return reply.code(400).send({ error: 'rating must be fresh|rotten|null' });
      }
      if (
        body.score !== undefined && body.score !== null &&
        (!Number.isInteger(body.score) || body.score < 0 || body.score > 100)
      ) {
        return reply.code(400).send({ error: 'score must be an integer 0-100 or null' });
      }
      if (body.availability !== undefined) {
        if (
          typeof body.availability !== 'object' ||
          body.availability === null ||
          Array.isArray(body.availability)
        ) {
          return reply.code(400).send({ error: 'availability must be an object' });
        }
        for (const value of Object.values(body.availability)) {
          if (value !== null && !AVAILABILITY.has(value)) {
            return reply.code(400).send({ error: 'availability values must be free|paid|absent|null' });
          }
        }
      }

      try {
        const meta = await patchFilmUserMeta(req.params.filmKey, body);
        return reply.send({ meta });
      } catch (err) {
        logError('PATCH /api/films failed', { filmKey: req.params.filmKey, err: String(err) });
        return reply.code(500).send({ error: 'film meta update failed' });
      }
    }
  );

  app.post<{ Params: { filmKey: string } }>(
    '/api/films/:filmKey/refresh-streaming',
    async (req, reply) => {
      const key = req.params.filmKey;
      try {
        const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listFilmMeta()]);
        const film = aggregateFilms(entries, metaMap).get(key);
        if (!film) {
          return reply.code(404).send({ error: 'film not found' });
        }

        const imdbId = extractImdbId(film.imdbUrl);
        if (!imdbId) {
          return reply.code(404).send({ error: 'film has no IMDb id' });
        }

        if (!streamingConfigured()) {
          return reply.code(503).send({ error: 'streaming availability provider not configured' });
        }

        try {
          await refreshStreamingForFilm({
            filmKey: key,
            imdbId,
            cachedTitleId: film.meta?.watchmodeTitleId ?? null,
          });
        } catch (err) {
          logError('POST /api/films/:filmKey/refresh-streaming failed', { filmKey: key, err: String(err) });
          return reply.code(500).send({ error: 'streaming refresh failed' });
        }

        const freshMeta = (await listFilmMeta()).get(key) ?? null;
        return reply.send({ meta: freshMeta });
      } catch (err) {
        logError('POST /api/films/:filmKey/refresh-streaming failed', { filmKey: key, err: String(err) });
        return reply.code(500).send({ error: 'streaming refresh failed' });
      }
    }
  );
}
