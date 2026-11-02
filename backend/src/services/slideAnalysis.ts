import { basename } from 'node:path';
import { generateText, describeFramesWithVision } from './ollamaClient';
import { runClaudePrompt, logFallbackOutcome, type ClaudePromptOptions } from './claudeFallback';
import { getPrompt, renderTemplate } from './promptLoader';
import { isPlausibleUrl } from './linkValidation';
import { isRealValue } from './placeholderFilter';
import { getFeaturesConfig, outputLanguageDisplayName } from '../utils/db';
import { logInfo, logWarning, logError } from '../utils/logger';
import type { EntrySlide, SlideLink } from '../types';

export interface SlideAnalysisInput {
  entryId: string;
  slidePaths: string[];
  /** OCR text per slide, index-aligned with slidePaths. */
  ocrPerSlide: Array<string | null>;
  caption: string | null;
}

/**
 * Below this many OCR characters a slide is treated as image-only and worth
 * describing with the vision model. Above it, the text already says what the
 * slide is, and vision (~20s per image) would cost minutes per carousel for
 * nothing.
 */
const SLIDE_VISION_MIN_OCR_CHARS = 40;

interface RawSlideResult {
  index?: number;
  summary?: string | null;
  links?: Array<{ url?: unknown; label?: unknown }>;
}

function parseSlideResponse(text: string): Map<number, RawSlideResult> {
  const byIndex = new Map<number, RawSlideResult>();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return byIndex;

  let parsed: { slides?: RawSlideResult[] };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return byIndex;
  }

  for (const entry of parsed.slides ?? []) {
    if (typeof entry?.index === 'number') byIndex.set(entry.index, entry);
  }
  return byIndex;
}

/**
 * Slide links are *suggested* destinations (the slide says "Plex", the model
 * resolves it to plex.tv), so unlike extracted links they cannot be checked
 * against the source text — that check exists to kill hallucinated URLs during
 * extraction and would reject every correct answer here. They must still be
 * shaped like real URLs and carry a real label.
 */
function parseLinks(raw: RawSlideResult['links']): SlideLink[] {
  if (!Array.isArray(raw)) return [];
  const out: SlideLink[] = [];
  const seen = new Set<string>();

  for (const link of raw) {
    const url = typeof link?.url === 'string' ? link.url.trim() : '';
    const label = typeof link?.label === 'string' ? link.label.trim() : '';
    if (!isPlausibleUrl(url) || !isRealValue(label)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label });
  }
  return out;
}

