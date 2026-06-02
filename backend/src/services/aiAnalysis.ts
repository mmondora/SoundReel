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

    // Text-only analysis: OCR already captured slide text, visualContext already
    // describes video frames. No need to pass images to the final LLM — the text
    // model (qwen2.5:3b) handles structured JSON better than the vision model
    // (moondream), which tends to echo the template placeholders.
    const images: OllamaImage[] = [];

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

export interface SlideItem {
  type: 'song' | 'film' | 'book' | 'album' | 'text';
  title: string;
  artist?: string | null;
  director?: string | null;
  year?: number | null;
  notes?: string | null;
  sourceSlide: number;
}

export async function extractFromSlides(
  slideOcrTexts: Array<{ slideIndex: number; text: string }>
): Promise<SlideItem[]> {
  if (slideOcrTexts.length === 0) return [];

  const total = slideOcrTexts.length;
  const results: SlideItem[] = [];

  for (const { slideIndex, text } of slideOcrTexts) {
    if (!text.trim()) continue;

    const prompt = `Questa è la slide ${slideIndex + 1} di ${total} di un carosello Instagram.

Testo OCR estratto:
${text}

Estrai tutti gli oggetti culturali menzionati in formato JSON array.
Per ogni oggetto usa questo schema:
{"type":"song"|"film"|"book"|"album"|"text","title":"...","artist":null,"director":null,"year":null,"notes":null}
Usa null per campi sconosciuti. Se non c'è nulla di estraibile, ritorna [].
Rispondi SOLO con il JSON array, senza testo aggiuntivo.`;

    try {
      const response = await generateText(prompt, []);
      const text_resp = response.text;
      const jsonMatch = text_resp.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as Array<Partial<SlideItem>>;
      for (const item of parsed) {
        if (!item.title) continue;
        results.push({
          type: (item.type as SlideItem['type']) || 'text',
          title: item.title,
          artist: item.artist ?? null,
          director: item.director ?? null,
          year: item.year ?? null,
          notes: item.notes ?? null,
          sourceSlide: slideIndex,
        });
      }
    } catch (e) {
      logWarning(`extractFromSlides slide ${slideIndex} failed`, { error: String(e) });
    }
  }

  logInfo('extractFromSlides', { slides: total, items: results.length });
  return results;
}
