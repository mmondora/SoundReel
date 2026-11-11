import { generateText, OllamaImage, BackendUnavailableError, OllamaTransientError } from './ollamaClient';
import {
  runClaudePrompt,
  logFallbackOutcome,
  type ClaudeFallbackResult,
  type ClaudePromptOptions,
} from './claudeFallback';
import { extractSoftware, mergeSoftware } from './softwareExtraction';
import { isJunkSoftwareTitle, isRealValue } from './placeholderFilter';
import { logInfo, logWarning, logError } from '../utils/logger';
import { getPrompt, renderTemplate } from './promptLoader';
import { getFeaturesConfig, outputLanguageDisplayName } from '../utils/db';
import type { AiAnalysisResult, MediaAiAnalysisResult, AiUsageMetadata } from '../types';
import {
  MUSIC_GATE_MAX_TOKENS,
  MUSIC_GATE_SCHEMA,
  SLIDE_MAX_TOKENS,
  buildMusicGatePrompt,
  buildSlidePrompt,
  isMusicItem,
  itemsOfSlide,
  parseMusicVerdict,
  parseSlideItems,
  slideItemKey,
  type SlideItem,
} from './slideItems';

export type { SlideItem } from './slideItems';

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
    // Il modello ha risposto, ma con qualcosa che non e' un'analisi: troncata sul tetto di token o senza JSON
    // leggibile, anche al secondo tentativo. Non e' "non c'era niente da trovare": ritentabile.
    | 'unusable_output'
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
 * Below this many characters of real source text, burning Claude when Ollama
 * is down is still not worth it — there was almost nothing to analyse.
 */
const MIN_SOURCE_TEXT_FOR_FALLBACK = 40;

/**
 * Oltre quanti caratteri una risposta smette di essere un'analisi.
 *
 * Il tetto vero sta nelle opzioni della richiesta (`num_predict` nel client):
 * questa e' la rete di sicurezza per quando quel tetto non viene applicato —
 * un backend che ignora l'opzione, un router che riscrive le opzioni. Vive
 * qui e non nel client perche' riguarda il testo da interpretare, non il
 * trasporto che lo ha portato.
 *
 * Largo rispetto a un'analisi vera, che sta sotto i mille token: deve
 * scartare le spirali, non i risultati buoni.
 */
export const MAX_RESPONSE_CHARS = 24_000;

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
  software: [],
  links: [],
  tags: [],
  summary: null,
};

/**
 * La forma della risposta, imposta a Ollama (`format: <schema>`).
 *
 * Con il solo `format: "json"` il modello poteva scrivere qualunque chiave. Il 2 novembre, dopo il passaggio a
 * glm-4.7-flash, 33 entry su 91 con del testo sono risultate "completate" senza un tag, una nota o un riassunto: il
 * modello copiava come chiave una riga di istruzioni del prompt e poi si scusava in chiaro, oppure andava in loop fino
 * al tetto di token. Misurato l'8 novembre su 12 entry reali (8 di quelle rotte): con lo schema e un prompt che non
 * chiede di ricopiare trascrizione, OCR e contesto visivo il reel di Cloudflare ha dato la skill come software, 5 tag, una
 * nota e il riassunto, in 5 secondi invece di 11 e di un risultato vuoto.
 *
 * Trascrizione, OCR e contesto visivo non ci sono di proposito: il modello non li ricopia piu' (il codice li prende gia'
 * dall'input) e ogni token in meno e' un loop in meno.
 */
export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    songs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, artist: { type: 'string' }, album: { type: ['string', 'null'] } },
        required: ['title', 'artist'],
      },
    },
    films: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, director: { type: ['string', 'null'] }, year: { type: ['string', 'null'] } },
        required: ['title'],
      },
    },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          category: { type: 'string', enum: ['place', 'event', 'brand', 'book', 'product', 'quote', 'person', 'other'] },
        },
        required: ['text', 'category'],
      },
    },
    software: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: ['string', 'null'] },
          tag: { type: 'string', enum: ['repo', 'product', 'article', 'other'] },
          description: { type: ['string', 'null'] },
        },
        required: ['title', 'tag'],
      },
    },
    links: {
      type: 'array',
      items: { type: 'object', properties: { url: { type: 'string' }, label: { type: ['string', 'null'] } }, required: ['url'] },
    },
    tags: { type: 'array', items: { type: 'string' } },
    summary: { type: ['string', 'null'] },
  },
  required: ['songs', 'films', 'notes', 'software', 'links', 'tags', 'summary'],
} as const;