/** Analyse every slide of a carousel, returning one record per slide. */
export async function analyzeSlides(
  input: SlideAnalysisInput,
  opts: ClaudePromptOptions = {}
): Promise<EntrySlide[]> {
  if (!input.slidePaths.length) return [];

  // Base records first: even if every model call fails, the per-slide OCR text
  // is a large improvement over the single merged blob stored today.
  const slides: EntrySlide[] = input.slidePaths.map((path, index) => {
    const ocrText = input.ocrPerSlide[index]?.trim() || null;
    return {
      index,
      imageUrl: `/media/${input.entryId}/${basename(path)}`,
      ocrText,
      visualDescription: null,
      summary: null,
      links: [],
    };
  });

  for (const slide of slides) {
    if ((slide.ocrText?.length ?? 0) >= SLIDE_VISION_MIN_OCR_CHARS) continue;
    try {
      slide.visualDescription = await describeFramesWithVision([input.slidePaths[slide.index]]);
    } catch (err) {
      logWarning('Vision su slide fallita', { index: slide.index, error: String(err) });
    }
  }

  const features = await getFeaturesConfig();
  const outputLanguage = features.outputLanguage === 'en' ? 'en' : 'it';
  const promptConfig = await getPrompt('slideAnalysis');
  const prompt = renderTemplate(promptConfig.template, {
    slideCount: slides.length,
    caption: input.caption,
    outputLanguage,
    outputLanguageName: outputLanguageDisplayName(outputLanguage),
    slides: slides.map((s) => ({
      indexLabel: `${s.index + 1} / ${slides.length}`,
      index: s.index,
      ocrText: s.ocrText,
      visualDescription: s.visualDescription,
    })),
  });

  // One call for all slides: cheaper than one per slide, and the model can see
  // that a slide is item 3 of a list rather than judging it in isolation.
  let byIndex = new Map<number, RawSlideResult>();
  try {
    const response = await generateText(prompt, [], { json: true });
    byIndex = parseSlideResponse(response.text);
  } catch (err) {
    logError('Analisi slide con Ollama fallita', err);
  }

  if (byIndex.size === 0) {
    logInfo('Ollama non ha prodotto risultati per le slide, provo Claude');
    const fallback = await runClaudePrompt(prompt, opts);
    logFallbackOutcome(fallback);
    if (fallback.status === 'ok' && fallback.text) {
      byIndex = parseSlideResponse(fallback.text);
    }
  }

  for (const slide of slides) {
    const raw = byIndex.get(slide.index);
    if (!raw) continue;
    slide.summary = isRealValue(raw.summary) ? raw.summary.trim() : null;
    slide.links = parseLinks(raw.links);
  }

  // Small local models often mirror OCR language despite prompt rules
  // ("La slide presenta un texto extracto…"). A short dedicated translate
  // pass is cheap and much more reliable than hoping the first call obeys.
  await ensureSummariesInLanguage(slides, outputLanguage);

  logInfo('Analisi slide completata', {
    slides: slides.length,
    withOcr: slides.filter((s) => s.ocrText).length,
    withVision: slides.filter((s) => s.visualDescription).length,
    withSummary: slides.filter((s) => s.summary).length,
    totalLinks: slides.reduce((n, s) => n + s.links.length, 0),
    outputLanguage,
  });

  return slides;
}

/** Heuristic: summaries that still look like Spanish after an Italian request. */
function looksForeignForItalian(text: string): boolean {
  return /\b(texto|extracto|extra[ií]do|extractado|muestra|historia|trayectoria|incluyendo|empresa|declaraci[oó]n|nieto|creador|bodega)\b/i.test(
    text
  );
}

const TRANSLATE_BATCH = 4;

async function ensureSummariesInLanguage(
  slides: EntrySlide[],
  outputLanguage: 'it' | 'en'
): Promise<void> {
  const targets = slides.filter((s) => {
    if (!s.summary) return false;
    if (outputLanguage === 'it') return looksForeignForItalian(s.summary);
    return false;
  });
  if (targets.length === 0) return;

  const langName = outputLanguageDisplayName(outputLanguage);
  let applied = 0;

  for (let i = 0; i < targets.length; i += TRANSLATE_BATCH) {
    const batch = targets.slice(i, i + TRANSLATE_BATCH);
    const list = batch.map((s) => `${s.index}: ${s.summary}`).join('\n');
    const translatePrompt = `Translate each numbered paragraph into ${langName}. Keep proper names. No commentary.

${list}

Reply ONLY with JSON:
{"slides":[{"index":${batch[0].index},"summary":"..."}]}`;

    try {
      const response = await generateText(translatePrompt, [], { json: true });
      const translated = parseSlideResponse(response.text);
      for (const slide of batch) {
        const raw = translated.get(slide.index);
        if (!raw || !isRealValue(raw.summary)) continue;
        const next = raw.summary!.trim();
        // Reject if the model echoed Spanish again.
        if (outputLanguage === 'it' && looksForeignForItalian(next)) continue;
        slide.summary = next;
        applied++;
      }
    } catch (err) {
      logWarning('Traduzione summary slide fallita', {
        error: String(err),
        batchStart: batch[0]?.index,
      });
    }
  }

  logInfo('Slide summaries translated to output language', {
    outputLanguage,
    candidates: targets.length,
    applied,
    batches: Math.ceil(targets.length / TRANSLATE_BATCH),
  });
}
