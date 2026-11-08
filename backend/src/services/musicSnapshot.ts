/**
 * The media server's catalogue as the library search and the per-song location use it: the whole `media_index`
 * table held in memory for a minute, each file with a normalised search text, and a lookup by `artist|title`.
 * (~3 500 rows today; the table is refreshed hourly from the box's DLNA catalogue by services/mediaServer.)
 */
import { query } from '../utils/db';
import { normalizeSearch } from '../utils/searchText';

export interface MediaFile {
  /** Path on the box's volume, as its URLs carry it. */
  relPath: string;
  artist: string;
  title: string;
  album: string | null;
  bytes: number | null;
  /** `artist|title` as services/mediaIndex.normKey makes it. */
  normKey: string;
  searchText: string;
}

export interface MediaSnapshot {
  files: MediaFile[];
  byNormKey: Map<string, MediaFile[]>;
}

interface Row {
  rel_path: string;
  artist: string;
  title: string;
  album: string | null;
  bytes: string | number | null;
  norm_key: string;
}

const TTL_MS = 60_000;
let cache: { at: number; snapshot: MediaSnapshot } | null = null;
let inflight: Promise<MediaSnapshot> | null = null;

export async function getMediaSnapshot(maxAgeMs = TTL_MS): Promise<MediaSnapshot> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.snapshot;
  inflight ??= query<Row>(`SELECT rel_path, artist, title, album, bytes, norm_key FROM media_index WHERE store = 'fritz'`)
    .then((rows) => {
      const files: MediaFile[] = rows.map((r) => ({
        relPath: r.rel_path,
        artist: r.artist,
        title: r.title,
        album: r.album,
        bytes: r.bytes === null ? null : Number(r.bytes),
        normKey: r.norm_key,
        searchText: normalizeSearch(`${r.artist} ${r.title} ${r.album ?? ''} ${r.rel_path}`),
      }));
      const byNormKey = new Map<string, MediaFile[]>();
      for (const f of files) {
        const list = byNormKey.get(f.normKey);
        if (list) list.push(f);
        else byNormKey.set(f.normKey, [f]);
      }
      const snapshot = { files, byNormKey };
      cache = { at: Date.now(), snapshot };
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidateMediaSnapshot(): void {
  cache = null;
}
