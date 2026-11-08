/**
 * Retire the copies 2.7.0 made: a song whose file was COPIED from the media server onto geekom's disk
 * (`source = 'existing'`). Since 2.8.0 the song simply is the box's file (ADR-0010), so the copy is dead weight and
 * the nightly mirror would even send it back as a duplicate.
 *
 * Careful by construction — a file is removed only when ALL of these hold:
 *   - it sits inside our own store folder (never anywhere else in the library),
 *   - its original is found on the box and answers a HEAD,
 *   - the original has exactly the same number of bytes (the copy was made from that very file).
 * Anything else is left alone.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logInfo, logWarning } from '../utils/logger';
import { logActivity, songLabel, SYSTEM_ACTOR } from './activityLog';
import { findMediaServerMatch } from './fileResolver';
import { invalidateLibraryTracks } from './libraryCache';
import { headMediaFile, mediaUrlForVolumePath } from './mediaServer';
import { absFromRel, fileFacts, libraryRoot, storeDir } from './musicStore';
import { listLegacyCopies, markMediaOnly, type SongFile } from './songFiles';

export interface RetireResult {
  retired: number;
  kept: number;
}

interface Deps {
  list: () => Promise<SongFile[]>;
  head: typeof headMediaFile;
  findOriginal: (artist: string, title: string) => Promise<{ relPath: string; bytes: number | null } | null>;
}

const defaultDeps: Deps = { list: () => listLegacyCopies(), head: headMediaFile, findOriginal: findMediaServerMatch };

export async function retireMediaServerCopies(deps: Partial<Deps> = {}): Promise<RetireResult> {
  const { list, head, findOriginal } = { ...defaultDeps, ...deps };
  const root = libraryRoot();
  if (!root) return { retired: 0, kept: 0 };
  const storeAbs = path.join(path.resolve(root), storeDir());
  let retired = 0;
  let kept = 0;

  for (const row of await list()) {
    try {
      const abs = row.relPath ? absFromRel(row.relPath, root) : null;
      if (!abs || !abs.startsWith(storeAbs + path.sep)) {
        kept += 1; // never delete outside our own folder
        continue;
      }
      const local = await fileFacts(abs);
      if (!local) {
        kept += 1; // already gone: the normal "vanished" handling takes it from here
        continue;
      }

      // Where is the original? Recorded for copies made by the 2.8.0 drafts; for 2.7.0 copies: the catalogue's hit of the same size.
      let originalRel = row.mediaRelPath;
      if (!originalRel) {
        const hit = await findOriginal(row.artist, row.title);
        if (hit && hit.bytes === local.bytes) originalRel = hit.relPath;
      }
      if (!originalRel) {
        kept += 1;
        continue;
      }

      const url = mediaUrlForVolumePath(originalRel);
      const res = await head(url);
      if (res.kind !== 'ok' || res.bytes !== local.bytes) {
        kept += 1; // the box does not vouch for a byte-identical original (asleep, moved, different file): keep ours
        continue;
      }

      await fs.rm(abs);
      await markMediaOnly(row.songKey, { bytes: res.bytes, mtimeMs: res.lastModifiedMs ?? 0, original: { relPath: originalRel, url } });
      invalidateLibraryTracks();
      retired += 1;
      logActivity(
        'download',
        'retire_copy',
        `Copia di «${songLabel(row, row.songKey)}» tolta da geekom: il brano è già sul media server`,
        SYSTEM_ACTOR,
        { songKey: row.songKey, removed: row.relPath, original: originalRel, bytes: local.bytes },
      );
    } catch (err) {
      kept += 1;
      logWarning('retiring a copy failed, left in place', { songKey: row.songKey, err: err instanceof Error ? err.message : String(err) });
    }
  }
  if (retired > 0) logInfo('retired copies of media server files', { retired, kept });
  return { retired, kept };
}
