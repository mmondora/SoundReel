/**
 * The "Cartelle musica" section of the web configuration (spec 2026-11-07-library-search-music-folders-design.md,
 * L4/L8): which folders the local-files search reads. The server validates everything (roots, `..`, links); this
 * is the list handling around it and the words for what it answers.
 */
import type { Translations } from '../i18n/translations';
import type { MusicFolder, MusicFolderInput, MusicFolderRoot, MusicFolderStatus, MusicFoldersPayload } from '../types';
import type { ApiErrorInfo } from './apiError';

/** The built-in library (Spooty's folder) is always first and never part of what is sent. */
export const extraFolders = (folders: readonly MusicFolder[]): MusicFolder[] => folders.filter((f) => !f.builtIn);

/** What POST /api/config/music-folders takes: the WHOLE list of extra folders. */
export const toInputs = (folders: readonly MusicFolder[]): MusicFolderInput[] =>
  extraFolders(folders).map((f) => ({ path: f.path, label: f.label, enabled: f.enabled }));

export function withLabel(folders: readonly MusicFolder[], id: string, label: string): MusicFolderInput[] {
  return extraFolders(folders).map((f) => ({ path: f.path, label: f.id === id ? label : f.label, enabled: f.enabled }));
}

export function withEnabled(folders: readonly MusicFolder[], id: string, enabled: boolean): MusicFolderInput[] {
  return extraFolders(folders).map((f) => ({ path: f.path, label: f.label, enabled: f.id === id ? enabled : f.enabled }));
}

export function without(folders: readonly MusicFolder[], id: string): MusicFolderInput[] {
  return toInputs(extraFolders(folders).filter((f) => f.id !== id));
}

/** The list with one more folder at the end (the server picks the label from the folder name). */
export function withAdded(folders: readonly MusicFolder[], path: string): MusicFolderInput[] {
  return [...toInputs(folders), { path, enabled: true }];
}

/** A scan is running or about to: the page keeps asking until it is over. */
export const needsPolling = (folders: readonly MusicFolder[]): boolean =>
  folders.some((f) => f.enabled && (f.status === 'scanning' || f.status === 'pending'));

export const STATUS_KEY: Record<MusicFolderStatus, keyof Translations> = {
  ok: 'mfStatusOk',
  scanning: 'mfStatusScanning',
  pending: 'mfStatusPending',
  missing: 'mfStatusMissing',
  off: 'mfStatusOff',
};

export type FolderErrorKey =
  | 'mfErrOutside'
  | 'mfErrMissing'
  | 'mfErrNotDir'
  | 'mfErrIncluded'
  | 'mfErrTooMany'
  | 'mfErrInvalid'
  | 'mfErrForbidden'
  | 'mfErrNetwork'
  | 'mfErrUnknown';

const ERROR_KEY: Record<string, FolderErrorKey> = {
  folder_outside_roots: 'mfErrOutside',
  folder_missing: 'mfErrMissing',
  folder_not_directory: 'mfErrNotDir',
  already_included: 'mfErrIncluded',
  too_many_folders: 'mfErrTooMany',
  invalid_folder: 'mfErrInvalid',
  forbidden: 'mfErrForbidden',
  network: 'mfErrNetwork',
};

export interface FolderError {
  key: FolderErrorKey;
  /** The folder the server blames (from the `index` it sends), when there is one. */
  path: string | null;
  /** For an error the page has no words for: what the server said. */
  detail: string;
}

/** Turns what the server answered into a message key and the folder it is about. */
export function folderError(info: ApiErrorInfo, submitted: readonly MusicFolderInput[] = []): FolderError {
  const byCode = info.code ? ERROR_KEY[info.code] : undefined;
  const forbidden = info.status === 401 || info.status === 403;
  const key = byCode ?? (forbidden ? 'mfErrForbidden' : 'mfErrUnknown');
  const path = info.index !== null && info.index >= 0 ? (submitted[info.index]?.path ?? null) : null;
  return { key, path, detail: info.code ?? info.message };
}

// ---------------------------------------------------------------------------
// Tolerant reading of the payload: a missing field is a default, never a crash.
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATUSES: readonly MusicFolderStatus[] = ['ok', 'scanning', 'pending', 'missing', 'off'];

function readFolder(raw: unknown): MusicFolder | null {
  if (!isObject(raw) || typeof raw.path !== 'string') return null;
  const status = STATUSES.find((s) => s === raw.status) ?? 'pending';
  return {
    id: typeof raw.id === 'string' ? raw.id : raw.path,
    path: raw.path,
    label: typeof raw.label === 'string' ? raw.label : raw.path,
    enabled: raw.enabled !== false,
    builtIn: raw.builtIn === true,
    status,
    files: typeof raw.files === 'number' && Number.isFinite(raw.files) ? raw.files : 0,
    truncated: raw.truncated === true,
    scannedAt: typeof raw.scannedAt === 'string' ? raw.scannedAt : null,
  };
}

function readRoot(raw: unknown): MusicFolderRoot | null {
  if (!isObject(raw) || typeof raw.path !== 'string') return null;
  return { path: raw.path, label: typeof raw.label === 'string' ? raw.label : raw.path, builtIn: raw.builtIn === true };
}

export function normalizeMusicFolders(raw: unknown): MusicFoldersPayload {
  const root = isObject(raw) ? raw : {};
  const folders = (Array.isArray(root.folders) ? root.folders : []).map(readFolder).filter((f): f is MusicFolder => f !== null);
  const roots = (Array.isArray(root.roots) ? root.roots : []).map(readRoot).filter((r): r is MusicFolderRoot => r !== null);
  // the built-in library first, whatever order the server used
  folders.sort((a, b) => Number(b.builtIn) - Number(a.builtIn));
  return { roots, folders };
}
