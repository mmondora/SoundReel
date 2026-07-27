import type { FastifyInstance } from 'fastify';
import { listEntries } from '../utils/db';
import { noteKey, normalizeNoteCategory, listNoteMeta } from '../services/noteMeta';
import type { AggregatedNote, Entry, Note, NoteMetaRecord } from '../types';
import { logError } from '../utils/logger';

// listEntries() defaults to the 100 most recent entries, which would hide
// notes mentioned in older entries from this aggregation. This is a
// single-user app with roughly a few hundred entries total today, so an
// explicit high limit is cheap and keeps every entry's notes visible.
export const LIST_ENTRIES_LIMIT = 10000;

function isNoteMention(value: unknown): value is Note {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as { text?: unknown }).text === 'string' &&
    (value as { text: string }).text.trim().length > 0
  );
}

/**
 * Aggregates every entry's note mentions into one record per note (deduped
 * by noteKey, which embeds the normalized category — see noteKey), joined
 * against the persisted note_meta record. `listEntries` orders rows
 * newest-first, and notes are visited in that same entry order, so
 * `mentions` come out newest-first without an extra sort.
 */
export function aggregateNotes(entries: Entry[], metaMap: Map<string, NoteMetaRecord>): Map<string, AggregatedNote> {
  const byKey = new Map<string, AggregatedNote>();
  // Track the createdAt of the mention whose fields currently populate the
  // aggregate's display fields, so we can pick the most recent one regardless
  // of the order listEntries returns rows in.
  const latestSeenCreatedAt = new Map<string, string>();

  for (const entry of entries) {
    const notes = entry.results?.notes;
    if (!Array.isArray(notes)) continue;
    for (const raw of notes) {
      if (!isNoteMention(raw)) continue;
      const text = raw.text.trim();
      const category = normalizeNoteCategory(raw.category);
      const key = noteKey(category, text);
      const createdAt = String(entry.createdAt ?? '');
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          noteKey: key,
          text,
          category,
          mentions: [{ entryId: entry.id, createdAt }],
          meta: metaMap.get(key) ?? null,
        });
        latestSeenCreatedAt.set(key, createdAt);
      } else {
        existing.mentions.push({ entryId: entry.id, createdAt });
        const bestSoFar = latestSeenCreatedAt.get(key) ?? '';
        if (createdAt > bestSoFar) {
          existing.text = text;
          existing.category = category;
          latestSeenCreatedAt.set(key, createdAt);
        }
      }
    }
  }

  return byKey;
}

export function registerNotesRoutes(app: FastifyInstance): void {
  app.get('/api/notes', async (_req, reply) => {
    try {
      const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listNoteMeta()]);
      const byKey = aggregateNotes(entries, metaMap);
      return reply.send({ notes: [...byKey.values()] });
    } catch (err) {
      logError('GET /api/notes failed', { err: String(err) });
      return reply.code(500).send({ error: 'notes aggregation failed' });
    }
  });
}
