import { GoogleGenerativeAI } from '@google/generative-ai';
import { defineSecret } from 'firebase-functions/params';
import { logInfo, logWarning, logError } from '../utils/logger';
import { getPrompt, renderTemplate } from './promptLoader';
import type { AiAnalysisResult } from '../types';

const geminiApiKey = defineSecret('GEMINI_API_KEY');

export async function analyzeWithAi(
  caption: string | null,
  thumbnailUrl: string | null
): Promise<AiAnalysisResult> {
  const emptyResult: AiAnalysisResult = { songs: [], films: [], notes: [], links: [], tags: [], summary: null };

  if (!caption && !thumbnailUrl) {
    logInfo('Nessun contenuto da analizzare con AI');
    return emptyResult;
  }

  try {
    const apiKey = geminiApiKey.value();
    if (!apiKey) {
      logWarning('GEMINI_API_KEY non configurata');
      return emptyResult;
    }

    logInfo('Analisi AI con Gemini', { hasCaption: !!caption, hasThumbnail: !!thumbnailUrl });

    // Carica il prompt da Firestore (con cache)
    const promptConfig = await getPrompt('contentAnalysis');
    const prompt = renderTemplate(promptConfig.template, {
      caption: caption || '[nessuna caption]',
      hasImage: !!thumbnailUrl
    });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: prompt }
    ];

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

    const result = await model.generateContent(parts);
    const response = result.response;
    const text = response.text();

    logInfo('Risposta Gemini ricevuta', { length: text.length });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logWarning('Nessun JSON trovato nella risposta Gemini');
      return emptyResult;
    }

    const parsed = JSON.parse(jsonMatch[0]) as AiAnalysisResult;

    logInfo('AI analisi completata', {
      songs: parsed.songs?.length || 0,
      films: parsed.films?.length || 0,
      notes: parsed.notes?.length || 0,
      links: parsed.links?.length || 0,
      tags: parsed.tags?.length || 0,
      hasSummary: !!parsed.summary
    });

    return {
      songs: parsed.songs || [],
      films: parsed.films || [],
      notes: parsed.notes || [],
      links: parsed.links || [],
      tags: parsed.tags || [],
      summary: parsed.summary || null
    };
  } catch (error) {
    logError('Errore analisi AI', error);
    return emptyResult;
  }
}

export { geminiApiKey };
