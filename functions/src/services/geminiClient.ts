import { GoogleGenerativeAI } from '@google/generative-ai';
import { VertexAI } from '@google-cloud/vertexai';
import { defineSecret } from 'firebase-functions/params';
import { logInfo, logWarning } from '../utils/logger';
import type { GeminiUsageMetadata } from '../types';

const geminiApiKey = defineSecret('GEMINI_API_KEY');

const MODEL_NAME = 'gemini-2.0-flash';

// Gemini Flash pricing (per 1M tokens)
const INPUT_PRICE_PER_M = 0.10;
const OUTPUT_PRICE_PER_M = 0.40;

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GeminiResponse {
  text: string;
  usageMetadata: GeminiUsageMetadata;
}

function computeCost(promptTokens: number, candidateTokens: number): number {
  return (promptTokens / 1_000_000) * INPUT_PRICE_PER_M +
         (candidateTokens / 1_000_000) * OUTPUT_PRICE_PER_M;
}

export async function generateContent(
  parts: GeminiPart[],
  useVertexAi: boolean
): Promise<GeminiResponse> {
  if (useVertexAi) {
    return generateWithVertexAi(parts);
  }
  return generateWithGoogleAi(parts);
}

async function generateWithVertexAi(parts: GeminiPart[]): Promise<GeminiResponse> {
  logInfo('Usando Vertex AI per generazione contenuto');

  const vertexAi = new VertexAI({
    project: 'soundreel-776c1',
    location: 'europe-west1'
  });

  const model = vertexAi.getGenerativeModel({ model: MODEL_NAME });

  // Convert parts to Vertex AI format
  const vertexParts = parts.map(part => {
    if ('text' in part) {
      return { text: part.text };
    }
    return {
      inlineData: {
        mimeType: part.inlineData.mimeType,
        data: part.inlineData.data
      }
    };
  });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: vertexParts }]
  });

  const response = result.response;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

  const usage = response.usageMetadata;
  const promptTokenCount = usage?.promptTokenCount || 0;
  const candidatesTokenCount = usage?.candidatesTokenCount || 0;
  const totalTokenCount = usage?.totalTokenCount || 0;
  const estimatedCostUSD = computeCost(promptTokenCount, candidatesTokenCount);

  logInfo('Vertex AI risposta ricevuta', {
    promptTokens: promptTokenCount,
    candidateTokens: candidatesTokenCount,
    totalTokens: totalTokenCount,
    estimatedCostUSD
  });

  return {
    text,
    usageMetadata: {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount,
      estimatedCostUSD
    }
  };
}

async function generateWithGoogleAi(parts: GeminiPart[]): Promise<GeminiResponse> {
  const apiKey = geminiApiKey.value();
  if (!apiKey) {
    logWarning('GEMINI_API_KEY non configurata, impossibile usare Google AI Studio');
    return {
      text: '',
      usageMetadata: {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
        estimatedCostUSD: 0
      }
    };
  }

  logInfo('Usando Google AI Studio per generazione contenuto');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const result = await model.generateContent(parts);
  const response = result.response;
  const text = response.text();

  const usage = response.usageMetadata;
  const promptTokenCount = usage?.promptTokenCount || 0;
  const candidatesTokenCount = usage?.candidatesTokenCount || 0;
  const totalTokenCount = usage?.totalTokenCount || 0;
  const estimatedCostUSD = computeCost(promptTokenCount, candidatesTokenCount);

  logInfo('Google AI Studio risposta ricevuta', {
    promptTokens: promptTokenCount,
    candidateTokens: candidatesTokenCount,
    totalTokens: totalTokenCount,
    estimatedCostUSD
  });

  return {
    text,
    usageMetadata: {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount,
      estimatedCostUSD
    }
  };
}

export { geminiApiKey };
