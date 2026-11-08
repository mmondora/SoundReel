/**
 * The music folders the library search looks into (spec 2026-11-07-library-search-music-folders-design.md, ADR-0011):
 * Spooty's folder (`/music`, always) plus the extra folders configured in the web configuration.
 *
 * Safety first, because the path comes from a form:
 *   - a folder must resolve (realpath) INSIDE one of the allowed roots — the folders mounted read-only in the
 *     container (`/music` and `MUSIC_EXTRA_ROOTS`) — so `..` and symlinks cannot reach anything else;
 *   - nothing is ever written, and a scan never follows symlinks, never enters hidden folders, stops at a file
 *     and depth cap, and lists audio files only;
 *   - the index lives in memory and is rebuilt from the disk: nothing to repair after a crash.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getMusicFoldersConfig, setMusicFoldersConfig, type MusicFolderConfig } from '../utils/db';
import { logInfo, logWarning } from '../utils/logger';
import { normalizeSearch } from '../utils/searchText';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wav', '.aac']);
export const MAX_FILES_PER_FOLDER = 200_000;
export const MAX_DEPTH = 12;
export const MAX_FOLDERS = 20;
export const BUILTIN_ID = 'library';
const STAT_BATCH = 64;

export interface AllowedRoot {
  path: string;
  label: string;
  builtIn: boolean;
}

/** `/music` (always, built in) and the roots of `MUSIC_EXTRA_ROOTS` (comma separated, default `/music-extra`). */
export function allowedRoots(env: NodeJS.ProcessEnv = process.env): AllowedRoot[] {
  const roots: AllowedRoot[] = [];
  const library = env.MUSIC_LIBRARY_PATH?.trim();
  if (library) roots.push({ path: path.resolve(library), label: 'Libreria (cartella di Spooty)', builtIn: true });
  for (const raw of (env.MUSIC_EXTRA_ROOTS ?? '/music-extra').split(',')) {
    const p = raw.trim();
    if (p && path.isAbsolute(p) && !roots.some((r) => r.path === path.resolve(p))) {
      roots.push({ path: path.resolve(p), label: path.basename(p) || p, builtIn: false });
    }
  }
  return roots;
}

/** How a folder's root is shown in a result's location (the container sees `/music`, the host calls it `~/Music`). */
export function libraryDisplayRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MUSIC_LIBRARY_LABEL?.trim() || '~/Music').replace(/\/+$/, '');
}

