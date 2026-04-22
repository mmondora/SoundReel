import { logInfo, logWarning, logError } from '../utils/logger';

export interface OcrPerImage {
  path: string;
  text: string | null;
  error?: string;
}

export interface OcrResult {
  perImage: OcrPerImage[];
  merged: string;
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
}

const EMPTY: OcrResult = { perImage: [], merged: '', status: 'skipped' };

export async function ocrImages(paths: string[], lang: string = 'ita+eng'): Promise<OcrResult> {
  if (!paths.length) {
    return { ...EMPTY, reason: 'no paths' };
  }

  const base = process.env.OCR_URL;
  if (!base) {
    logWarning('OCR_URL non configurato, skip');
    return { ...EMPTY, reason: 'OCR_URL not set' };
  }

  const endpoint = `${base.replace(/\/$/, '')}/ocr`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, lang }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logWarning('OCR HTTP error', { status: response.status, body: errText.substring(0, 300) });
      return { ...EMPTY, status: 'error', reason: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as {
      results?: OcrPerImage[];
      merged?: string;
      success?: boolean;
    };

    const perImage = Array.isArray(data.results) ? data.results : [];
    const merged = typeof data.merged === 'string' ? data.merged : '';

    logInfo('OCR ok', {
      imagesSent: paths.length,
      withText: perImage.filter((r) => r.text).length,
      mergedChars: merged.length,
    });

    return { perImage, merged, status: 'ok' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logWarning('OCR timeout');
      return { ...EMPTY, status: 'error', reason: 'timeout' };
    }
    logError('OCR network error', error);
    return {
      ...EMPTY,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
