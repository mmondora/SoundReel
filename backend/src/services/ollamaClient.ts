import { promises as fs } from 'fs';
import { logInfo, logWarning, logError } from '../utils/logger';

export interface OllamaImage {
  mimeType: string;
  base64: string;
}

export interface OllamaUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  estimatedCostUSD: number;
}

export interface OllamaResponse {
  text: string;
  usageMetadata: OllamaUsage | null;
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama:11434';
const TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || 'qwen2.5:3b';
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'moondream:latest';

interface OllamaNativeResponse {
  response?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export async function generateText(
  prompt: string,
  images: OllamaImage[] = []
): Promise<OllamaResponse> {
  const model = images.length > 0 ? VISION_MODEL : TEXT_MODEL;
  const body = {
    model,
    prompt,
    stream: false,
    images: images.map((img) => img.base64),
    options: {
      temperature: 0.2,
      num_ctx: 8192,
    },
  };

  logInfo('Ollama generate', { model, hasImages: images.length, promptChars: prompt.length });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      logError('Ollama HTTP error', { status: response.status, body: errText.substring(0, 500) });
      throw new Error(`Ollama HTTP ${response.status}`);
    }

    const data = (await response.json()) as OllamaNativeResponse;
    const text = data.response || '';
    const usage: OllamaUsage = {
      promptTokenCount: data.prompt_eval_count ?? 0,
      candidatesTokenCount: data.eval_count ?? 0,
      totalTokenCount: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      estimatedCostUSD: 0,
    };

    logInfo('Ollama response', { chars: text.length, tokens: usage.totalTokenCount });
    return { text, usageMetadata: usage };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logWarning('Ollama request timeout');
      throw new Error('Ollama timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function pathToImage(filePath: string): Promise<OllamaImage | null> {
  try {
    const buf = await fs.readFile(filePath);
    const ext = filePath.toLowerCase().split('.').pop() || 'jpg';
    const mimeType =
      ext === 'png' ? 'image/png' :
      ext === 'webp' ? 'image/webp' :
      'image/jpeg';
    return { mimeType, base64: buf.toString('base64') };
  } catch (err) {
    logWarning('Impossibile leggere immagine da path', { filePath, error: String(err) });
    return null;
  }
}

/**
 * Describe visual context of N key video frames using the vision model.
 * Returns a compact description or null if no frames available / request failed.
 */
export async function describeFramesWithVision(framePaths: string[]): Promise<string | null> {
  if (!framePaths.length) return null;

  const images: OllamaImage[] = [];
  for (const p of framePaths) {
    const img = await pathToImage(p);
    if (img) images.push(img);
  }
  if (!images.length) return null;

  const prompt = `Describe briefly (2-3 sentences, in English) the main visual content across these frames of a short social video: settings, people/subjects, actions, products or brands visible, any recognizable locations or films. Do NOT transcribe overlay text (that is handled separately). Be factual and concise.`;

  try {
    const response = await generateText(prompt, images);
    const text = (response.text || '').trim();
    if (!text) return null;
    logInfo('Vision describe ok', { frames: images.length, chars: text.length });
    return text;
  } catch (err) {
    logError('Vision describe failed', err);
    return null;
  }
}