const inside = (root: string, candidate: string): boolean => {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export type FolderError = 'folder_outside_roots' | 'folder_missing' | 'folder_not_directory' | 'already_included' | 'too_many_folders' | 'invalid_folder';

export interface FolderInput {
  path?: unknown;
  label?: unknown;
  enabled?: unknown;
}

const cleanLabel = (raw: unknown, fallback: string): string => {
  // eslint-disable-next-line no-control-regex
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return text || fallback;
};

/** Validate the whole list a person submitted; resolves each path to its real location. */
export async function validateFolders(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; folders: MusicFolderConfig[] } | { ok: false; error: FolderError; index: number }> {
  if (!Array.isArray(input)) return { ok: false, error: 'invalid_folder', index: -1 };
  if (input.length > MAX_FOLDERS) return { ok: false, error: 'too_many_folders', index: -1 };

  const roots = allowedRoots(env);
  const realRoots: Array<{ real: string; builtIn: boolean }> = [];
  for (const r of roots) {
    try {
      realRoots.push({ real: await fs.realpath(r.path), builtIn: r.builtIn });
    } catch {
      /* a root that is not mounted simply allows nothing */
    }
  }

  const folders: MusicFolderConfig[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of (input as FolderInput[]).entries()) {
    if (!raw || typeof raw.path !== 'string' || !path.isAbsolute(raw.path.trim())) return { ok: false, error: 'invalid_folder', index };
    let real: string;
    try {
      real = await fs.realpath(path.resolve(raw.path.trim()));
    } catch {
      return { ok: false, error: 'folder_missing', index };
    }
    const owner = realRoots.find((r) => inside(r.real, real));
    if (!owner) return { ok: false, error: 'folder_outside_roots', index };
    if (owner.builtIn) return { ok: false, error: 'already_included', index }; // /music is searched whole already
    try {
      if (!(await fs.stat(real)).isDirectory()) return { ok: false, error: 'folder_not_directory', index };
    } catch {
      return { ok: false, error: 'folder_missing', index };
    }
    if (seen.has(real)) continue; // the same folder twice is one folder
    seen.add(real);
    folders.push({
      id: createHash('sha1').update(real).digest('hex').slice(0, 10),
      path: real,
      label: cleanLabel(raw.label, path.basename(real) || real),
      enabled: raw.enabled !== false,
    });
  }
  return { ok: true, folders };
}

// ---------------------------------------------------------------------------
// Reading a track's identity from where it sits
// ---------------------------------------------------------------------------

export interface FileIdentity {
  artist: string;
  title: string;
  album: string | null;
}

/**
 * `Artist - Title.mp3` (the library's own convention) first; otherwise the usual album layout
 * `Artist/Album/NN - Title.mp3`, where the artist is the folder two levels up and the album the parent folder.
 */
export function parseTrackName(relPath: string): FileIdentity {
  const parts = relPath.split('/');
  const file = parts[parts.length - 1];
  const base = file.slice(0, file.length - path.extname(file).length);
  const album = parts.length > 1 ? parts[parts.length - 2] : null;

  const split = (text: string): FileIdentity | null => {
    const i = text.indexOf(' - ');
    return i > 0 ? { artist: text.slice(0, i).trim(), title: text.slice(i + 3).trim(), album } : null;
  };
  // A leading track number: "1-02 Title" (disc-track), "01 - Title" / "7. Title" (with a separator), "07 Title" (zero padded).
  // A single digit followed only by a space is NOT a number: "2 Unlimited - No Limit" is an artist.
  const numbered = /^\d{1,2}-\d{1,3}\s+(.+)$/.exec(base) ?? /^\d{1,3}\s*[-._]\s*(.+)$/.exec(base) ?? /^\d{2,3}\s+(.+)$/.exec(base);
  const grandparent = parts.length > 2 ? parts[parts.length - 3] : '';
  if (!numbered) return split(base) ?? { artist: grandparent, title: base.trim(), album };
  const rest = numbered[1];
  const named = split(rest);
  if (named && !/^\d/.test(named.artist)) return named; // "07 - Artist - Title.mp3"
  return { artist: grandparent, title: rest.trim(), album };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export interface ScannedFile extends FileIdentity {
  relPath: string;
  bytes: number | null;
  /** Artist, title, album and path, normalised once at scan time so a search is a plain substring test. */
  searchText: string;
}

export interface ScanResult {
  files: ScannedFile[];
  truncated: boolean;
}

/** Walk a folder for audio files: no symlinks, no hidden entries, capped in depth and count. */
export async function scanFolder(
  rootAbs: string,
  caps: { maxFiles?: number; maxDepth?: number } = {},
): Promise<ScanResult> {
  const maxFiles = caps.maxFiles ?? MAX_FILES_PER_FOLDER;
  const maxDepth = caps.maxDepth ?? MAX_DEPTH;
  const found: string[] = [];
  let truncated = false;
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];

  while (queue.length > 0 && !truncated) {
    const { rel, depth } = queue.shift() as { rel: string; depth: number };
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(rootAbs, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skip it, keep the rest
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue; // hidden covers `._*` and `.DS_Store`
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ rel: childRel, depth: depth + 1 });
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (found.length >= maxFiles) {
          truncated = true;
          break;
        }
        found.push(childRel);
      }
    }
  }

  const files: ScannedFile[] = [];
  for (let i = 0; i < found.length; i += STAT_BATCH) {
    const batch = found.slice(i, i + STAT_BATCH);
    const sizes = await Promise.all(batch.map((rel) => fs.stat(path.join(rootAbs, rel)).then((s) => s.size).catch(() => null)));
    batch.forEach((relPath, k) => {
      const id = parseTrackName(relPath);
      files.push({ relPath, bytes: sizes[k], ...id, searchText: normalizeSearch(`${id.artist} ${id.title} ${id.album ?? ''} ${relPath}`) });
    });
  }
  return { files, truncated };
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

export interface FolderState {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
  builtIn: boolean;
  status: 'scanning' | 'ok' | 'missing' | 'off' | 'pending';
  files: number;
  truncated: boolean;
  scannedAt: string | null;
}

interface Scanned {
  state: FolderState;
  files: ScannedFile[];
}

const scans = new Map<string, Scanned>();
let scanning: Promise<void> | null = null;
let rescanQueued = false;

