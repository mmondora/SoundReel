import { promises as fs } from 'fs';
import { join } from 'path';
import { logInfo, logError } from '../utils/logger';

/** A public-domain feature at Archive quality tops out well under this; the
 * ceiling exists so a mis-matched multi-hour item cannot fill the disk. */
const MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 160;

/** Filesystem-safe `Title (Year).mp4`. Path separators and control characters
 * become dashes so a hostile or merely odd Archive title cannot escape the
 * films directory. */
export function archiveFilmFilename(title: string, year: string | null): string {
  const safeTitle = title
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const suffix = year ? ` (${year})` : '';
  const budget = MAX_FILENAME_LENGTH - suffix.length - '.mp4'.length;
  return `${safeTitle.slice(0, budget).trim()}${suffix}.mp4`;
}

/**
 * Downloads one Archive-hosted film into FILMS_LIBRARY_PATH and returns the
 * path written. Throws on any failure, leaving nothing behind — the caller
 * records the path in film_meta only on success.
 */
export async function downloadArchiveFilm(input: {
  fileUrl: string;
  title: string;
  year: string | null;
}): Promise<string> {
  const root = process.env.FILMS_LIBRARY_PATH;
  if (!root) throw new Error('FILMS_LIBRARY_PATH not set');

  // The URL always comes from our own enrichment record rather than user
  // input, but pinning the host keeps that guarantee local and checkable.
  let parsed: URL;
  try {
    parsed = new URL(input.fileUrl);
  } catch {
    throw new Error('invalid file url');
  }
  if (parsed.hostname !== 'archive.org' && !parsed.hostname.endsWith('.archive.org')) {
    throw new Error('file url is not hosted on archive.org');
  }

  const res = await fetch(input.fileUrl);
  if (!res.ok) throw new Error(`archive download failed: HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) {
    throw new Error(`file too large: ${declared} bytes`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`file too large: ${buffer.byteLength} bytes`);
  }

  await fs.mkdir(root, { recursive: true });
  const dest = join(root, archiveFilmFilename(input.title, input.year));
  try {
    await fs.writeFile(dest, buffer);
  } catch (err) {
    await fs.rm(dest, { force: true });
    logError('archive download: scrittura fallita', { dest, err: String(err) });
    throw err;
  }

  logInfo('archive download ok', { dest, bytes: buffer.byteLength });
  return dest;
}
