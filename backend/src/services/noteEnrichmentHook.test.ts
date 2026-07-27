import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./noteMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./noteMeta')>();
  return {
    noteKey: actual.noteKey,
    normalizeNoteCategory: actual.normalizeNoteCategory,
    getNoteMeta: vi.fn(),
    upsertNoteEnrichment: vi.fn(),
  };
});
vi.mock('./bookEnrichment', () => ({ enrichBook: vi.fn() }));
vi.mock('./streamingRefresher', () => ({ isStale: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { enqueueNoteEnrichment } from './noteEnrichmentHook';
import { getNoteMeta, upsertNoteEnrichment, noteKey } from './noteMeta';
import { enrichBook } from './bookEnrichment';
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

  it('skips non-book categories', async () => {
    enqueueNoteEnrichment([
      { category: 'place', text: 'Eiffel Tower' },
      { category: 'quote', text: 'To be or not to be' },
      { category: 'other', text: 'Something else' },
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
    expect(upsertNoteEnrichment).not.toHaveBeenCalled();
  });

  it('does not persist on an enrichment miss', async () => {
    vi.mocked(getNoteMeta).mockResolvedValue(null);
    vi.mocked(enrichBook).mockResolvedValue(null);
    enqueueNoteEnrichment([{ category: 'book', text: 'Unknown Obscure Book' }]);
    await flush();
    expect(upsertNoteEnrichment).not.toHaveBeenCalled();
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
});
