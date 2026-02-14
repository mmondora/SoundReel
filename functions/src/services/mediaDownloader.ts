import { logInfo, logWarning } from '../utils/logger';
import type { DownloadedMedia } from '../types';

const DEFAULT_MAX_SIZE = 15 * 1024 * 1024; // 15 MB
const DOWNLOAD_TIMEOUT = 30_000; // 30 seconds

export async function downloadMedia(
  url: string,
  maxSize: number = DEFAULT_MAX_SIZE
): Promise<DownloadedMedia | null> {
  try {
    logInfo('Download media iniziato', { url, maxSize });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'SoundReel/1.0'
        }
      });

      if (!response.ok) {
        logWarning('Download media fallito', { url, status: response.status });
        return null;
      }

      // Check Content-Length header before downloading
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxSize) {
        logWarning('Media troppo grande (Content-Length)', {
          url,
          contentLength: parseInt(contentLength, 10),
          maxSize
        });
        return null;
      }

      const mimeType = response.headers.get('content-type') || 'application/octet-stream';
      const arrayBuffer = await response.arrayBuffer();
      const sizeBytes = arrayBuffer.byteLength;

      if (sizeBytes > maxSize) {
        logWarning('Media troppo grande (dopo download)', { url, sizeBytes, maxSize });
        return null;
      }

      logInfo('Download media completato', { url, mimeType, sizeBytes });

      return {
        buffer: Buffer.from(arrayBuffer),
        mimeType,
        sizeBytes
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logWarning('Download media timeout', { url });
    } else {
      logWarning('Errore download media', { url, error });
    }
    return null;
  }
}
