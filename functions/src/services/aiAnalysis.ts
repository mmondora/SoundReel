import { generateContent, geminiApiKey } from './geminiClient';
import { logInfo, logWarning, logError } from '../utils/logger';
import { getPrompt, renderTemplate } from './promptLoader';
import type { AiAnalysisResult, MediaAiAnalysisResult, DownloadedMedia, GeminiUsageMetadata } from '../types';

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

const SUPPORTED_MEDIA_TYPES = new Set([
  'audio/aac', 'audio/flac', 'audio/mp3', 'audio/m4a', 'audio/mpeg',
  'audio/mpga', 'audio/mp4', 'audio/opus', 'audio/pcm', 'audio/wav', 'audio/webm',
  'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv',
  'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp'
]);

function normalizeMediaMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  if (SUPPORTED_MEDIA_TYPES.has(base)) return base;
  logWarning('AI Analysis: mimeType non supportato, fallback audio/mpeg', { originalMimeType: mimeType });
  return 'audio/mpeg';
}

export interface AiAnalysisResponse {
  result: AiAnalysisResult | MediaAiAnalysisResult;
  usageMetadata: GeminiUsageMetadata | null;
}

export async function analyzeWithAi(
  caption: string | null,
  thumbnailUrl: string | null,
  media?: DownloadedMedia | null,
  transcript?: string | null,
  useVertexAi: boolean = true
): Promise<AiAnalysisResponse> {
  const emptyResult: AiAnalysisResult = { songs: [], films: [], notes: [], links: [], tags: [], summary: null };

  if (!caption && !thumbnailUrl && !media) {
    logInfo('Nessun contenuto da analizzare con AI');
    return { result: emptyResult, usageMetadata: null };
  }

  try {
    const useMediaPrompt = !!media;
    logInfo('Analisi AI con Gemini', { hasCaption: !!caption, hasThumbnail: !!thumbnailUrl, hasMedia: !!media, useMediaPrompt, useVertexAi });

    // Choose prompt based on media availability
    const promptId = useMediaPrompt ? 'mediaAnalysis' : 'contentAnalysis';
    const promptConfig = await getPrompt(promptId);
    const prompt = renderTemplate(promptConfig.template, {
      caption: caption || '[nessuna caption]',
      hasImage: !!thumbnailUrl,
      transcript: transcript || null,
      hasTranscript: !!transcript
    });

    const parts: GeminiPart[] = [
      { text: prompt }
    ];

    // Add thumbnail image
    if (thumbnailUrl) {
      try {
        const imageResponse = await fetch(thumbnailUrl);
        if (imageResponse.ok) {
          const imageBuffer = await imageResponse.arrayBuffer();
          const base64 = Buffer.from(imageBuffer).toString('base64');
          const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';
          parts.push({
            inlineData: {
              mimeType,
              data: base64
            }
          });
          logInfo('Thumbnail aggiunta al prompt AI');
        }
      } catch (imgError) {
        logWarning('Impossibile caricare thumbnail per AI', { error: imgError });
      }
    }

    // Add media (audio/video) if available
    if (media) {
      const base64Media = media.buffer.toString('base64');
      // Normalize mimeType: cobalt tunnel URLs may return application/octet-stream
      const mediaMimeType = normalizeMediaMimeType(media.mimeType);
      parts.push({
        inlineData: {
          mimeType: mediaMimeType,
          data: base64Media
        }
      });
      logInfo('Media aggiunto al prompt AI', { originalMimeType: media.mimeType, mimeType: mediaMimeType, sizeBytes: media.sizeBytes });
    }

    const response = await generateContent(parts, useVertexAi);
    const text = response.text;

    logInfo('Risposta Gemini ricevuta', { length: text.length });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logWarning('Nessun JSON trovato nella risposta Gemini');
      return { result: emptyResult, usageMetadata: response.usageMetadata };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    logInfo('AI analisi completata', {
      songs: parsed.songs?.length || 0,
      films: parsed.films?.length || 0,
      notes: parsed.notes?.length || 0,
      links: parsed.links?.length || 0,
      tags: parsed.tags?.length || 0,
      hasSummary: !!parsed.summary,
      hasTranscription: !!parsed.transcription,
      hasVisualContext: !!parsed.visualContext,
      hasOverlayText: !!parsed.overlayText
    });

    const baseResult: AiAnalysisResult = {
      songs: parsed.songs || [],
      films: parsed.films || [],
      notes: parsed.notes || [],
      links: parsed.links || [],
      tags: parsed.tags || [],
      summary: parsed.summary || null
    };

    if (useMediaPrompt) {
      return {
        result: {
          ...baseResult,
          transcription: parsed.transcription || null,
          visualContext: parsed.visualContext || null,
          overlayText: parsed.overlayText || null
        } as MediaAiAnalysisResult,
        usageMetadata: response.usageMetadata
      };
    }

    return { result: baseResult, usageMetadata: response.usageMetadata };
  } catch (error) {
    logError('Errore analisi AI', error);
    return { result: emptyResult, usageMetadata: null };
  }
}

export { geminiApiKey };
