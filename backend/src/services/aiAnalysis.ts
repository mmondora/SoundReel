import { generateText, OllamaImage, BackendUnavailableError, OllamaTransientError } from './ollamaClient';
import {
  runClaudePrompt,
  logFallbackOutcome,
  type ClaudeFallbackResult,
  type ClaudePromptOptions,
} from './claudeFallback';
import { isRealValue } from './placeholderFilter';
import { logInfo, logWarning, logError } from '../utils/logger';
import { getPrompt, renderTemplate } from './promptLoader';
import type { AiAnalysisResult, MediaAiAnalysisResult, AiUsageMetadata } from '../types';

/**
 * Perche' l'analisi non ha prodotto nulla, quando non e' perche' non c'era
 * niente da trovare.
 *
 * Senza questo campo un fallimento e un risultato vuoto erano la stessa riga
 * nel journal: `{tags: 0, films: 0, notes: 0, songs: 0}`. Il 15 settembre 42
 * chiamate su 75 sono morte in timeout e 49 entry su 81 risultavano analizzate
 * e prive di contenuto — indistinguibili da un post che davvero non contiene
 * niente. spec-060 chiede di contare abort e 503 come categoria propria.
 */
export type AiFailure = {
  category:
    | 'aborted'
    | 'transient_503'
    | 'backend_unavailable'
    // spec-061: il job era in coda sul router e non e' tornato — fallito o
    // scaduto prima del ritiro. Transitorio come gli altri due, ma va distinto
    // nel journal: dice che il problema sta dopo l'accodamento, non prima.
    | 'queue_failed'
    | 'queue_expired'
    | 'error';
  /** Ritentare ha senso? Falso solo quando serve un intervento umano. */
  retryable: boolean;
  reason: string;
};

export interface AiAnalysisResponse {
  result: AiAnalysisResult | MediaAiAnalysisResult;
  usageMetadata: AiUsageMetadata | null;
  /** Outcome of the Claude cascade, or null when it was never reached. */
  fallback: ClaudeFallbackResult | null;
  /** Assente quando l'analisi e' arrivata in fondo, qualunque cosa abbia trovato. */
  failure?: AiFailure;
}

/** Traduce l'errore del client in una categoria per il journal. */
export function classifyAiFailure(error: unknown): AiFailure {
  if (error instanceof BackendUnavailableError) {
    return {
      category: 'backend_unavailable',
      // Serve che qualcuno rimetta in piedi la macchina: ritentare a raffica
      // non la riporta su, produce solo rumore.
      retryable: false,
      reason: `backend non disponibile (${error.capability})`,
    };
  }
  if (error instanceof OllamaTransientError) {
    return { category: error.category, retryable: true, reason: error.message };
  }
  return {
    category: 'error',
    retryable: false,
    reason: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Below this many characters of real source text, an empty result is most likely
 * correct (a story with no caption, no speech and no on-screen text) rather than
 * a model failure — not worth spending subscription quota on.
 */
const MIN_SOURCE_TEXT_FOR_FALLBACK = 40;

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

/**
 * Ripulisce il testo che finisce dentro il prompt e che il modello ricopiera'
 * nel proprio JSON.
 *
 * L'OCR di un frame produce rumore: barre rovesciate isolate, entita' HTML,
 * caratteri di controllo. Il modello le riporta fedelmente nei campi di
 * output, e una barra rovesciata dentro una stringa JSON e' una sequenza di
 * escape non valida che fa saltare *tutto* il documento — non il campo, tutto.
 *
 * Il 19 settembre e' costato due chiamate a Claude su un'analisi che qwen
 * aveva gia' fatto bene: note giuste, persona giusta, link giusto, buttati per
 * una `\` che l'OCR aveva letto in un fotogramma.
 *
 * Toglie solo cio' che non porta significato: la barra rovesciata diventa uno
 * spazio, i caratteri di controllo spariscono. Il testo leggibile resta intero.
 */
export function sanitizeForPrompt(text: string | null): string | null {
  if (!text) return text;
  const pulito = text
    .replace(/\\/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return pulito.length ? pulito : null;
}

/**
 * Render the content-analysis prompt. Exported so the backfill script sends the
 * exact same prompt the live pipeline does, keeping the two from drifting.
 */
export async function buildAnalysisPrompt(input: AiAnalysisInput): Promise<string> {
  const promptConfig = await getPrompt('contentAnalysis');
  const isCarousel = input.slidePaths.length > 0;
  return renderTemplate(promptConfig.template, {
    caption: input.caption || '[nessuna caption]',
    hasCaption: !!input.caption,
    musicInfo: input.musicInfo,
    hasMusicInfo: !!input.musicInfo,
    transcript: input.transcript || null,
    hasTranscript: !!input.transcript,
    transcriptLanguage: input.transcriptLanguage || null,
    // Ripuliti perche' il modello li ricopia nel JSON di risposta: vedi
    // sanitizeForPrompt.
    ocrText: sanitizeForPrompt(input.ocrText),
    hasOcr: !!input.ocrText,
    visualContext: sanitizeForPrompt(input.visualContext),
    hasVisualContext: !!input.visualContext,
    isCarousel,
    carouselCount: input.slidePaths.length,
    hasImage: !!input.thumbnailPath || isCarousel,
    // Legacy compat: older prompts may still reference hasImage
  });
}

/** I caratteri che possono legittimamente seguire una barra rovesciata in JSON. */
const ESCAPE_VALIDI = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * Raddoppia le barre rovesciate che non aprono una sequenza di escape valida.
 *
 * Un modello che ricopia del testo OCR dentro una stringa JSON produce cose
 * come `"wif We % \ N"`: per JSON quella barra apre un escape, `\ ` non
 * esiste, e il documento intero diventa illeggibile. Raddoppiarla la rende il
 * carattere che il modello intendeva.
 *
 * Volutamente miope: guarda un carattere alla volta e non prova a capire la
 * struttura. Un `\u` seguito da qualcosa che non sono quattro cifre esadecimali
 * e' altrettanto rotto, quindi rientra. Se dopo la riparazione il JSON non si
 * parsa lo stesso, si rinuncia come prima — meglio nessun risultato che uno
 * inventato dal riparatore.
 */
export function repairJsonEscapes(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const next = raw[i + 1];
    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += raw.slice(i, i + 6); i += 5; continue; }
      out += '\\\\';
      continue;
    }
    if (next !== undefined && ESCAPE_VALIDI.has(next)) { out += c + next; i++; continue; }
    out += '\\\\';
  }
  return out;
}

