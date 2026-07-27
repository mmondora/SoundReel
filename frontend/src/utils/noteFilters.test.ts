import { describe, it, expect } from 'vitest';
import { filterNotes, collectCategories, sortNotes } from './noteFilters';
import type { AggregatedNote, NoteCategory } from '../types';

function note(key: string, category: NoteCategory, text: string, meta: Partial<NonNullable<AggregatedNote['meta']>> | null = null): AggregatedNote {
  return {
    noteKey: key,
    text,
    category,
    mentions: [],
    meta: meta === null ? null : {
      noteKey: key, bookTitle: null, bookAuthor: null, bookYear: null,
      coverUrl: null, openlibraryUrl: null, enrichedAt: null,
      ...meta,
    },
  };
}

const NOTES = [
  note('a', 'place', 'Bar Luce, Milano'),
  note('b', 'book', 'Interessante libro sulla filosofia', { bookTitle: 'Sapiens', bookAuthor: 'Yuval Noah Harari' }),
  note('c', 'quote', 'La vita è altrove'),
];

describe('filterNotes', () => {
  it('no filters returns everything', () => {
    expect(filterNotes(NOTES, { categories: [] })).toHaveLength(3);
  });

  it('category filter is OR across selected categories', () => {
    const out = filterNotes(NOTES, { categories: ['place', 'quote'] });
    expect(out.map((n) => n.noteKey)).toEqual(['a', 'c']);
  });

  it('single category filter', () => {
    const out = filterNotes(NOTES, { categories: ['book'] });
    expect(out.map((n) => n.noteKey)).toEqual(['b']);
  });

  it('empty text matches everything', () => {
    expect(filterNotes(NOTES, { categories: [], text: '' })).toHaveLength(3);
  });

  it('matches note text case-insensitively', () => {
    const out = filterNotes(NOTES, { categories: [], text: 'MILANO' });
    expect(out.map((n) => n.noteKey)).toEqual(['a']);
  });

  it('matches meta.bookTitle', () => {
    const out = filterNotes(NOTES, { categories: [], text: 'sapiens' });
    expect(out.map((n) => n.noteKey)).toEqual(['b']);
  });

  it('matches meta.bookAuthor', () => {
    const out = filterNotes(NOTES, { categories: [], text: 'harari' });
    expect(out.map((n) => n.noteKey)).toEqual(['b']);
  });

  it('no match returns empty', () => {
    expect(filterNotes(NOTES, { categories: [], text: 'nonexistent' })).toHaveLength(0);
  });

  it('combines category and text filters (AND)', () => {
    const out = filterNotes(NOTES, { categories: ['book'], text: 'harari' });
    expect(out.map((n) => n.noteKey)).toEqual(['b']);
    expect(filterNotes(NOTES, { categories: ['place'], text: 'harari' })).toHaveLength(0);
  });
});

describe('collectCategories', () => {
  it('returns present categories in canonical order, not alphabetical', () => {
    // Alphabetical would be book, place, quote — canonical order is place, book, quote.
    expect(collectCategories(NOTES)).toEqual(['place', 'book', 'quote']);
  });

  it('excludes categories with no notes', () => {
    const out = collectCategories([note('x', 'event', 'Concerto')]);
    expect(out).toEqual(['event']);
  });

  it('empty notes returns empty array', () => {
    expect(collectCategories([])).toEqual([]);
  });

  it('full canonical order when all categories present', () => {
    const all: AggregatedNote[] = [
      note('1', 'place', 't'), note('2', 'event', 't'), note('3', 'brand', 't'), note('4', 'book', 't'),
      note('5', 'product', 't'), note('6', 'quote', 't'), note('7', 'person', 't'), note('8', 'other', 't'),
    ];
    expect(collectCategories(all)).toEqual(['place', 'event', 'brand', 'book', 'product', 'quote', 'person', 'other']);
  });
});

describe('sortNotes', () => {
  const mk = (key: string, dates: string[]): AggregatedNote => ({
    noteKey: key, text: key, category: 'other',
    mentions: dates.map((d, i) => ({ entryId: `e${i}`, createdAt: d })), meta: null,
  });
  const older = mk('older', ['2026-01-01T00:00:00Z']);
  const newest = mk('newest', ['2026-07-01T00:00:00Z']);
  const popular = mk('popular', ['2026-03-01T00:00:00Z', '2026-02-01T00:00:00Z']);

  it('date: most recent mention first', () => {
    expect(sortNotes([older, popular, newest], 'date').map((n) => n.noteKey)).toEqual(['newest', 'popular', 'older']);
  });

  it('mentions: count desc, ties by date', () => {
    expect(sortNotes([older, newest, popular], 'mentions').map((n) => n.noteKey)).toEqual(['popular', 'newest', 'older']);
  });

  it('note with no mentions sorts last by date', () => {
    const noMentions = mk('none', []);
    expect(sortNotes([older, noMentions], 'date').map((n) => n.noteKey)).toEqual(['older', 'none']);
  });
});
