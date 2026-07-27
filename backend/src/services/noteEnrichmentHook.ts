import { noteKey, normalizeNoteCategory, getNoteMeta, upsertNoteEnrichment, upsertPlaceEnrichment } from './noteMeta';
import { enrichBook } from './bookEnrichment';
import { enrichPlace } from './placeEnrichment';
import { isStale } from './streamingRefresher';
import { logError } from '../utils/logger';

const NOTE_ENRICHMENT_TTL_DAYS = Number(process.env.NOTE_ENRICHMENT_TTL_DAYS || 30);

/**
 * Fire-and-forget: enrich every book- and place-category note (book via
 * OpenLibrary — title, author, year, cover; place via Nominatim/OSM —
 * resolved name, display name, coordinates, OSM link) skipping ones
 * enriched within the TTL. Never delays the caller. Mirrors
 * enqueueSongEnrichment's shape. Other categories (event/brand/product/
 * quote/person/other, and anything normalizing to 'other') are skipped
 * entirely — there is no enrichment provider for them yet.
 */
export function enqueueNoteEnrichment(notes: Array<{ text: string; category: string | null | undefined }>): void {
  for (const note of notes) {
    if (!note.text.trim()) continue;
    const category = normalizeNoteCategory(note.category);
    if (category !== 'book' && category !== 'place') continue;
    const noteMetaKey = noteKey(category, note.text);
    void (async () => {
      const existingMeta = await getNoteMeta(noteMetaKey);
      if (existingMeta?.enrichedAt && !isStale(existingMeta.enrichedAt, NOTE_ENRICHMENT_TTL_DAYS)) return;

      if (category === 'book') {
        const enrichment = await enrichBook(note.text);
        if (enrichment) {
          await upsertNoteEnrichment({ noteKey: noteMetaKey, ...enrichment });
        } else {
          // Persist the miss (all-null fields, enriched_at=now()) so the TTL
          // check above skips this note for NOTE_ENRICHMENT_TTL_DAYS instead
          // of re-querying OpenLibrary on every mention until it happens to
          // start matching.
          await upsertNoteEnrichment({
            noteKey: noteMetaKey,
            bookTitle: null,
            bookAuthor: null,
            bookYear: null,
            coverUrl: null,
            openlibraryUrl: null,
          });
        }
      } else {
        const enrichment = await enrichPlace(note.text);
        if (enrichment) {
          await upsertPlaceEnrichment({ noteKey: noteMetaKey, ...enrichment });
        } else {
          // Same TTL rationale as the book miss above, for Nominatim.
          await upsertPlaceEnrichment({
            noteKey: noteMetaKey,
            placeName: null,
            placeDisplayName: null,
            placeLat: null,
            placeLon: null,
            osmUrl: null,
          });
        }
      }
    })().catch((err) => logError('note enrichment failed', { err: String(err) }));
  }
}
