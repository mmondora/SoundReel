import { generateContent } from './geminiClient';
import { logInfo, logWarning, logError } from '../utils/logger';
import type { DownloadedMedia, GeminiUsageMetadata } from '../types';

const TRANSCRIPTION_TIMEOUT = 60_000; // 60 seconds
const MAX_VIDEO_DURATION_SECONDS = 300; // 5 minutes

export interface TranscriptionResult {
  transcript: string | null;
  status: 'success' | 'error' | 'skipped';
  reason?: string;
  durationMs: number;
  usageMetadata?: GeminiUsageMetadata | null;
}

export async function transcribeAudio(
  media: DownloadedMedia | null,
  audioUrl: string | null,
  videoDurationSeconds?: number,
  useVertexAi: boolean = true
): Promise<TranscriptionResult> {
  const startTime = Date.now();

  // Guard: no audio source
  if (!media && !audioUrl) {
    logInfo('Trascrizione skippata: nessuna sorgente audio');
    return {
      transcript: null,
      status: 'skipped',
      reason: 'no audio source',
      durationMs: Date.now() - startTime
    };
  }

  // Guard: video too long
  if (videoDurationSeconds && videoDurationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    logInfo('Trascrizione skippata: video troppo lungo', {
      durationSeconds: videoDurationSeconds,
      maxSeconds: MAX_VIDEO_DURATION_SECONDS
    });
    return {
      transcript: null,
      status: 'skipped',
      reason: `video too long (${videoDurationSeconds}s > ${MAX_VIDEO_DURATION_SECONDS}s)`,
      durationMs: Date.now() - startTime
    };
  }

  // We need downloaded media for inline data
  if (!media) {
    // Try to download if we have a URL
    try {
      const response = await fetch(audioUrl!, {
        headers: { 'User-Agent': 'SoundReel/1.0' },
        signal: AbortSignal.timeout(30_000)
      });

      if (!response.ok) {
        logWarning('Trascrizione: download audio fallito', { status: response.status });
        return {
          transcript: null,
          status: 'skipped',
          reason: 'audio download failed',
          durationMs: Date.now() - startTime
        };
      }

      const arrayBuffer = await response.arrayBuffer();
      const mimeType = response.headers.get('content-type') || 'audio/mpeg';
      media = {
        buffer: Buffer.from(arrayBuffer),
        mimeType,
        sizeBytes: arrayBuffer.byteLength
      };
    } catch (dlError) {
      logWarning('Trascrizione: errore download audio', {
        error: dlError instanceof Error ? dlError.message : String(dlError)
      });
      return {
        transcript: null,
        status: 'skipped',
        reason: 'audio download error',
        durationMs: Date.now() - startTime
      };
    }
  }

  try {
    logInfo('Inizio trascrizione audio con Gemini', {
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      useVertexAi
    });

    const prompt = 'Trascrivi fedelmente tutto il parlato presente in questo audio. Restituisci solo il testo trascritto, senza commenti o formattazione. Se non c\'è parlato, rispondi con stringa vuota.';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT);

    try {
      const response = await generateContent([
        { text: prompt },
        {
          inlineData: {
            mimeType: media.mimeType,
            data: media.buffer.toString('base64')
          }
        }
      ], useVertexAi);

      clearTimeout(timeout);

      const text = response.text.trim();
      const transcript = text === '' ? null : text;

      logInfo('Trascrizione completata', {
        hasTranscript: !!transcript,
        transcriptLength: transcript?.length || 0,
        durationMs: Date.now() - startTime
      });

      return {
        transcript,
        status: 'success',
        durationMs: Date.now() - startTime,
        usageMetadata: response.usageMetadata
      };
    } catch (genError) {
      clearTimeout(timeout);
      throw genError;
    }
  } catch (error) {
    logError('Errore trascrizione audio', error);
    return {
      transcript: null,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime
    };
  }
}
