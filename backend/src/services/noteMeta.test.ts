import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn() }));

import {
  normalizeNoteCategory,
  noteKey,
  upsertNoteEnrichment,
  upsertPlaceEnrichment,
  touchNoteEnrichedAt,
  listNoteMeta,
  getNoteMeta,
} from './noteMeta';
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

  it('never touches the place_* / osm_url columns', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertNoteEnrichment({
      noteKey: 'book::dune',
      bookTitle: 'Dune',
      bookAuthor: 'Frank Herbert',
      bookYear: 1965,
      coverUrl: null,
      openlibraryUrl: null,
    });
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).not.toMatch(/\bplace_name\b/);
    expect(sql).not.toMatch(/\bplace_display_name\b/);
    expect(sql).not.toMatch(/\bplace_lat\b/);
    expect(sql).not.toMatch(/\bplace_lon\b/);
    expect(sql).not.toMatch(/\bosm_url\b/);
  });
});

describe('upsertPlaceEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets enriched_at = now()', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertPlaceEnrichment({
      noteKey: 'place::bar luce',
      placeName: 'Bar Luce',
      placeDisplayName: 'Bar Luce, Largo Isarco, Milano, Lombardia, Italia',
      placeLat: 45.4408,
      placeLon: 9.19,
      osmUrl: 'https://www.openstreetmap.org/node/123456',
    });
    const sql = vi.mocked(query).mock.calls[0][0];
    expect(sql).toContain('enriched_at = now()');
  });

  it('upserts on conflict by note_key', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertPlaceEnrichment({
      noteKey: 'place::bar luce',
      placeName: 'Bar Luce',
      placeDisplayName: null,
      placeLat: 45.4408,
      placeLon: 9.19,
      osmUrl: null,
    });
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (note_key) DO UPDATE SET');
    expect(params).toEqual(['place::bar luce', 'Bar Luce', null, 45.4408, 9.19, null]);
  });

  it('never touches the book_* / cover_url / openlibrary_url columns', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertPlaceEnrichment({
      noteKey: 'place::bar luce',
      placeName: 'Bar Luce',
      placeDisplayName: null,
      placeLat: 45.4408,
      placeLon: 9.19,
      osmUrl: null,
    });
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).not.toMatch(/\bbook_title\b/);
    expect(sql).not.toMatch(/\bbook_author\b/);
    expect(sql).not.toMatch(/\bbook_year\b/);
    expect(sql).not.toMatch(/\bcover_url\b/);
    expect(sql).not.toMatch(/\bopenlibrary_url\b/);
  });
});

describe('touchNoteEnrichedAt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets enriched_at = now() (and updated_at = now()) keyed by note_key', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await touchNoteEnrichedAt('place::somewhere obscure');
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('enriched_at = now()');
    expect(sql).toContain('updated_at = now()');
    expect(sql).toContain('ON CONFLICT (note_key) DO UPDATE SET');
    expect(params).toEqual(['place::somewhere obscure']);
  });

  it('touches ONLY the timestamp columns — never book_* or place_* data columns (the wipe-bug regression guard)', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await touchNoteEnrichedAt('book::unknown obscure book');
    const sql = vi.mocked(query).mock.calls[0][0] as string;
    expect(sql).not.toMatch(/\bbook_title\b/);
    expect(sql).not.toMatch(/\bbook_author\b/);
    expect(sql).not.toMatch(/\bbook_year\b/);
    expect(sql).not.toMatch(/\bcover_url\b/);
    expect(sql).not.toMatch(/\bopenlibrary_url\b/);
    expect(sql).not.toMatch(/\bplace_name\b/);
    expect(sql).not.toMatch(/\bplace_display_name\b/);
    expect(sql).not.toMatch(/\bplace_lat\b/);
    expect(sql).not.toMatch(/\bplace_lon\b/);
    expect(sql).not.toMatch(/\bosm_url\b/);
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
        place_name: null,
        place_display_name: null,
        place_lat: null,
        place_lon: null,
        osm_url: null,
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

  it('maps place_* / osm_url columns into the record', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        note_key: 'place::bar luce',
        book_title: null,
        book_author: null,
        book_year: null,
        cover_url: null,
        openlibrary_url: null,
        place_name: 'Bar Luce',
        place_display_name: 'Bar Luce, Largo Isarco, Milano, Lombardia, Italia',
        place_lat: 45.4408,
        place_lon: 9.19,
        osm_url: 'https://www.openstreetmap.org/node/123456',
        enriched_at: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const map = await listNoteMeta();
    const rec = map.get('place::bar luce');
    expect(rec?.placeName).toBe('Bar Luce');
    expect(rec?.placeDisplayName).toBe('Bar Luce, Largo Isarco, Milano, Lombardia, Italia');
    expect(rec?.placeLat).toBe(45.4408);
    expect(rec?.placeLon).toBe(9.19);
    expect(rec?.osmUrl).toBe('https://www.openstreetmap.org/node/123456');
  });

  it('returns an empty Map when there are no rows', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    const map = await listNoteMeta();
    expect(map.size).toBe(0);
  });
});

describe('getNoteMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no row is found', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    expect(await getNoteMeta('place::nowhere')).toBeNull();
  });

  it('maps a found row, including place fields', async () => {
    vi.mocked(query).mockResolvedValueOnce([
      {
        note_key: 'place::bar luce',
        book_title: null,
        book_author: null,
        book_year: null,
        cover_url: null,
        openlibrary_url: null,
        place_name: 'Bar Luce',
        place_display_name: 'Bar Luce, Largo Isarco, Milano',
        place_lat: 45.4408,
        place_lon: 9.19,
        osm_url: 'https://www.openstreetmap.org/node/123456',
        enriched_at: null,
      },
    ]);
    const rec = await getNoteMeta('place::bar luce');
    expect(rec?.placeName).toBe('Bar Luce');
    expect(rec?.osmUrl).toBe('https://www.openstreetmap.org/node/123456');
  });
});
