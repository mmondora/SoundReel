import { generateContent } from './geminiClient';
import { logInfo, logWarning, logError } from '../utils/logger';
import type { DownloadedMedia, GeminiUsageMetadata } from '../types';

const TRANSCRIPTION_TIMEOUT = 60_000; // 60 seconds
const MAX_VIDEO_DURATION_SECONDS = 300; // 5 minutes

// Gemini-supported audio MIME types
const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/aac', 'audio/flac', 'audio/mp3', 'audio/m4a', 'audio/mpeg',
  'audio/mpga', 'audio/mp4', 'audio/opus', 'audio/pcm', 'audio/wav', 'audio/webm'
]);

// Gemini-supported video MIME types (also usable for transcription)
const SUPPORTED_VIDEO_TYPES = new Set([
  'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
  'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp'
]);

/**
 * Normalize MIME type to one supported by Gemini.
 * Cobalt tunnel URLs often return application/octet-stream instead of the actual audio type.
 */
function normalizeAudioMimeType(mimeType: string): string {
  // Strip charset or other parameters (e.g. "audio/mpeg; charset=utf-8")
  const base = mimeType.split(';')[0].trim().toLowerCase();

  if (SUPPORTED_AUDIO_TYPES.has(base) || SUPPORTED_VIDEO_TYPES.has(base)) {
    return base;
  }

  // Generic or unknown type — default to audio/mpeg (cobalt uses audioFormat: 'mp3')
  logWarning('MimeType non supportato da Gemini, uso audio/mpeg come fallback', {
    originalMimeType: mimeType,
    normalizedTo: 'audio/mpeg'
  });
  return 'audio/mpeg';
}

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
      const rawMimeType = response.headers.get('content-type') || 'audio/mpeg';
      const mimeType = normalizeAudioMimeType(rawMimeType);
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
    // Normalize mimeType for media passed from caller too (e.g. from downloadMedia)
    const safeMimeType = normalizeAudioMimeType(media.mimeType);

    logInfo('Inizio trascrizione audio con Gemini', {
      originalMimeType: media.mimeType,
      mimeType: safeMimeType,
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
            mimeType: safeMimeType,
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
