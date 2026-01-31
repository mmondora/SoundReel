import { defineSecret } from 'firebase-functions/params';
import { logInfo, logWarning, logError } from '../utils/logger';
import type { AudioRecognitionResult } from '../types';

const auddApiKey = defineSecret('AUDD_API_KEY');

interface AuddResponse {
  status: string;
  result: {
    title: string;
    artist: string;
    album?: string;
  } | null;
  error?: {
    error_message: string;
  };
}

export async function recognizeAudio(
  audioUrl: string
): Promise<AudioRecognitionResult | null> {
  try {
    const apiKey = auddApiKey.value();
    if (!apiKey) {
      logWarning('AUDD_API_KEY non configurata');
      return null;
    }

    logInfo('Riconoscimento audio con AudD', { audioUrl });

    const formData = new URLSearchParams();
    formData.append('api_token', apiKey);
    formData.append('url', audioUrl);
    formData.append('return', 'spotify');

    const response = await fetch('https://api.audd.io/', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      logWarning('AudD API response non ok', { status: response.status });
      return null;
    }

    const data = await response.json() as AuddResponse;

    if (data.status !== 'success') {
      logWarning('AudD status non success', { error: data.error?.error_message });
      return null;
    }

    if (!data.result) {
      logInfo('AudD: nessun match trovato');
      return null;
    }

    logInfo('AudD match trovato', {
      title: data.result.title,
      artist: data.result.artist
    });

    return {
      title: data.result.title,
      artist: data.result.artist,
      album: data.result.album || null
    };
  } catch (error) {
    logError('Errore AudD', error);
    return null;
  }
}

export { auddApiKey };
