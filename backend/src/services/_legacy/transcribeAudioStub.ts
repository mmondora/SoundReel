import { logInfo } from '../../utils/logger';
import type { DownloadedMedia, AiUsageMetadata } from '../../types';

export interface TranscriptionResult {
  transcript: string | null;
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
  durationMs: number;
  usageMetadata?: AiUsageMetadata | null;
}

// Placeholder: transcription via local Whisper not yet wired up.
// To enable: spin up openai/whisper-asr-webservice container and point TRANSCRIBE_URL at it.
export async function transcribeAudio(
  _media: DownloadedMedia | null,
  _audioUrl: string | null | undefined,
  _mimeTypeOverride?: string,
  _useVertexAi: boolean = false
): Promise<TranscriptionResult> {
  const start = Date.now();
  logInfo('Trascrizione audio: non configurata, skip');
  return {
    transcript: null,
    status: 'skipped',
    reason: 'local transcription service not configured',
    durationMs: Date.now() - start,
  };
}
