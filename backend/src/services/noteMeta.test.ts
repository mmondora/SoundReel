import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn() }));

import { normalizeNoteCategory, noteKey, upsertNoteEnrichment, listNoteMeta } from './noteMeta';
import { query } from '../utils/db';

describe('normalizeNoteCategory', () => {
  const CANONICAL = ['place', 'event', 'brand', 'book', 'product', 'quote', 'person', 'other'];

  it('passes through every canonical category unchanged', () => {
    for (const c of CANONICAL) {
      expect(normalizeNoteCategory(c)).toBe(c);
    }
  });

  it('is case-insensitive', () => {
    expect(normalizeNoteCategory('BOOK')).toBe('book');
    expect(normalizeNoteCategory('Place')).toBe('place');
  });

  it('maps unknown categories to other', () => {
    expect(normalizeNoteCategory('note')).toBe('other');
    expect(normalizeNoteCategory('link')).toBe('other');
    expect(normalizeNoteCategory('service')).toBe('other');
    expect(normalizeNoteCategory('anything-else')).toBe('other');
  });

  it('maps null/undefined/empty to other', () => {
    expect(normalizeNoteCategory(null)).toBe('other');
    expect(normalizeNoteCategory(undefined)).toBe('other');
    expect(normalizeNoteCategory('')).toBe('other');
  });
});

describe('noteKey', () => {
  it('combines normalized category and normalized text', () => {
    expect(noteKey('book', 'Dune')).toBe('book::dune');
  });

  it('trims and lowercases text, collapses internal whitespace', () => {
    expect(noteKey('book', '  Project   Hail   Mary  ')).toBe('book::project hail mary');
  });

  it('normalizes an unknown category to other', () => {
    expect(noteKey('note', 'Some place')).toBe('other::some place');
  });

  it('normalizes a null category to other', () => {
    expect(noteKey(null, 'Some place')).toBe('other::some place');
  });

  it('is case-insensitive on the category', () => {
    expect(noteKey('BOOK', 'Dune')).toBe(noteKey('book', 'Dune'));
  });
});

describe('upsertNoteEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets enriched_at = now()', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertNoteEnrichment({
      noteKey: 'book::dune',
      bookTitle: 'Dune',
      bookAuthor: 'Frank Herbert',
      bookYear: 1965,
      coverUrl: 'https://covers.openlibrary.org/b/id/1-M.jpg',
      openlibraryUrl: 'https://openlibrary.org/works/OL1W',
    });
    const sql = vi.mocked(query).mock.calls[0][0];
    expect(sql).toContain('enriched_at = now()');
  });

  it('upserts on conflict by note_key', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertNoteEnrichment({
      noteKey: 'book::dune',
      bookTitle: 'Dune',
      bookAuthor: 'Frank Herbert',
      bookYear: 1965,
      coverUrl: null,
      openlibraryUrl: null,
    });
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (note_key) DO UPDATE SET');
    expect(params).toEqual(['book::dune', 'Dune', 'Frank Herbert', 1965, null, null]);
  });
});

describe('listNoteMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a Map keyed by note_key', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        note_key: 'book::dune',
        book_title: 'Dune',
        book_author: 'Frank Herbert',
        book_year: 1965,
        cover_url: 'https://covers.openlibrary.org/b/id/1-M.jpg',
        openlibrary_url: 'https://openlibrary.org/works/OL1W',
        enriched_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const map = await listNoteMeta();
    expect(map.size).toBe(1);
    const rec = map.get('book::dune');
    expect(rec?.bookTitle).toBe('Dune');
    expect(rec?.bookAuthor).toBe('Frank Herbert');
    expect(rec?.bookYear).toBe(1965);
    expect(rec?.enrichedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns an empty Map when there are no rows', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    const map = await listNoteMeta();
    expect(map.size).toBe(0);
  });
});
