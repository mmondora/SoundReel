import type { EntryResults } from '../types';
import { noteKey } from './noteMeta';

/**
 * Identity of a song inside an entry. Exported because the analyze route needs
 * the same notion of "already on this entry" to decide what a second pass may
 * send to Spotify — two definitions that drifted apart would put duplicates in
 * the playlist.
 */
export function songKey(title: string, artist: string): string {
  return `${title.toLowerCase().trim()}::${artist.toLowerCase().trim()}`;
}

function filmKey(title: string): string {
  return title.toLowerCase().trim();
}

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

/**
 * Fold a second analysis pass into an entry that already has results.
 *
 * Additive by design: this runs over hundreds of archived entries whose songs,
 * films and notes already carry enrichment keyed off their original text. A
 * pass that dropped anything the model failed to find the second time would
 * quietly destroy work that cannot be recovered.
 *
 * The summary is the exception that proves the rule — it is one string, so it
 * cannot be merged. An existing one is kept: it may well be better than what a
 * second pass produces, and there is no way to compare hundreds of them.
 */
export function mergeEntryResults(existing: EntryResults, incoming: EntryResults): EntryResults {
  const songs = [...existing.songs];
  const seenSongs = new Set(songs.map((s) => songKey(s.title, s.artist)));
  for (const s of incoming.songs) {
    const k = songKey(s.title, s.artist);
    if (!seenSongs.has(k)) {
      seenSongs.add(k);
      songs.push(s);
    }
  }

  const films = [...existing.films];
  const seenFilms = new Set(films.map((f) => filmKey(f.title)));
  for (const f of incoming.films) {
    const k = filmKey(f.title);
    if (!seenFilms.has(k)) {
      seenFilms.add(k);
      films.push(f);
    }
  }

  const notes = [...existing.notes];
  const seenNotes = new Set(notes.map((n) => noteKey(n.category, n.text)));
  for (const n of incoming.notes) {
    const k = noteKey(n.category, n.text);
    if (!seenNotes.has(k)) {
      seenNotes.add(k);
      notes.push(n);
    }
  }

  const links = [...existing.links];
  const seenLinks = new Set(links.map((l) => l.url));
  for (const l of incoming.links) {
    if (!seenLinks.has(l.url)) {
      seenLinks.add(l.url);
      links.push(l);
    }
  }

  return {
    ...existing,
    songs,
    films,
    notes,
    links,
    tags: [...new Set([...existing.tags, ...incoming.tags])],
    summary: isBlank(existing.summary) ? incoming.summary : existing.summary,
    transcript: incoming.transcript ?? existing.transcript ?? null,
  };
}
