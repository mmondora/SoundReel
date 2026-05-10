import { promises as fs } from 'fs';
import path from 'path';
import { logInfo, logWarning, logError } from '../utils/logger';

export interface WhisperResult {
  text: string | null;
  language: string | null;
  durationMs: number;
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
}

interface WhisperApiResponse {
  text?: string;
  language?: string;
  segments?: unknown[];
}

export async function transcribeLocal(audioPath: string | null): Promise<WhisperResult> {
  const start = Date.now();

  if (!audioPath) {
    return { text: null, language: null, durationMs: 0, status: 'skipped', reason: 'no audio path' };
  }

  const base = process.env.WHISPER_URL;
  if (!base) {
    logWarning('WHISPER_URL non configurato, skip');
    return { text: null, language: null, durationMs: 0, status: 'skipped', reason: 'WHISPER_URL not set' };
  }

  try {
    const stat = await fs.stat(audioPath);
    if (!stat.isFile() || stat.size === 0) {
      return { text: null, language: null, durationMs: Date.now() - start, status: 'error', reason: 'audio file empty or missing' };
    }

    const fileBuffer = await fs.readFile(audioPath);
    const filename = path.basename(audioPath);

    const form = new FormData();
    const blob = new Blob([new Uint8Array(fileBuffer)], { type: 'audio/wav' });
    form.append('audio_file', blob, filename);

    const endpoint = `${base.replace(/\/$/, '')}/asr?task=transcribe&output=json&encode=true`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        logWarning('Whisper HTTP error', { status: response.status, body: errText.substring(0, 300) });
        return {
          text: null,
          language: null,
          durationMs: Date.now() - start,
          status: 'error',
          reason: `HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as WhisperApiResponse;
      const text = (data.text || '').trim() || null;
      const language = data.language || null;

      logInfo('Whisper ASR ok', {
        audioPath,
        sizeBytes: stat.size,
        chars: text?.length ?? 0,
        language,
        durationMs: Date.now() - start,
      });

      return {
        text,
        language,
        durationMs: Date.now() - start,
        status: 'ok',
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logWarning('Whisper timeout', { audioPath });
      return { text: null, language: null, durationMs: Date.now() - start, status: 'error', reason: 'timeout' };
    }
    logError('Whisper network error', error);
    return {
      text: null,
      language: null,
      durationMs: Date.now() - start,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
