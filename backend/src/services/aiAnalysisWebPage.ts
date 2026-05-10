// backend/src/services/aiAnalysisWebPage.ts

import { generateText } from './ollamaClient';
import { logInfo, logWarning } from '../utils/logger';
import { getPrompt, renderTemplate } from './promptLoader';
import type { MediaAiAnalysisResult, ExtractedLink, ExtractedLinkCategory, AiUsageMetadata } from '../types';
import type { PageExtractResult } from './pageExtractor';

export interface WebPageAnalysisResponse {
  result: MediaAiAnalysisResult;
  usageMetadata: AiUsageMetadata | null;
}

const VALID_CATEGORIES: ExtractedLinkCategory[] = [
  'referenced', 'sponsor', 'navigation', 'related', 'social', 'other',
];

const MAIN_TEXT_BUDGET = 8_000; // chars

const EMPTY: MediaAiAnalysisResult = {
  songs: [],
  films: [],
  notes: [],
  links: [],
  tags: [],
  summary: null,
  transcription: null,
  visualContext: null,
  overlayText: null,
};

export async function analyzeWebPage(input: PageExtractResult): Promise<WebPageAnalysisResponse> {
  const hasAnyInput = !!input.title || !!input.description || !!input.mainText || input.rawLinks.length > 0;
  if (!hasAnyInput) {
    logInfo('Pagina senza contenuto analizzabile');
    return { result: EMPTY, usageMetadata: null };
  }

  const promptConfig = await getPrompt('webPageAnalysis');
  const mainText = input.mainText
    ? input.mainText.length > MAIN_TEXT_BUDGET
      ? input.mainText.slice(0, MAIN_TEXT_BUDGET) + '\n[...troncato...]'
      : input.mainText
    : null;

  const prompt = renderTemplate(promptConfig.template, {
    title: input.title || '[senza titolo]',
    description: input.description || null,
    siteName: input.siteName || null,
    lang: input.lang || null,
    mainText,
    hasMainText: !!mainText,
    rawLinks: input.rawLinks,
  });

  let response;
  try {
    response = await generateText(prompt);
  } catch (e) {
    logWarning('Web-page LLM failed', { error: String(e) });
    return { result: EMPTY, usageMetadata: null };
  }

  const parsed = parseJsonLoose(response.text);
  if (!parsed) {
    logWarning('Web-page LLM JSON parse failed', { raw: response.text.slice(0, 500) });
    return { result: EMPTY, usageMetadata: response.usageMetadata };
  }

  const allowedUrls = new Set(input.rawLinks.map((l) => l.url));
  const links = sanitizeLinks(parsed.links, allowedUrls);

  const result: MediaAiAnalysisResult = {
    songs: Array.isArray(parsed.songs) ? parsed.songs.filter(isSongShape) : [],
    films: Array.isArray(parsed.films) ? parsed.films.filter(isFilmShape) : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter(isNoteShape) : [],
    links,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.filter((t: unknown): t is string => typeof t === 'string').slice(0, 16)
      : [],
    summary: typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 500)
      : null,
    transcription: null,
    visualContext: null,
    overlayText: null,
  };

  return { result, usageMetadata: response.usageMetadata };
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sanitizeLinks(value: unknown, allowed: Set<string>): ExtractedLink[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractedLink[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url : null;
    if (!url || !allowed.has(url)) continue;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : null;
    const cat = typeof o.category === 'string' ? (o.category as ExtractedLinkCategory) : null;
    const category = cat && VALID_CATEGORIES.includes(cat) ? cat : 'other';
    out.push({ url, label, category });
    if (out.length >= 30) break;
  }
  return out;
}

function isSongShape(v: unknown): v is { title: string; artist: string; album: string | null } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === 'string' && typeof o.artist === 'string';
}

function isFilmShape(v: unknown): v is { title: string; director: string | null; year: string | null } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === 'string';
}

function isNoteShape(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.text === 'string' && typeof o.category === 'string';
}
