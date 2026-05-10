import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { logInfo, logWarning } from '../utils/logger';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';
const MAX_DIM = Number(process.env.THUMBNAIL_MAX_DIM || 320);
const JPEG_QUALITY = Number(process.env.THUMBNAIL_JPEG_QUALITY || 80);
const FETCH_TIMEOUT_MS = Number(process.env.THUMBNAIL_FETCH_TIMEOUT_MS || 15_000);

export interface ThumbnailSaveResult {
  localPath: string;
  relativeUrl: string;
  sizeBytes: number;
}

/**
 * Download a thumbnail from URL OR copy from a local path, resize to compact JPEG,
 * save under /data/media/<entryId>/thumbnail.jpg, return relative URL to serve.
 *
 * - If `source` is http(s) URL: fetched.
 * - If `source` is an absolute path on the shared media volume: read from disk.
 *
 * Returns null on failure (caller keeps original URL as fallback).
 */
export async function saveThumbnailLocal(
  source: string,
  entryId: string,
): Promise<ThumbnailSaveResult | null> {
  try {
    let input: Buffer;

    if (/^https?:\/\//i.test(source)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(source, { signal: controller.signal });
        if (!res.ok) {
          logWarning('Thumbnail fetch non ok', { source, status: res.status });
          return null;
        }
        input = Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timeout);
      }
    } else if (path.isAbsolute(source)) {
      input = await fs.readFile(source);
    } else {
      logWarning('Thumbnail source non valido', { source });
      return null;
    }

    const dir = path.resolve(MEDIA_ROOT, entryId);
    const absRoot = path.resolve(MEDIA_ROOT);
    if (!dir.startsWith(absRoot + path.sep)) {
      logWarning('entryId path traversal rejected', { entryId });
      return null;
    }
    await fs.mkdir(dir, { recursive: true });
    const outPath = path.join(dir, 'thumbnail.jpg');

    await sharp(input)
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toFile(outPath);

    const stat = await fs.stat(outPath);
    const relativeUrl = `/media/${entryId}/thumbnail.jpg`;

    logInfo('Thumbnail locale salvata', {
      entryId,
      sizeBytes: stat.size,
      relativeUrl,
    });

    return { localPath: outPath, relativeUrl, sizeBytes: stat.size };
  } catch (err) {
    logWarning('saveThumbnailLocal failed', {
      source,
      entryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
