/**
 * The media server's own catalogue, kept as a table (`media_index`, migration 016) so matching a song
 * never needs a live scan of the share. Filled by services/mediaServer.ts (DLNA ContentDirectory).
 */
import { pool, query } from '../utils/db';
import { normalizeForMatch } from './musicLibrary';

export interface IndexItem {
  store: string;
  /** Path relative to the media server's volume, decoded (the URL carries it percent-encoded). */
  relPath: string;
  artist: string;
  title: string;
  album: string | null;
  durationS: number | null;
  bytes: number | null;
}

export interface IndexHit extends IndexItem {
  normKey: string;
}

/** Smaller than this is a macOS `._*` shadow file or a stub, never a song. */
export const MIN_INDEX_BYTES = 200 * 1024;

export function normKey(artist: string, title: string): string {
  return `${normalizeForMatch(artist)}|${normalizeForMatch(title)}`;
}

const baseName = (relPath: string): string => relPath.split('/').pop() ?? relPath;

/** True for entries that must never reach the index or a match. */
export function isJunk(item: Pick<IndexItem, 'relPath' | 'bytes'>): boolean {
  if (baseName(item.relPath).startsWith('._')) return true;
  if (!item.relPath.toLowerCase().endsWith('.mp3')) return true;
  return item.bytes !== null && item.bytes < MIN_INDEX_BYTES;
}

interface Row {
  store: string;
  rel_path: string;
  artist: string;
  title: string;
  album: string | null;
  duration_s: number | null;
  bytes: string | number | null;
  norm_key: string;
}

const CHUNK = 500;

/** Replace the whole index of one store in a single transaction (readers never see a half-filled index). */
export async function replaceMediaIndex(store: string, items: IndexItem[]): Promise<number> {
  const unique = new Map<string, IndexItem>();
  for (const item of items) {
    if (!isJunk(item) && item.artist && item.title) unique.set(item.relPath, item);
  }
  const rows = [...unique.values()];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM media_index WHERE store = $1', [store]);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      await client.query(
        `INSERT INTO media_index (store, rel_path, artist, title, album, duration_s, bytes, norm_key)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::bigint[], $8::text[])
         ON CONFLICT (store, rel_path) DO NOTHING`,
        [
          store,
          part.map((r) => r.relPath),
          part.map((r) => r.artist),
          part.map((r) => r.title),
          part.map((r) => r.album),
          part.map((r) => r.durationS),
          part.map((r) => r.bytes),
          part.map((r) => normKey(r.artist, r.title)),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return rows.length;
}

export async function countMediaIndex(store: string): Promise<number> {
  const rows = await query<{ n: string | number }>('SELECT COUNT(*) AS n FROM media_index WHERE store = $1', [store]);
  return Number(rows[0]?.n ?? 0);
}

/** One file the catalogue says exists on the box: a control to tell "this file is gone" from "the whole volume is gone". */
export async function sampleMediaIndexPath(store: string): Promise<string | null> {
  const rows = await query<{ rel_path: string }>(`SELECT rel_path FROM media_index WHERE store = $1 ORDER BY random() LIMIT 1`, [store]);
  return rows[0]?.rel_path ?? null;
}

export async function lookupMediaIndex(artist: string, title: string): Promise<IndexHit[]> {
  const rows = await query<Row>(
    `SELECT store, rel_path, artist, title, album, duration_s, bytes, norm_key
       FROM media_index WHERE norm_key = $1 ORDER BY bytes DESC NULLS LAST LIMIT 20`,
    [normKey(artist, title)],
  );
  return rows.map((r) => ({
    store: r.store,
    relPath: r.rel_path,
    artist: r.artist,
    title: r.title,
    album: r.album,
    durationS: r.duration_s,
    bytes: r.bytes === null ? null : Number(r.bytes),
    normKey: r.norm_key,
  }));
}

/** Versions of a song a playlist almost never wants; the normalized key ignores "(Live)" so they collide with the studio cut. */
const UNWANTED = ['live', 'bootleg', 'demo', 'karaoke', 'remix', 'instrumental', 'acoustic', 'cover', 'tribute'];

const hasWord = (haystack: string, word: string): boolean =>
  new RegExp(`(?:^|[^a-z0-9])${word}(?:[^a-z0-9]|$)`).test(haystack);

/**
 * Pick the file to reuse from the hits for one song: never junk, never a live/bootleg/remix version unless
 * that is what was asked for, then the best-looking name and the biggest file (a proxy for quality).
 */
export function chooseIndexHit(
  hits: IndexHit[],
  wanted: { artist: string; title: string },
): IndexHit | null {
  const wantedText = `${wanted.artist} ${wanted.title}`.toLowerCase();
  const candidates = hits.filter((h) => {
    if (isJunk(h)) return false;
    const seen = `${h.title} ${h.album ?? ''} ${h.relPath}`.toLowerCase();
    return !UNWANTED.some((w) => hasWord(seen, w) && !hasWord(wantedText, w));
  });
  if (candidates.length === 0) return null;

  const exact = (h: IndexHit): number => (h.title.trim().toLowerCase() === wanted.title.trim().toLowerCase() ? 1 : 0);
  return [...candidates].sort(
    (a, b) => exact(b) - exact(a) || (b.bytes ?? 0) - (a.bytes ?? 0) || a.relPath.localeCompare(b.relPath),
  )[0];
}
