import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./noteMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./noteMeta')>();
  return {
    noteKey: actual.noteKey,
    normalizeNoteCategory: actual.normalizeNoteCategory,
    getNoteMeta: vi.fn(),
    upsertNoteEnrichment: vi.fn(),
    upsertPlaceEnrichment: vi.fn(),
  };
});
vi.mock('./bookEnrichment', () => ({ enrichBook: vi.fn() }));
vi.mock('./placeEnrichment', () => ({ enrichPlace: vi.fn() }));
vi.mock('./streamingRefresher', () => ({ isStale: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { enqueueNoteEnrichment } from './noteEnrichmentHook';
import { getNoteMeta, upsertNoteEnrichment, upsertPlaceEnrichment, noteKey } from './noteMeta';
import { enrichBook } from './bookEnrichment';
import { enrichPlace } from './placeEnrichment';
import { isStale } from './streamingRefresher';
import { logError } from '../utils/logger';

// Flush the fire-and-forget microtask/promise chain kicked off inside enqueueNoteEnrichment.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('enqueueNoteEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips notes with a blank text', async () => {
    enqueueNoteEnrichment([{ category: 'book', text: '   ' }]);
    await flush();
    expect(getNoteMeta).not.toHaveBeenCalled();
  });

  it('skips categories with no enrichment provider (not book or place)', async () => {
    enqueueNoteEnrichment([
      { category: 'quote', text: 'To be or not to be' },
      { category: 'other', text: 'Something else' },
      { category: 'event', text: 'Some event' },
      { category: 'brand', text: 'Some brand' },
      { category: 'product', text: 'Some product' },
      { category: 'person', text: 'Some person' },
    ]);
    await flush();
    expect(getNoteMeta).not.toHaveBeenCalled();
  });

  it('normalizes category before checking book — an unknown category never enriches', async () => {
    enqueueNoteEnrichment([{ category: 'note', text: 'Some random text' }]);
    await flush();
    expect(getNoteMeta).not.toHaveBeenCalled();
  });

  it('looks up existing meta by noteKey(category, text) and enriches when missing', async () => {
    vi.mocked(getNoteMeta).mockResolvedValue(null);
    vi.mocked(enrichBook).mockResolvedValue({
      bookTitle: 'Dune', bookAuthor: 'Frank Herbert', bookYear: 1965,
      coverUrl: null, openlibraryUrl: null,
    });
    enqueueNoteEnrichment([{ category: 'book', text: 'Dune' }]);
    await flush();
    expect(getNoteMeta).toHaveBeenCalledWith(noteKey('book', 'Dune'));
    expect(enrichBook).toHaveBeenCalledWith('Dune');
    expect(upsertNoteEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      noteKey: noteKey('book', 'Dune'),
      bookTitle: 'Dune',
    }));
  });

  it('skips enrichment when existing meta is fresh (not stale)', async () => {
    vi.mocked(getNoteMeta).mockResolvedValue({
      noteKey: noteKey('book', 'Dune'),
      enrichedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(isStale).mockReturnValue(false);
    enqueueNoteEnrichment([{ category: 'book', text: 'Dune' }]);
    await flush();
    expect(enrichBook).not.toHaveBeenCalled();
  });

  it('re-enriches when existing meta is stale', async () => {
    vi.mocked(getNoteMeta).mockResolvedValue({
      noteKey: noteKey('book', 'Dune'),
      enrichedAt: '2020-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(isStale).mockReturnValue(true);
    vi.mocked(enrichBook).mockResolvedValue(null);
    enqueueNoteEnrichment([{ category: 'book', text: 'Dune' }]);
    await flush();
    expect(enrichBook).toHaveBeenCalled();
    // Miss still persists an all-null row (TTL), it just doesn't carry book data.
    expect(upsertNoteEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      noteKey: noteKey('book', 'Dune'),
      bookTitle: null,
    }));
  });

  it('persists an all-null row (TTL) on an enrichment miss, instead of leaving it un-cached', async () => {
    vi.mocked(getNoteMeta).mockResolvedValue(null);
    vi.mocked(enrichBook).mockResolvedValue(null);
    enqueueNoteEnrichment([{ category: 'book', text: 'Unknown Obscure Book' }]);
    await flush();
    expect(upsertNoteEnrichment).toHaveBeenCalledWith({
      noteKey: noteKey('book', 'Unknown Obscure Book'),
      bookTitle: null,
      bookAuthor: null,
      bookYear: null,
      coverUrl: null,
      openlibraryUrl: null,
    });
  });

  it('is fire-and-forget: returns synchronously without awaiting the enrichment', () => {
    vi.mocked(getNoteMeta).mockReturnValue(new Promise(() => {})); // never resolves
    const result = enqueueNoteEnrichment([{ category: 'book', text: 'Dune' }]);
    expect(result).toBeUndefined();
  });

  it('logs and swallows errors instead of throwing', async () => {
    vi.mocked(getNoteMeta).mockRejectedValue(new Error('db down'));
    enqueueNoteEnrichment([{ category: 'book', text: 'Dune' }]);
    await flush();
    expect(logError).toHaveBeenCalledWith('note enrichment failed', expect.objectContaining({ err: expect.stringContaining('db down') }));
  });

  it('processes multiple book notes independently', async () => {
    vi.mocked(getNoteMeta).mockResolvedValue(null);
    vi.mocked(enrichBook).mockResolvedValue(null);
    enqueueNoteEnrichment([
      { category: 'book', text: 'Dune' },
      { category: 'book', text: 'Project Hail Mary' },
    ]);
    await flush();
    expect(getNoteMeta).toHaveBeenCalledTimes(2);
  });

  describe('place dispatch', () => {
    it('looks up existing meta by noteKey(category, text) and enriches via enrichPlace when missing', async () => {
      vi.mocked(getNoteMeta).mockResolvedValue(null);
      vi.mocked(enrichPlace).mockResolvedValue({
        placeName: 'Bar Luce', placeDisplayName: 'Bar Luce, Milano', placeLat: 45.44, placeLon: 9.19,
        osmUrl: 'https://www.openstreetmap.org/node/123456',
      });
      enqueueNoteEnrichment([{ category: 'place', text: 'Bar Luce' }]);
      await flush();
      expect(getNoteMeta).toHaveBeenCalledWith(noteKey('place', 'Bar Luce'));
      expect(enrichPlace).toHaveBeenCalledWith('Bar Luce');
      expect(enrichBook).not.toHaveBeenCalled();
      expect(upsertPlaceEnrichment).toHaveBeenCalledWith(expect.objectContaining({
        noteKey: noteKey('place', 'Bar Luce'),
        placeName: 'Bar Luce',
      }));
      expect(upsertNoteEnrichment).not.toHaveBeenCalled();
    });

    it('skips enrichment when existing place meta is fresh (not stale)', async () => {
      vi.mocked(getNoteMeta).mockResolvedValue({
        noteKey: noteKey('place', 'Bar Luce'),
        enrichedAt: '2026-01-01T00:00:00.000Z',
      } as never);
      vi.mocked(isStale).mockReturnValue(false);
      enqueueNoteEnrichment([{ category: 'place', text: 'Bar Luce' }]);
      await flush();
      expect(enrichPlace).not.toHaveBeenCalled();
    });

    it('re-enriches when existing place meta is stale', async () => {
      vi.mocked(getNoteMeta).mockResolvedValue({
        noteKey: noteKey('place', 'Bar Luce'),
        enrichedAt: '2020-01-01T00:00:00.000Z',
      } as never);
      vi.mocked(isStale).mockReturnValue(true);
      vi.mocked(enrichPlace).mockResolvedValue(null);
      enqueueNoteEnrichment([{ category: 'place', text: 'Bar Luce' }]);
      await flush();
      expect(enrichPlace).toHaveBeenCalled();
      // Miss still persists an all-null row (TTL), it just doesn't carry place data.
      expect(upsertPlaceEnrichment).toHaveBeenCalledWith(expect.objectContaining({
        noteKey: noteKey('place', 'Bar Luce'),
        placeName: null,
      }));
    });

    it('persists an all-null row (TTL) on a place enrichment miss, instead of leaving it un-cached', async () => {
      vi.mocked(getNoteMeta).mockResolvedValue(null);
      vi.mocked(enrichPlace).mockResolvedValue(null);
      enqueueNoteEnrichment([{ category: 'place', text: 'Somewhere Obscure' }]);
      await flush();
      expect(upsertPlaceEnrichment).toHaveBeenCalledWith({
        noteKey: noteKey('place', 'Somewhere Obscure'),
        placeName: null,
        placeDisplayName: null,
        placeLat: null,
        placeLon: null,
        osmUrl: null,
      });
    });

    it('logs and swallows errors instead of throwing', async () => {
      vi.mocked(getNoteMeta).mockRejectedValue(new Error('db down'));
      enqueueNoteEnrichment([{ category: 'place', text: 'Bar Luce' }]);
      await flush();
      expect(logError).toHaveBeenCalledWith('note enrichment failed', expect.objectContaining({ err: expect.stringContaining('db down') }));
    });

    it('processes a mix of book and place notes independently, dispatching to the right provider', async () => {
      vi.mocked(getNoteMeta).mockResolvedValue(null);
      vi.mocked(enrichBook).mockResolvedValue(null);
      vi.mocked(enrichPlace).mockResolvedValue(null);
      enqueueNoteEnrichment([
        { category: 'book', text: 'Dune' },
        { category: 'place', text: 'Bar Luce' },
      ]);
      await flush();
      expect(enrichBook).toHaveBeenCalledWith('Dune');
      expect(enrichPlace).toHaveBeenCalledWith('Bar Luce');
      expect(enrichBook).not.toHaveBeenCalledWith('Bar Luce');
      expect(enrichPlace).not.toHaveBeenCalledWith('Dune');
    });
  });
});