/**
 * Lo stesso schema, con il riassunto OBBLIGATORIO: per un post che ha del testo il riassunto c'e' sempre, e se manca
 * l'analisi non c'e' stata (e' il segnale che `isEmptyAnalysis` usa). Misurato l'8 novembre su 12 entry reali, due
 * ripetizioni: con il riassunto che puo' essere `null` il modello lo ometteva 7 volte su 18; obbligatorio, 0 su 18, risposte
 * tutte valide, 6 secondi a chiamata. Il riconoscimento dei software, invece, e' instabile con qualunque variante (lo
 * stesso reel dava 0 o 3 voci a seconda del campionamento): per quello conta anche l'arricchimento (`results.enrichments`).
 */
export const ANALYSIS_SCHEMA_WITH_SUMMARY = {
  ...ANALYSIS_SCHEMA,
  properties: { ...ANALYSIS_SCHEMA.properties, summary: { type: 'string', minLength: 10 } },
} as const;

/** Con del testo da riassumere il riassunto e' obbligatorio; senza (solo una miniatura) puo' restare `null`. */
export function analysisSchemaFor(input: AiAnalysisInput): typeof ANALYSIS_SCHEMA | typeof ANALYSIS_SCHEMA_WITH_SUMMARY {
  return sourceTextLength(input) >= MIN_SOURCE_TEXT_FOR_FALLBACK ? ANALYSIS_SCHEMA_WITH_SUMMARY : ANALYSIS_SCHEMA;
}

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
  const features = await getFeaturesConfig();
  const outputLanguage = features.outputLanguage === 'en' ? 'en' : 'it';
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
    outputLanguage,
    outputLanguageName: outputLanguageDisplayName(outputLanguage),
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
  // Una risposta fuori scala non e' un JSON da riparare: e' un modello che ha
  // perso il filo. Il 19 settembre erano 224.000 caratteri con la stessa nota
  // ripetuta fino al troncamento. Dirlo subito costa un confronto; provare a
  // parsarlo costa e non porta niente.
  if (text.length > MAX_RESPONSE_CHARS) {
    logWarning('Risposta AI fuori scala, scartata', {
      chars: text.length,
      limite: MAX_RESPONSE_CHARS,
      inizio: text.slice(0, 200),
    });
    return null;
  }

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
  // Deduplicate: la stessa spirale che produce 224KB puo' anche fermarsi entro
  // il tetto e lasciare venti copie della stessa nota. Sono rumore comunque, e
  // una nota ripetuta non aggiunge niente a chi legge il journal.
  const notesViste = new Set<string>();
  const notes = (parsed.notes || [])
    .filter((n) => isRealValue(n?.text))
    .filter((n) => {
      const chiave = `${n.category ?? ''}::${(n.text ?? '').trim().toLowerCase()}`;
      if (notesViste.has(chiave)) return false;
      notesViste.add(chiave);
      return true;
    });

  const softwareVisti = new Set<string>();
  const software = ((parsed as { software?: unknown }).software as Array<{
    title?: string;
    url?: string | null;
    tag?: string;
    description?: string | null;
  }> | undefined || [])
    .filter((s) => !isJunkSoftwareTitle(s?.title))
    .map((s) => ({
      title: (s.title ?? '').trim(),
      url: isRealValue(s.url) ? String(s.url).trim() : null,
      tag: (['repo', 'product', 'article', 'other'].includes(String(s.tag ?? '').toLowerCase())
        ? String(s.tag).toLowerCase()
        : 'other') as 'repo' | 'product' | 'article' | 'other',
      description: isRealValue(s.description) ? String(s.description) : null,
    }))
    .filter((s) => {
      const chiave = `${s.tag}::${(s.url ?? s.title).toLowerCase()}`;
      if (softwareVisti.has(chiave)) return false;
      softwareVisti.add(chiave);
      return true;
    });

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
    software,
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

/** The usable analysis in a model response, or null when it was cut at the token ceiling or holds no readable JSON. */
function readAnalysis(
  response: { text: string; truncated?: boolean },
  input: AiAnalysisInput,
): MediaAiAnalysisResult | null {
  logInfo('Risposta AI ricevuta', { chars: response.text.length, truncated: response.truncated === true });
  if (response.truncated) return null; // a JSON cut in the middle never parses, and a repaired one would be invented
  return parseAnalysisResponse(response.text, input);
}