/**
 * Turn a raw model response into a validated result, or null when the response
 * carries no usable JSON. Shared by the Ollama and Claude paths so a hallucinated
 * link is rejected identically whichever model produced it.
 */
export function parseAnalysisResponse(
  text: string,
  input: AiAnalysisInput
): MediaAiAnalysisResult | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: Partial<MediaAiAnalysisResult>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (primoErrore) {
    // Un solo carattere sbagliato in un campo qualunque buttava via l'intera
    // analisi e mandava la richiesta su Claude, a pagamento, per rifare un
    // lavoro gia' fatto. Prima di arrendersi si tenta la riparazione: tocca
    // solo le sequenze di escape non valide, il contenuto resta quello del
    // modello.
    const riparato = repairJsonEscapes(jsonMatch[0]);
    let recuperato: Partial<MediaAiAnalysisResult> | null = null;
    if (riparato !== jsonMatch[0]) {
      try {
        recuperato = JSON.parse(riparato);
        logInfo('JSON AI riparato', { motivo: String(primoErrore).slice(0, 120) });
      } catch {
        recuperato = null;
      }
    }
    if (!recuperato) {
      logWarning('JSON AI invalido', {
        errore: String(primoErrore).slice(0, 200),
        // 300 caratteri nascondevano la causa: l'errore stava a meta' documento.
        preview: jsonMatch[0].substring(0, 1200),
      });
      return null;
    }
    parsed = recuperato;
  }

  const sourceText = [input.caption, input.ocrText, input.transcript].filter(Boolean).join(' ');
  const verifiedLinks = (parsed.links || []).filter(
    (l): l is { url: string; label: string | null } =>
      typeof l?.url === 'string' && sourceText.includes(l.url)
  );

  // Drop items where the model echoed the prompt's own JSON skeleton instead of
  // filling it in (a song of {title: "...", artist: "..."} reached production
  // this way and polluted the songs page).
  const songs = (parsed.songs || []).filter((s) => isRealValue(s?.title));
  const films = (parsed.films || []).filter((f) => isRealValue(f?.title));
  const notes = (parsed.notes || []).filter((n) => isRealValue(n?.text));

  return {
    songs: songs.map((s) => ({
      ...s,
      artist: isRealValue(s.artist) ? s.artist : '',
      album: isRealValue(s.album) ? s.album : null,
    })),
    films: films.map((f) => ({
      ...f,
      director: isRealValue(f.director) ? f.director : null,
      year: isRealValue(f.year) ? f.year : null,
    })),
    notes,
    links: verifiedLinks,
    tags: (parsed.tags || []).filter(isRealValue),
    summary: isRealValue(parsed.summary) ? parsed.summary : null,
    transcription: parsed.transcription ?? null,
    visualContext: parsed.visualContext ?? input.visualContext ?? null,
    overlayText: parsed.overlayText ?? input.ocrText ?? null,
  };
}

