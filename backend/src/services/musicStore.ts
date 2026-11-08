/**
 * Where MP3 files live on disk and how a freshly downloaded one gets there.
 *
 * Everything sits under MUSIC_LIBRARY_PATH (/music, the host's ~/Music, where Spooty also writes), so the
 * existing library scan, the web player and the "downloaded" flags keep working untouched. Files this
 * service produces go into a subfolder (`MUSIC_STORE_DIR`, default `SoundReel`) that is mounted read-write;
 * the rest of /music stays read-only.
 *
 * The Fritz!Box holds a replica of the same tree (mirrored by scripts/fritz-sync.sh), never the other way
 * round: the backend does not need the SMB share mounted, so a dead box cannot hang the container.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEFAULT_STORE_DIR = 'SoundReel';
/** Smaller than this is an error page or a stub, not a song. */
export const MIN_MP3_BYTES = 30 * 1024;

export function libraryRoot(): string | null {
  return process.env.MUSIC_LIBRARY_PATH?.trim() || null;
}

/** Folder (relative to the library root) that receives downloaded files. */
export function storeDir(): string {
  return (process.env.MUSIC_STORE_DIR?.trim() || DEFAULT_STORE_DIR).replace(/^\/+|\/+$/g, '');
}

/** exFAT / NTFS / FAT safe: those are the filesystems of the stick the replica lands on. */
export function sanitizeName(input: string): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows-style filesystems reject trailing dots and spaces.
    .replace(/[. ]+$/g, '');
  const clipped = cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
  return clipped;
}

/** `Artist - Title.mp3` (the library scanner splits on the first " - "); title only when the artist is unknown. */
export function storeFileName(artist: string, title: string): string {
  const a = sanitizeName(artist);
  const t = sanitizeName(title) || 'Senza titolo';
  return a ? `${a} - ${t}.mp3` : `${t}.mp3`;
}

/** Absolute path of a library-relative path, refusing anything that would leave the library root. */
export function absFromRel(relPath: string, root: string | null = libraryRoot()): string | null {
  if (!root) return null;
  const abs = path.resolve(root, relPath);
  const base = path.resolve(root);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

export function relFromAbs(absPath: string, root: string | null = libraryRoot()): string | null {
  if (!root) return null;
  const rel = path.relative(path.resolve(root), path.resolve(absPath));
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
}

export interface FileFacts {
  bytes: number;
  mtimeMs: number;
}

export async function fileFacts(absPath: string): Promise<FileFacts | null> {
  try {
    const st = await fs.stat(absPath);
    return st.isFile() ? { bytes: st.size, mtimeMs: Math.round(st.mtimeMs) } : null;
  } catch {
    return null;
  }
}

/** Stable per-file identity the clients compare to skip a download they already have. */
export function fileVersion(facts: FileFacts): string {
  return `${facts.bytes}-${facts.mtimeMs}`;
}

export interface Mp3Check {
  ok: boolean;
  bytes: number;
  reason?: string;
}

/** Cheap sanity check: big enough, and starts like an MP3 (ID3 tag or MPEG frame sync). */
export async function checkMp3(absPath: string, minBytes = MIN_MP3_BYTES): Promise<Mp3Check> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(absPath, 'r');
    const { size } = await handle.stat();
    if (size < minBytes) return { ok: false, bytes: size, reason: `file troppo piccolo (${size} byte)` };
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const isId3 = bytesRead >= 3 && head.toString('latin1', 0, 3) === 'ID3';
    let hasSync = false;
    for (let i = 0; i + 1 < bytesRead && !hasSync; i += 1) {
      hasSync = head[i] === 0xff && (head[i + 1] & 0xe0) === 0xe0;
    }
    return isId3 || hasSync ? { ok: true, bytes: size } : { ok: false, bytes: size, reason: 'non sembra un MP3' };
  } catch (err) {
    return { ok: false, bytes: 0, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** `Name.mp3`, or `Name (2).mp3`… when another song already owns that name. */
async function freeName(dir: string, fileName: string): Promise<string> {
  if (!(await exists(path.join(dir, fileName)))) return fileName;
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new Error(`troppi file con lo stesso nome: ${fileName}`);
}

export interface PlacedFile extends FileFacts {
  relPath: string;
  absPath: string;
}

/**
 * Move a finished download from the shared staging folder into the store. Never leaves a half-written
 * file under its final name: copy to `.part`, then rename. Staging and store are different volumes, so a
 * plain rename is not an option. `replace` overwrites the song's own previous file (a better version).
 */
export async function placeIntoStore(
  stagingAbs: string,
  artist: string,
  title: string,
  options: { replaceRelPath?: string | null; libRoot?: string | null } = {},
): Promise<PlacedFile> {
  const root = options.libRoot ?? libraryRoot();
  if (!root) throw new Error('MUSIC_LIBRARY_PATH non impostato');

  const dir = path.join(root, storeDir());
  await fs.mkdir(dir, { recursive: true });

  const replacing = options.replaceRelPath ? absFromRel(options.replaceRelPath, root) : null;
  let finalAbs: string;
  if (replacing && path.dirname(replacing) === dir) {
    finalAbs = replacing;
  } else {
    finalAbs = path.join(dir, await freeName(dir, storeFileName(artist, title)));
  }

  const part = `${finalAbs}.part`;
  try {
    await fs.copyFile(stagingAbs, part);
    await fs.rename(part, finalAbs);
  } catch (err) {
    await fs.rm(part, { force: true }).catch(() => undefined);
    throw err;
  }
  await fs.rm(stagingAbs, { force: true }).catch(() => undefined);

  const facts = await fileFacts(finalAbs);
  const relPath = relFromAbs(finalAbs, root);
  if (!facts || !relPath) throw new Error('file non trovato dopo la copia nello store');
  return { ...facts, relPath, absPath: finalAbs };
}

/**
 * Remove leftovers of work that died halfway: `*.part` files in the store (a copy interrupted by a restart)
 * and anything old in the staging folder (a download the backend never got to place). Returns what it removed.
 */
export async function sweepStaleFiles(
  dir: string,
  options: { maxAgeMs: number; match: (name: string) => boolean; now?: number },
): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return removed; // the folder does not exist yet: nothing to clean
  }
  const now = options.now ?? Date.now();
  for (const name of names) {
    if (!options.match(name)) continue;
    const abs = path.join(dir, name);
    try {
      const st = await fs.stat(abs);
      if (now - st.mtimeMs < options.maxAgeMs) continue;
      await fs.rm(abs, { recursive: st.isDirectory(), force: true });
      removed.push(name);
    } catch {
      /* gone already, or not ours to delete: skip */
    }
  }
  return removed;
}