function addUsage(a: AiUsageMetadata | null, b: AiUsageMetadata | null): AiUsageMetadata | null {
  if (!a) return b;
  if (!b) return a;
  return {
    ...b,
    promptTokenCount: a.promptTokenCount + b.promptTokenCount,
    candidatesTokenCount: a.candidatesTokenCount + b.candidatesTokenCount,
    totalTokenCount: a.totalTokenCount + b.totalTokenCount,
    estimatedCostUSD: (a.estimatedCostUSD ?? 0) + (b.estimatedCostUSD ?? 0),
  };
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
  const schema = analysisSchemaFor(input);
  // Text-only analysis: OCR already captured slide text, visualContext already
  // describes video frames. No need to pass images to the final LLM — the text
  // model handles structured JSON better than the vision model (moondream),
  // which tends to echo the template placeholders.
  const images: OllamaImage[] = [];

  try {
    // Una risposta troncata o illeggibile NON e' "non c'era niente da trovare": e' un'analisi che non c'e' stata. Prima
    // veniva trattata come risposta vuota valida e l'entry risultava completata a zero, senza che nessuno la riprendesse.
    // Un solo nuovo tentativo qui (un altro campionamento basta quasi sempre); se va male di nuovo e' un fallimento
    // dichiarato e ritentabile, che il job riaccoda da solo (AI_RETRY_MS, AI_RETRY_MAX_ATTEMPTS).
    let response = await generateText(prompt, images, { json: true, schema });
    let ollamaResult = readAnalysis(response, input);
    let usage = response.usageMetadata;
    if (!ollamaResult) {
      logWarning('Risposta Ollama inutilizzabile, riprovo una volta', { truncated: response.truncated === true });
      response = await generateText(prompt, images, { json: true, schema });
      ollamaResult = readAnalysis(response, input);
      usage = addUsage(usage, response.usageMetadata);
    }

    if (!ollamaResult) {
      const reason = response.truncated
        ? 'risposta del modello tagliata dal tetto di token, due volte'
        : 'nessun JSON utilizzabile nella risposta del modello, due volte';
      logWarning('Analisi AI inutilizzabile anche al secondo tentativo', { reason });
      return {
        result: {
          ...EMPTY_RESULT,
          transcription: null,
          visualContext: input.visualContext ?? null,
          overlayText: input.ocrText ?? null,
        },
        usageMetadata: usage,
        fallback: null,
        failure: { category: 'unusable_output', retryable: true, reason },
      };
    }

    // The big schema leaves software[] empty or full of placeholders (measured: 0 items on 135 re-analysed entries, 48 of
    // them naming tools). A small second call that looks for nothing else finds the tools a post names; it only runs
    // when the text hints at software, keeps only names that really are in the text, and never fails the analysis.
    const extra = await extractSoftware({ caption: input.caption, transcript: input.transcript, ocrText: input.ocrText });
    if (extra.items.length > 0) {
      ollamaResult = { ...ollamaResult, software: mergeSoftware(ollamaResult.software ?? [], extra.items) };
    }
    usage = addUsage(usage, extra.usage ?? null);

    // A valid but empty answer is still a valid answer (a post with nothing to extract): Claude used to fire on
    // emptiness and cost ~18s of opus on every quiet reel — the user wants cloud only when the local stack is down.
    logInfo('Analisi AI completata', {
      songs: ollamaResult.songs.length,
      films: ollamaResult.films.length,
      notes: ollamaResult.notes.length,
      software: (ollamaResult.software ?? []).length,
      softwarePass: extra.outcome,
      links: ollamaResult.links.length,
      tags: ollamaResult.tags.length,
      hasSummary: !!ollamaResult.summary,
    });

    return { result: ollamaResult, usageMetadata: usage, fallback: null };
  } catch (error) {
    const failure = classifyAiFailure(error);
    logError('Errore analisi AI', error);

    // Safety net: Ollama/router down, timed out, or queue expired — not "empty JSON".
    const ollamaDown =
      failure.category === 'backend_unavailable' ||
      failure.category === 'aborted' ||
      failure.category === 'transient_503' ||
      failure.category === 'queue_failed' ||
      failure.category === 'queue_expired';

    if (ollamaDown && sourceTextLength(input) >= MIN_SOURCE_TEXT_FOR_FALLBACK) {
      logInfo('Ollama non disponibile, provo il fallback Claude', {
        category: failure.category,
        reason: failure.reason,
      });
      const fallback = await runClaudePrompt(prompt, opts);
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
          return { result: claudeResult, usageMetadata: null, fallback };
        }
        logWarning('Anche il fallback Claude non ha estratto nulla di utile');
      }
      return { result: EMPTY_RESULT, usageMetadata: null, fallback, failure };
    }

    return { result: EMPTY_RESULT, usageMetadata: null, fallback: null, failure };
  }
}

