import { promises as fs } from 'fs';
import { join } from 'path';
import { logInfo, logError } from '../utils/logger';

/** A public-domain feature at Archive quality tops out well under this; the
 * ceiling exists so a mis-matched multi-hour item cannot fill the disk. */
const MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 160;

// Test-only seam: lets archiveDownloader.test.ts exercise the streaming size
// ceiling (a response with no/under-reported Content-Length whose body still
// exceeds the limit) without moving gigabytes of data through the test
// process. Production code always uses MAX_BYTES.
let maxBytesOverride: number | null = null;
export function __setMaxBytesForTesting(bytes: number | null): void {
  maxBytesOverride = bytes;
}
function effectiveMaxBytes(): number {
  return maxBytesOverride ?? MAX_BYTES;
}

/** Filesystem-safe `Title (Year).mp4`. Path separators and control characters
 * become dashes so a hostile or merely odd Archive title cannot escape the
 * films directory. */
export function archiveFilmFilename(title: string, year: string | null): string {
  const safeTitle = title
    .replace(/[/\\:*?"<>|\x00-\x1F]/g, '-')
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
 *
 * The response body is streamed to disk with a running byte counter rather
 * than buffered into memory first: a mirror that omits Content-Length, or
 * reports a smaller value than it actually sends, must not be able to force
 * an unbounded in-memory buffer before the size check ever runs.
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

  const limit = effectiveMaxBytes();
  // Cheap early exit when the server is honest about the size — avoids even
  // opening a file for an obviously oversized item. Not trusted on its own:
  // the running total below is what actually enforces the ceiling.
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) {
    throw new Error(`file too large: ${declared} bytes`);
  }

  await fs.mkdir(root, { recursive: true });
  const dest = join(root, archiveFilmFilename(input.title, input.year));

  let total = 0;
  const handle = await fs.open(dest, 'w');
  try {
    const body = res.body as ReadableStream<Uint8Array> | null | undefined;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > limit) {
            await reader.cancel().catch(() => {});
            throw new Error(`file too large: exceeds ${limit} bytes`);
          }
          await handle.write(value);
        }
      } finally {
        reader.releaseLock?.();
      }
    } else {
      // Fallback for a response with no streamable body (e.g. a minimal test
      // double). Still enforced against the ceiling before writing.
      const buffer = Buffer.from(await res.arrayBuffer());
      total = buffer.byteLength;
      if (total > limit) {
        throw new Error(`file too large: ${total} bytes`);
      }
      await handle.write(buffer);
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(dest, { force: true });
    logError('archive download: scrittura fallita', { dest, err: String(err) });
    throw err;
  }

  await handle.close();
  logInfo('archive download ok', { dest, bytes: total });
  return dest;
}