/**
 * Did the model actually understand the content?
 *
 * Tags and links alone do not count: an entry with only hashtags scraped and no
 * summary is exactly the failure mode the Claude cascade exists to fix.
 *
 * This judges the model's own output, where every song is by definition
 * model-derived — the background track Instagram attaches is resolved by the
 * audio pipeline and merged in later, so it never appears here. Repair passes
 * that read *stored* results must exclude `source: 'audio_fingerprint'`
 * themselves (see the query in scripts/backfillAnalysis.ts); treating a stray
 * background track as comprehension hid 128 failed analyses from that script.
 */
export function isEmptyAnalysis(r: MediaAiAnalysisResult | null): boolean {
  if (!r) return true;
  return !r.summary && r.songs.length === 0 && r.films.length === 0 && r.notes.length === 0;
}

function sourceTextLength(input: AiAnalysisInput): number {
  return [input.caption, input.ocrText, input.transcript]
    .filter(Boolean)
    .join(' ')
    .trim()
    .length;
}

export async function analyzeWithAi(
  input: AiAnalysisInput,
  opts: ClaudePromptOptions = {}
): Promise<AiAnalysisResponse> {
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
    return { result: EMPTY_RESULT, usageMetadata: null, fallback: null };
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

    const prompt = await buildAnalysisPrompt(input);

    // Text-only analysis: OCR already captured slide text, visualContext already
    // describes video frames. No need to pass images to the final LLM — the text
    // model (qwen2.5:3b) handles structured JSON better than the vision model
    // (moondream), which tends to echo the template placeholders.
    const images: OllamaImage[] = [];

    const response = await generateText(prompt, images);
    const text = response.text;
    logInfo('Risposta AI ricevuta', { chars: text.length });

    const ollamaResult = parseAnalysisResponse(text, input);
    if (!ollamaResult) logWarning('Nessun JSON utilizzabile nella risposta Ollama');

    // Cascade: the local model returns nothing at all on a large share of entries
    // even when handed a full caption + transcript + OCR payload. Retry the very
    // same prompt through Claude before giving up.
    let fallback: ClaudeFallbackResult | null = null;
    if (isEmptyAnalysis(ollamaResult) && sourceTextLength(input) >= MIN_SOURCE_TEXT_FOR_FALLBACK) {
      logInfo('Ollama non ha estratto nulla, provo il fallback Claude');
      fallback = await runClaudePrompt(prompt, opts);
      logFallbackOutcome(fallback);

      if (fallback.status === 'ok' && fallback.text) {
        const claudeResult = parseAnalysisResponse(fallback.text, input);
        if (!isEmptyAnalysis(claudeResult) && claudeResult) {
          logInfo('Analisi recuperata dal fallback Claude', {
            model: fallback.model,
            songs: claudeResult.songs.length,
            films: claudeResult.films.length,
            notes: claudeResult.notes.length,
            hasSummary: !!claudeResult.summary,
          });
          return { result: claudeResult, usageMetadata: response.usageMetadata, fallback };
        }
        logWarning('Anche il fallback Claude non ha estratto nulla di utile');
      }
    }

    const baseResult = ollamaResult ?? { ...EMPTY_RESULT, transcription: null, visualContext: input.visualContext ?? null, overlayText: input.ocrText ?? null };

    logInfo('Analisi AI completata', {
      songs: baseResult.songs.length,
      films: baseResult.films.length,
      notes: baseResult.notes.length,
      links: baseResult.links.length,
      tags: baseResult.tags.length,
      hasSummary: !!baseResult.summary,
    });

    return { result: baseResult, usageMetadata: response.usageMetadata, fallback };
  } catch (error) {
    const failure = classifyAiFailure(error);
    logError('Errore analisi AI', error);
    return { result: EMPTY_RESULT, usageMetadata: null, fallback: null, failure };
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