/** The verdict of the question «is this carousel about music?»: `not_asked` when the slides gave no song or album, `unreadable` when the model did not answer with a boolean. */
export type MusicGate = 'not_asked' | 'music' | 'not_music' | 'unreadable';

export interface SlideExtraction {
  items: SlideItem[];
  musicGate: MusicGate;
  /** The songs and albums read from the slides and thrown away because the carousel is not about music (or the verdict could not be read). */
  droppedSongs: number;
}

/**
 * ONE yes/no question for the whole carousel: does it list or recommend music? `true` / `false` as the local model says, `null` when it could not say (a failed call, an answer cut
 * at the ceiling, no boolean): never a yes by default. The caption and the text of the slides are the evidence (`buildMusicGatePrompt`); the answer is one boolean under a schema.
 */
export async function carouselAboutMusic(
  slideOcrTexts: ReadonlyArray<{ slideIndex: number; text: string }>,
  caption: string | null | undefined
): Promise<boolean | null> {
  try {
    const response = await generateText(buildMusicGatePrompt(caption, slideOcrTexts), [], { json: true, schema: MUSIC_GATE_SCHEMA, maxTokens: MUSIC_GATE_MAX_TOKENS });
    if (response.truncated) {
      logWarning('carouselAboutMusic: risposta troncata, il carosello non conta come musica', { maxTokens: MUSIC_GATE_MAX_TOKENS });
      return null;
    }
    const verdict = parseMusicVerdict(response.text);
    if (verdict === null) logWarning('carouselAboutMusic: la risposta non e\' un si o un no', { chars: response.text.length });
    return verdict;
  } catch (e) {
    logWarning('carouselAboutMusic failed', { error: String(e) });
    return null;
  }
}

/**
 * What each slide of a carousel names (songs, albums, films, books): one question to the local model per slide, read in every shape it answers and mended with the OCR
 * text of the slide (`slideItems.ts`: on 10 November a prompt that asked for an array got ONE OBJECT per slide, and ten albums were read as nothing). A slide whose
 * answer was cut, or that failed, is a warning and the others are read; the same item on two slides is one.
 *
 * **The songs and albums are trusted only when the carousel is about music** (11 November: the «ARTIST - TITLE» lines of the OCR made a song of every dash of a roadmap, a stack of
 * tools or a list of horror films, and about nine in ten of the «songs» of 403 old carousels were not music). So when the slides gave any, ONE more question is asked
 * (`carouselAboutMusic`, with the caption): a «no», or an answer that cannot be read, throws them away; the films, books and texts are not songs and stay.
 */
export async function extractFromSlidesDetailed(
  slideOcrTexts: Array<{ slideIndex: number; text: string }>,
  context: { caption?: string | null } = {}
): Promise<SlideExtraction> {
  if (slideOcrTexts.length === 0) return { items: [], musicGate: 'not_asked', droppedSongs: 0 };

  const total = slideOcrTexts.length;
  const results: SlideItem[] = [];
  const seen = new Set<string>();

  for (const { slideIndex, text } of slideOcrTexts) {
    if (!text.trim()) continue;

    try {
      const response = await generateText(buildSlidePrompt(slideIndex, total, text), [], { json: true, maxTokens: SLIDE_MAX_TOKENS });
      if (response.truncated) {
        logWarning(`extractFromSlides slide ${slideIndex}: risposta troncata, la slide non conta`, { maxTokens: SLIDE_MAX_TOKENS });
        continue;
      }
      for (const item of itemsOfSlide(parseSlideItems(response.text, slideIndex), text, slideIndex)) {
        const key = slideItemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(item);
      }
    } catch (e) {
      logWarning(`extractFromSlides slide ${slideIndex} failed`, { error: String(e) });
    }
  }

  let musicGate: MusicGate = 'not_asked';
  let items = results;
  const songs = results.filter(isMusicItem).length;
  if (songs > 0) {
    const about = await carouselAboutMusic(slideOcrTexts, context.caption);
    musicGate = about === null ? 'unreadable' : about ? 'music' : 'not_music';
    if (musicGate !== 'music') items = results.filter((i) => !isMusicItem(i));
  }
  const droppedSongs = results.length - items.length;

  logInfo('extractFromSlides', { slides: total, items: items.length, musicGate, droppedSongs });
  return { items, musicGate, droppedSongs };
}

/** The items of `extractFromSlidesDetailed`, for the callers that need nothing else. */
export async function extractFromSlides(
  slideOcrTexts: Array<{ slideIndex: number; text: string }>,
  context: { caption?: string | null } = {}
): Promise<SlideItem[]> {
  return (await extractFromSlidesDetailed(slideOcrTexts, context)).items;
}
