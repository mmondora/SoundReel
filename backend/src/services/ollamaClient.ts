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

/**
 * Ollama is reached through the gpu-router, never directly.
 *
 * The router is what picks the backend (archi-pc first, the local GEEKOM only
 * as tier 1), what powers archi-pc on when a batch shows up, what refuses a
 * vision model the local GPU cannot serve, and what applies the keep_alive
 * policy. Talking to an Ollama instance straight loses all four silently —
 * the calls still succeed, which is exactly what makes it hard to notice.
 *
 * Hence the default points at the router too: this container sits on the same
 * `web` network as the `ollama` container, so an unset OLLAMA_URL used to fall
 * through to it and quietly bypass everything above.
 */
export const DEFAULT_OLLAMA_URL = 'http://gpu-router:9000';

/**
 * La porta di un Ollama nudo. Sta qui come costante e non come letterale
 * dentro un URL perche' spec-060 vieta all'app di nominare porte di servizi
 * remoti, e il suo self-check cerca esattamente quella stringa con i due punti
 * davanti. Serve solo a riconoscere una configurazione sbagliata, mai a
 * costruire un indirizzo.
 */
export const DIRECT_OLLAMA_PORT = '11434';

/** Looks like an Ollama instance rather than the router. */
export function isDirectOllamaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.port === DIRECT_OLLAMA_PORT || u.hostname === 'ollama' || u.hostname === 'ollama-shim';
  } catch {
    return false;
  }
}

const OLLAMA_URL = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;

if (isDirectOllamaUrl(OLLAMA_URL)) {
  // Not fatal — a deliberate direct URL is a legitimate thing to do while
  // debugging — but it must never happen by accident in production.
  logWarning('OLLAMA_URL punta a un Ollama diretto, non al gpu-router', {
    url: OLLAMA_URL,
    perde: 'load balancing, wake di archi-pc, guardia sui modelli vision, policy keep_alive',
  });
}
/**
 * spec-060 dice di tollerare risposte lente, non di aspettare all'infinito:
 * 180s per un modello 3B sono gia' generosi, e allungarli vorrebbe dire
 * compensare in silenzio un backend lento. Oltre questa soglia la risposta
 * giusta e' contarlo come abort e ritentare.
 */
const REQUEST_TIMEOUT_MS = 180_000;

const TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || 'qwen2.5:3b';
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'moondream:latest';

/**
 * The router refuses vision models when the only healthy backend is the local
 * GPU, which hangs under ROCm vision inference. Not a failure: a capability
 * that is not available right now.
 */
export class VisionUnavailableError extends Error {
  constructor(message = 'vision model not available on local GPU') {
    super(message);
    this.name = 'VisionUnavailableError';
  }
}

/**
 * spec-060: 503 **con** `X-Backend-Unavailable`.
 *
 * Il router non e' riuscito a portare su la macchina che serve quella
 * capability — spenta e non avviabile, cavo staccato. Non e' "riprova fra
 * poco": finche' qualcuno non interviene sull'hardware la risposta sara' la
 * stessa, quindi ritentare all'infinito e' solo rumore. Il lavoro resta
 * pendente e verra' ripreso quando la macchina torna.
 */
export class BackendUnavailableError extends Error {
  constructor(public readonly capability: string) {
    super(`backend non disponibile per ${capability}`);
    this.name = 'BackendUnavailableError';
  }
}

/**
 * spec-060: 503 **senza** quell'header, oppure la richiesta abortita da noi.
 *
 * Il router sta svegliando o accodando una macchina: e' transitorio, si
 * ritenta. L'abort del client sta nella stessa categoria perche' significa la
 * stessa cosa — non abbiamo una risposta *adesso* — ma va contato a parte: il
 * 15 settembre 42 chiamate su 75 sono morte cosi', e nel journal erano
 * indistinguibili da "il modello non ha trovato niente".
 *
 * Il rimedio non e' allungare il timeout: 180s per un 3B sono gia' generosi, e
 * aspettare di piu' vorrebbe dire compensare un backend lento invece di
 * segnalarlo. Il router aspetta per noi; a noi tocca ritentare.
 */
export class OllamaTransientError extends Error {
  constructor(public readonly category: 'aborted' | 'transient_503', message: string) {
    super(message);
    this.name = 'OllamaTransientError';
  }
}

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
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 503 && errText.includes('vision model not available')) {
        logInfo('Vision non disponibile sul backend locale, salto', { model });
        throw new VisionUnavailableError();
      }
      if (response.status === 503) {
        // spec-060: e' l'header a separare i due 503, non il corpo.
        const capability = response.headers.get('x-backend-unavailable');
        if (capability) {
          logError('Backend non disponibile', { capability, model });
          throw new BackendUnavailableError(capability);
        }
        logWarning('Router occupato o macchina in accensione, transitorio', { model });
        throw new OllamaTransientError('transient_503', 'Ollama 503 transitorio');
      }
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
      logWarning('Ollama request aborted', { category: 'aborted', afterMs: REQUEST_TIMEOUT_MS, model });
      throw new OllamaTransientError('aborted', 'Ollama timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export interface ReleaseOutcome {
  released: boolean;
  reason?: string;
  backends?: string[];
}

/**
 * spec-060 (MAY): «ho finito con questo modello».
 *
 * Un suggerimento, non un comando. Il router scarica solo se non ha altro
 * lavoro — in volo, in ammissione o in coda — e altrimenti risponde
 * `{released: false, reason: "coda attiva"}` senza troncare il lavoro di
 * nessuno. Va chiamato **dopo un batch**, mai dopo la singola richiesta:
 * scaricare e ricaricare a ogni chiamata e' esattamente il ciclo che vogliamo
 * evitare.
 *
 * Serve a liberare VRAM su archi-pc (8GB) per chi ne ha bisogno subito dopo —
 * la reforge di signal-brief, ComfyUI. Non e' un requisito di correttezza:
 * senza, ci pensa il keep_alive. Quindi non solleva mai: un fallimento qui non
 * deve avere alcun effetto sulla passata che si e' appena conclusa bene.
 */
export async function releaseModel(model: string = TEXT_MODEL): Promise<ReleaseOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${OLLAMA_URL}/router/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logWarning('Release del modello rifiutata', { model, status: response.status });
      return { released: false, reason: `HTTP ${response.status}` };
    }
    const data = (await response.json().catch(() => null)) as ReleaseOutcome | null;
    if (!data) return { released: false, reason: 'risposta non leggibile' };
    logInfo('Release del modello', { model, released: data.released, reason: data.reason ?? null });
    return data;
  } catch (error) {
    logWarning('Release del modello fallita', { model, error: String(error) });
    return { released: false, reason: String(error) };
  } finally {
    clearTimeout(timer);
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
    if (err instanceof VisionUnavailableError) {
      logInfo('Vision describe saltata: backend vision non disponibile');
      return null;
    }
    logError('Vision describe failed', err);
    return null;
  }
}
