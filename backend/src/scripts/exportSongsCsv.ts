/**
 * A read-only CSV of the songs SoundReel knows, for the Mac import (ADR-0012): the agent that copies Michele's music
 * onto the box matches the new MP3s against this list to avoid duplicates, then brings back the ones that match nothing.
 *
 * Columns: `song_id` (the song key the API uses), `artist`, `title`, `album`, `media_rel_path` (the file of the media
 * server the song is bound to, or else the one SoundReel would reuse for it by name; empty when there is none) and
 * `norm_key` (the key `media_index` is matched with: `normalizeForMatch(artist)|normalizeForMatch(title)`, so the
 * agent's own matching can use the very same one).
 *
 * Names and paths only: no URL, no key, no credential. It writes nothing anywhere but its standard output.
 *
 * Usage:  node dist/scripts/exportSongsCsv.js > songs-export.csv
 */
import { chooseIndexHit, lookupMediaIndex, normKey } from '../services/mediaIndex';
import { FAMILY_USERS, ANONYMOUS_USER } from '../utils/requestUser';

export const HEADER = ['song_id', 'artist', 'title', 'album', 'media_rel_path', 'norm_key'] as const;

export interface ExportSong {
  songKey: string;
  artist: string;
  title: string;
  album: string | null;
}

export interface Deps {
  /** Every distinct song of every user (the journal is private per user, the library is the union). */
  songs: () => Promise<ExportSong[]>;
  /** song key -> the media-server path the song is bound to (`song_files.media_rel_path`). */
  bound: () => Promise<Map<string, string>>;
  /** The file SoundReel would reuse for this song by name, if any. */
  match: (artist: string, title: string) => Promise<string | null>;
}

/** RFC 4180: quote when the value holds a comma, a quote or a line break; double the quotes. */
export function csvField(value: string | null | undefined): string {
  const text = value ?? '';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (fields: Array<string | null | undefined>): string => fields.map(csvField).join(',');

export async function buildCsv(deps: Deps): Promise<{ csv: string; songs: number; withFile: number }> {
  const [songs, bound] = await Promise.all([deps.songs(), deps.bound()]);
  const sorted = [...songs].sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title) || a.songKey.localeCompare(b.songKey));
  const lines = [csvLine([...HEADER])];
  let withFile = 0;
  for (const s of sorted) {
    const path = bound.get(s.songKey) ?? (await deps.match(s.artist, s.title)) ?? '';
    if (path) withFile += 1;
    lines.push(csvLine([s.songKey, s.artist, s.title, s.album, path, normKey(s.artist, s.title)]));
  }
  return { csv: `${lines.join('\n')}\n`, songs: sorted.length, withFile };
}

async function main(): Promise<void> {
  const [{ pool }, { getUserSongs }] = await Promise.all([import('../utils/db'), import('../services/userSongs')]);
  try {
    const csv = await buildCsv({
      songs: async () => {
        const distinct = new Map<string, ExportSong>();
        for (const user of [...FAMILY_USERS, ANONYMOUS_USER]) {
          for (const [key, s] of await getUserSongs(user, false, 0)) {
            if (!distinct.has(key)) distinct.set(key, { songKey: key, artist: s.artist, title: s.title, album: s.album ?? null });
          }
        }
        return [...distinct.values()];
      },
      bound: async () => {
        const { rows } = await pool.query<{ song_key: string; media_rel_path: string }>(
          `SELECT song_key, media_rel_path FROM song_files WHERE media_rel_path IS NOT NULL AND media_rel_path <> ''`,
        );
        return new Map(rows.map((r) => [r.song_key, r.media_rel_path]));
      },
      match: async (artist, title) => chooseIndexHit(await lookupMediaIndex(artist, title), { artist, title })?.relPath ?? null,
    });
    process.stdout.write(csv.csv);
    process.stderr.write(`[export] ${csv.songs} canzoni, ${csv.withFile} con un file sul media server\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[export] errore fatale', err);
    process.exit(1);
  });
}
