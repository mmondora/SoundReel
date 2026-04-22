import { promises as fs } from 'fs';
import { generateText, OllamaImage } from './ollamaClient';
import { logInfo, logWarning, logError } from '../utils/logger';
import { getPrompt, renderTemplate } from './promptLoader';
import type { AiAnalysisResult, MediaAiAnalysisResult, AiUsageMetadata } from '../types';

export interface AiAnalysisResponse {
  result: AiAnalysisResult | MediaAiAnalysisResult;
  usageMetadata: AiUsageMetadata | null;
}

export interface AiAnalysisInput {
  caption: string | null;
  musicInfo: { title: string; artist: string } | null;
  transcript: string | null;
  transcriptLanguage: string | null;
  ocrText: string | null;
  visualContext: string | null;
  slidePaths: string[];
  thumbnailPath: string | null;
}

const EMPTY_RESULT: AiAnalysisResult = {
  songs: [],
  films: [],
  notes: [],
  links: [],
  tags: [],
  summary: null,
};

async function pathToOllamaImage(filePath: string): Promise<OllamaImage | null> {
  try {
    const buf = await fs.readFile(filePath);
    const ext = filePath.toLowerCase().split('.').pop() || 'jpg';
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { mimeType, base64: buf.toString('base64') };
  } catch (err) {
    logWarning('Impossibile leggere immagine per AI', { filePath, error: String(err) });
    return null;
  }
}

export async function analyzeWithAi(input: AiAnalysisInput): Promise<AiAnalysisResponse> {
  const hasAnyInput =
    !!input.caption ||
    !!input.musicInfo ||
    !!input.transcript ||
    !!input.ocrText ||
    !!input.visualContext ||
    input.slidePaths.length > 0 ||
    !!input.thumbnailPath;

  if (!hasAnyInput) {
    logInfo('Nessun contenuto da analizzare con AI');
    return { result: EMPTY_RESULT, usageMetadata: null };
  }

  try {
    logInfo('Analisi AI multimodale', {
      hasCaption: !!input.caption,
      hasMusicInfo: !!input.musicInfo,
      hasTranscript: !!input.transcript,
      transcriptLang: input.transcriptLanguage,
      hasOcr: !!input.ocrText,
      hasVisualContext: !!input.visualContext,
      slideCount: input.slidePaths.length,
      hasThumbnail: !!input.thumbnailPath,
    });

    const promptConfig = await getPrompt('contentAnalysis');
    const isCarousel = input.slidePaths.length > 0;
    const prompt = renderTemplate(promptConfig.template, {
      caption: input.caption || '[nessuna caption]',
      hasCaption: !!input.caption,
      musicInfo: input.musicInfo,
      hasMusicInfo: !!input.musicInfo,
      transcript: input.transcript || null,
      hasTranscript: !!input.transcript,
      transcriptLanguage: input.transcriptLanguage || null,
      ocrText: input.ocrText || null,
      hasOcr: !!input.ocrText,
      visualContext: input.visualContext || null,
      hasVisualContext: !!input.visualContext,
      isCarousel,
      carouselCount: input.slidePaths.length,
      hasImage: !!input.thumbnailPath || isCarousel,
      // Legacy compat: older prompts may still reference hasImage
    });

    // Image selection:
    // - Carousel: pass all slides (vision will OCR/describe them)
    // - Else: thumbnail only (if any). visualContext already has video summary.
    const images: OllamaImage[] = [];
    if (isCarousel) {
      for (const p of input.slidePaths) {
        const img = await pathToOllamaImage(p);
        if (img) images.push(img);
      }
    } else if (input.thumbnailPath) {
      const img = await pathToOllamaImage(input.thumbnailPath);
      if (img) images.push(img);
    }

    const response = await generateText(prompt, images);
    const text = response.text;
    logInfo('Risposta AI ricevuta', { chars: text.length });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logWarning('Nessun JSON trovato nella risposta AI');
      return { result: EMPTY_RESULT, usageMetadata: response.usageMetadata };
    }

    let parsed: Partial<MediaAiAnalysisResult>;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      logWarning('JSON AI invalido', { preview: jsonMatch[0].substring(0, 300) });
      return { result: EMPTY_RESULT, usageMetadata: response.usageMetadata };
    }

    const baseResult: MediaAiAnalysisResult = {
      songs: parsed.songs || [],
      films: parsed.films || [],
      notes: parsed.notes || [],
      links: parsed.links || [],
      tags: parsed.tags || [],
      summary: parsed.summary ?? null,
      transcription: parsed.transcription ?? null,
      visualContext: parsed.visualContext ?? input.visualContext ?? null,
      overlayText: parsed.overlayText ?? input.ocrText ?? null,
    };

    logInfo('Analisi AI completata', {
      songs: baseResult.songs.length,
      films: baseResult.films.length,
      notes: baseResult.notes.length,
      links: baseResult.links.length,
      tags: baseResult.tags.length,
      hasSummary: !!baseResult.summary,
    });

    return { result: baseResult, usageMetadata: response.usageMetadata };
  } catch (error) {
    logError('Errore analisi AI', error);
    return { result: EMPTY_RESULT, usageMetadata: null };
  }
}
