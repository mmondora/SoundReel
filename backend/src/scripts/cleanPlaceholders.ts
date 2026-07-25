/**
 * One-off cleanup: strip items where an earlier analysis stored the prompt
 * template's own placeholders instead of extracted content — songs/films/notes
 * whose title or text is `"..."`, `"null"`, `"anno o null"` and similar.
 *
 * The pipeline now filters these at extraction time (services/placeholderFilter.ts),
 * so this only repairs records written before that guard existed.
 *
 * Usage (inside the container):
 *   node dist/scripts/cleanPlaceholders.js --dry-run   # report only
 *   node dist/scripts/cleanPlaceholders.js             # apply
 */
import { pool, updateEntry, appendActionLog, createActionLog } from '../utils/db';
import { isRealValue, isPlaceholderText } from '../services/placeholderFilter';
import type { Entry, EntryResults } from '../types';

interface Row {
  id: string;
  results: EntryResults;
}

interface Cleaned {
  results: EntryResults;
  removed: { songs: number; films: number; notes: number; tags: number };
  blanked: number;
  changed: boolean;
}

function clean(results: EntryResults): Cleaned {
  const songsIn = results.songs ?? [];
  const filmsIn = results.films ?? [];
  const notesIn = results.notes ?? [];
  const tagsIn = results.tags ?? [];

  const songs = songsIn.filter((s) => isRealValue(s?.title));
  const films = filmsIn.filter((f) => isRealValue(f?.title));
  const notes = notesIn.filter((n) => isRealValue(n?.text));
  const tags = tagsIn.filter(isRealValue);

  // A placeholder in a secondary field (artist, director, year) does not make
  // the whole item junk — blank the field and keep the item. isPlaceholderText
  // is used rather than isPlaceholderValue so that absent/empty fields, which
  // hold no junk, do not count as changes and cause needless rewrites.
  let blanked = 0;
  const songsFixed = songs.map((s) => {
    const artistBad = isPlaceholderText(s.artist);
    const albumBad = isPlaceholderText(s.album);
    if (artistBad || albumBad) blanked++;
    return {
      ...s,
      artist: artistBad ? '' : s.artist,
      album: albumBad ? null : s.album,
    };
  });
  const filmsFixed = films.map((f) => {
    const dirBad = isPlaceholderText(f.director);
    const yearBad = isPlaceholderText(f.year);
    if (dirBad || yearBad) blanked++;
    return {
      ...f,
      director: dirBad ? null : f.director,
      year: yearBad ? null : f.year,
    };
  });

  const summaryBad = isPlaceholderText(results.summary);
  if (summaryBad) blanked++;

  const removed = {
    songs: songsIn.length - songs.length,
    films: filmsIn.length - films.length,
    notes: notesIn.length - notes.length,
    tags: tagsIn.length - tags.length,
  };

  const changed =
    removed.songs > 0 || removed.films > 0 || removed.notes > 0 || removed.tags > 0 || blanked > 0;

  return {
    results: {
      ...results,
      songs: songsFixed,
      films: filmsFixed,
      notes,
      tags,
      summary: summaryBad ? null : results.summary,
    },
    removed,
    blanked,
    changed,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const { rows } = await pool.query<Row>('SELECT id, results FROM entries');
  console.log(`[clean] entry esaminate: ${rows.length}${dryRun ? ' | DRY RUN (nessuna modifica)' : ''}`);

  let touched = 0;
  const totals = { songs: 0, films: 0, notes: 0, tags: 0, blanked: 0 };

  for (const row of rows) {
    const res = clean(row.results);
    if (!res.changed) continue;

    touched++;
    totals.songs += res.removed.songs;
    totals.films += res.removed.films;
    totals.notes += res.removed.notes;
    totals.tags += res.removed.tags;
    totals.blanked += res.blanked;

    const detail = [
      res.removed.songs && `${res.removed.songs} songs`,
      res.removed.films && `${res.removed.films} films`,
      res.removed.notes && `${res.removed.notes} notes`,
      res.removed.tags && `${res.removed.tags} tags`,
      res.blanked && `${res.blanked} campi ripuliti`,
    ].filter(Boolean).join(', ');
    console.log(`  ${row.id} — ${detail}`);

    if (dryRun) continue;

    await updateEntry(row.id, { results: res.results as unknown as Entry['results'] });
    await appendActionLog(row.id, createActionLog('placeholder_cleanup', {
      removed: res.removed,
      blankedFields: res.blanked,
    }));
  }

  console.log(
    `\n[clean] ${dryRun ? 'da correggere' : 'corrette'}: ${touched} entry | ` +
    `rimossi ${totals.songs} songs, ${totals.films} films, ${totals.notes} notes, ${totals.tags} tags | ` +
    `${totals.blanked} campi ripuliti`
  );
  await pool.end();
}

main().catch((err) => {
  console.error('[clean] errore fatale', err);
  process.exit(1);
});
