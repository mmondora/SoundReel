/**
 * "Scegli cosa suonare" (spec 2026-11-08-player-selection-and-filters-design.md X4): what the player does with the
 * result of the filters — the name of the queue it becomes, its order, the "mescola" option.
 */
import type { ManagerFilters } from './managerSongs';
import { NO_YEAR, decadeLabelFor, normalizeSearch } from './songFacets';
import type { DecadeValue } from './songFacets';

export interface SelectionWords {
  language: 'it' | 'en';
  noYear: string;
  /** "Ricerca: {q}" */
  search: (q: string) => string;
}

const MAX_PARTS = 4;

/**
 * A short name for the queue a selection becomes ("Anni 80 · Elettronica"), or null when nothing is picked (the
 * caller then names the queue after the shelf or the playlist). The playlist, when there is one, comes first.
 */
export function selectionLabel(filters: ManagerFilters, words: SelectionWords, playlistName?: string | null): string | null {
  const parts: string[] = [];
  if (playlistName) parts.push(playlistName);
  const decade = (d: DecadeValue): string => (d === NO_YEAR ? words.noYear : decadeLabelFor(d, words.language));
  if (filters.decades.length > 0) parts.push(filters.decades.map(decade).join(' + '));
  if (filters.genres.length > 0) parts.push(filters.genres.join(' + '));
  if (filters.albums.length > 0) parts.push(filters.albums.join(' + '));
  if (filters.artists.length > 0) parts.push(filters.artists.join(' + '));
  const text = filters.text.trim().replace(/\s+/g, ' ');
  if (normalizeSearch(text)) parts.push(words.search(text));
  if (parts.length === 0) return null;
  const shown = parts.slice(0, MAX_PARTS).join(' · ');
  return parts.length > MAX_PARTS ? `${shown} …` : shown;
}

/** A fresh random order (Fisher–Yates), the first song included: "mescola e suona" starts anywhere. */
export function shuffled<T>(songs: readonly T[], random: () => number = Math.random): T[] {
  const out = [...songs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
