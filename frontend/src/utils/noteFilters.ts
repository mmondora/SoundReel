import type { AggregatedNote, NoteCategory } from '../types';

export interface NoteFilterOptions {
  /** OR across selected categories; empty = no filtering. */
  categories: NoteCategory[];
  /** Case-insensitive containment search over note text + meta bookTitle/bookAuthor. Empty/omitted = no filtering. */
  text?: string;
}

export function filterNotes(notes: AggregatedNote[], opts: NoteFilterOptions): AggregatedNote[] {
  const query = opts.text?.trim().toLowerCase() ?? '';
  return notes.filter((note) => {
    if (opts.categories.length > 0 && !opts.categories.includes(note.category)) return false;
    if (query) {
      const haystack = [note.text, note.meta?.bookTitle, note.meta?.bookAuthor];
      if (!haystack.some((field) => field != null && field.toLowerCase().includes(query))) return false;
    }
    return true;
  });
}

// Not alphabetical on purpose — mirrors the order categories are introduced
// to the user elsewhere (EntryCard/EntryInspector note badges).
const CANONICAL_CATEGORY_ORDER: NoteCategory[] = [
  'place', 'event', 'brand', 'book', 'product', 'quote', 'person', 'other',
];

/** Categories actually present among `notes`, in canonical (not alphabetical) order. */
export function collectCategories(notes: AggregatedNote[]): NoteCategory[] {
  const present = new Set<NoteCategory>();
  for (const note of notes) present.add(note.category);
  return CANONICAL_CATEGORY_ORDER.filter((c) => present.has(c));
}

export type NoteSortMode = 'date' | 'mentions';

function latestMentionTime(note: AggregatedNote): number {
  return note.mentions[0] ? new Date(note.mentions[0].createdAt).getTime() : 0;
}

/**
 * Sort modes: 'date' = most recent mention first (default); 'mentions' =
 * mention count desc, ties by most recent mention. Mirrors sortSongs.
 */
export function sortNotes(notes: AggregatedNote[], mode: NoteSortMode): AggregatedNote[] {
  const byDate = (a: AggregatedNote, b: AggregatedNote) => latestMentionTime(b) - latestMentionTime(a);
  const sorted = [...notes];
  if (mode === 'mentions') {
    sorted.sort((a, b) => b.mentions.length - a.mentions.length || byDate(a, b));
  } else {
    sorted.sort(byDate);
  }
  return sorted;
}