const libraryFolder = (env: NodeJS.ProcessEnv = process.env): MusicFolderConfig | null => {
  const root = allowedRoots(env).find((r) => r.builtIn);
  return root ? { id: BUILTIN_ID, path: root.path, label: root.label, enabled: true } : null;
};

async function loadFolderList(): Promise<MusicFolderConfig[]> {
  try {
    return await getMusicFoldersConfig();
  } catch (err) {
    logWarning('music folders config unreadable', { err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** The folder exists and its REAL location is inside the library (built in) or an allowed extra root. */
async function stillInsideRoots(folderPath: string, builtIn: boolean): Promise<boolean> {
  let real: string;
  try {
    real = await fs.realpath(folderPath);
  } catch {
    return false;
  }
  if (builtIn) return true; // the library root itself: configured by the deployment, not by a form
  const roots = allowedRoots().filter((r) => !r.builtIn);
  for (const r of roots) {
    try {
      if (inside(await fs.realpath(r.path), real)) return true;
    } catch {
      /* root not mounted */
    }
  }
  logWarning('music folder is no longer inside an allowed root, skipped', { path: folderPath });
  return false;
}

async function scanAll(): Promise<void> {
  const library = libraryFolder();
  const folders = [...(library ? [library] : []), ...(await loadFolderList())];
  const keep = new Set(folders.map((f) => f.id));
  for (const id of [...scans.keys()]) if (!keep.has(id)) scans.delete(id);

  for (const f of folders) {
    const builtIn = f.id === BUILTIN_ID;
    const base = { id: f.id, path: f.path, label: f.label, enabled: f.enabled, builtIn };
    if (!f.enabled) {
      scans.set(f.id, { state: { ...base, status: 'off', files: 0, truncated: false, scannedAt: null }, files: [] });
      continue;
    }
    const previous = scans.get(f.id);
    scans.set(f.id, { state: { ...(previous?.state ?? { ...base, files: 0, truncated: false, scannedAt: null }), ...base, status: 'scanning' }, files: previous?.files ?? [] });
    // The stored path was checked when it was saved; check it again NOW: a folder replaced by a link to somewhere
    // else (or a root that is no longer mounted) must never be walked.
    if (!(await stillInsideRoots(f.path, builtIn))) {
      scans.set(f.id, { state: { ...base, status: 'missing', files: 0, truncated: false, scannedAt: new Date().toISOString() }, files: [] });
      continue;
    }
    const result = await scanFolder(f.path);
    scans.set(f.id, {
      state: { ...base, status: 'ok', files: result.files.length, truncated: result.truncated, scannedAt: new Date().toISOString() },
      files: result.files,
    });
    logInfo('music folder scanned', { id: f.id, files: result.files.length, truncated: result.truncated });
  }
}

/** Rescan everything; calls made while a scan runs collapse into one more run right after it. */
export function refreshMusicFolders(): Promise<void> {
  if (scanning) {
    rescanQueued = true;
    return scanning;
  }
  scanning = scanAll()
    .catch((err) => logWarning('music folder scan failed', { err: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      scanning = null;
      if (rescanQueued) {
        rescanQueued = false;
        void refreshMusicFolders();
      }
    });
  return scanning;
}

export function getFolderStates(): FolderState[] {
  return [...scans.values()].map((s) => s.state);
}

export interface LocalFile extends ScannedFile {
  folderId: string;
  folderLabel: string;
  builtIn: boolean;
}

/** Every indexed file of the enabled, scanned folders. */
export function getLocalFiles(): LocalFile[] {
  const out: LocalFile[] = [];
  for (const { state, files } of scans.values()) {
    if (state.status !== 'ok' && state.status !== 'scanning') continue;
    for (const f of files) out.push({ ...f, folderId: state.id, folderLabel: state.label, builtIn: state.builtIn });
  }
  return out;
}

/** Save a validated list (admin), then rescan in the background so the change shows up at once. */
export async function saveMusicFolders(folders: MusicFolderConfig[]): Promise<void> {
  await setMusicFoldersConfig(folders);
  void refreshMusicFolders();
}

export function startMusicFoldersSync(options: { firstRunDelayMs?: number; everyMs?: number } = {}): () => void {
  const first = setTimeout(() => void refreshMusicFolders(), options.firstRunDelayMs ?? 10_000);
  const every = setInterval(() => void refreshMusicFolders(), options.everyMs ?? 30 * 60_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

export function _resetMusicFoldersForTest(): void {
  scans.clear();
  scanning = null;
  rescanQueued = false;
}
