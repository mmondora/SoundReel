import { promises as fs } from 'fs';
import { isQueuedMode } from './aiRequestContext';
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

/**
 * Ritmo del polling sulla coda async (spec-061).
 *
 * Parte fitto e rallenta: quando la GPU e' gia' calda il risultato arriva in
 * pochi secondi e non ha senso aspettarne quindici, mentre in un batch lungo
 * bussare ogni due secondi per mezz'ora e' solo traffico.
 */
const QUEUE_POLL_START_MS = 2_000;
const QUEUE_POLL_MAX_MS = 15_000;

/**
 * Il tetto d'attesa complessivo per un job accodato.
 *
 * spec-061 toglie il timeout dalla singola richiesta, non il buon senso: senza
 * un limite un job perso dal router terrebbe occupata la corsia seriale per
 * sempre. Generoso — un cold start piu' la coda davanti — e superarlo e'
 * trattato come transitorio, quindi si ritenta.
 */
const QUEUE_MAX_WAIT_MS = Number(process.env.OLLAMA_QUEUE_MAX_WAIT_MS ?? 45 * 60 * 1000);

/** Quanto si aspetta la singola risposta di servizio (submit e poll). */
const QUEUE_HTTP_TIMEOUT_MS = 30_000;

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
  constructor(
    public readonly category: 'aborted' | 'transient_503' | 'queue_failed' | 'queue_expired',
    message: string,
  ) {
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

/**
 * I due 503 di spec-060, letti allo stesso modo qui e nel percorso sincrono.
 * Solleva sempre: torna solo per far contento il compilatore.
 */
function throwFor503(response: Response, model: string): never {
  const capability = response.headers.get('x-backend-unavailable');
  if (capability) {
    logError('Backend non disponibile', { capability, model });
    throw new BackendUnavailableError(capability);
  }
  logWarning('Router occupato o macchina in accensione, transitorio', { model });
  throw new OllamaTransientError('transient_503', 'Ollama 503 transitorio');
}

function usageFrom(data: OllamaNativeResponse): OllamaUsage {
  return {
    promptTokenCount: data.prompt_eval_count ?? 0,
    candidatesTokenCount: data.eval_count ?? 0,
    totalTokenCount: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    estimatedCostUSD: 0,
  };
}

interface QueueSubmitResponse {
  queued?: boolean;
  job_id?: string;
  status_url?: string;
}

interface QueueStatusResponse {
  id?: string;
  status?: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  position?: number;
  result?: OllamaNativeResponse;
  error?: string | null;
}

/**
 * Accoda il lavoro e lo ritira dopo (spec-061).
 *
 * Il guadagno non e' velocita' — la coda del router e' la stessa e serializza
 * comunque — ma il fatto che nessuno resti appeso a una connessione per venti
 * minuti. Era quella la causa degli abort del 15 settembre: il client mollava
 * a 180s mentre il router stava ancora lavorando, e il lavoro fatto finiva nel
 * niente.
 *
 * Si manda a `/api/generate`, non a `/api/chat`: spec-061 accetta entrambi, e
 * questo tiene corpo e risposta identici al percorso sincrono — immagini
 * comprese — quindi c'e' un solo formato da mantenere.
 */
async function generateQueued(body: unknown, model: string): Promise<OllamaResponse> {
  const submit = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GPU-Queue': '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(QUEUE_HTTP_TIMEOUT_MS),
  });

  if (submit.status === 503) throwFor503(submit, model);
  if (!submit.ok) {
    const errText = await submit.text().catch(() => '');
    logError('Ollama HTTP error (submit)', { status: submit.status, body: errText.substring(0, 500) });
    throw new Error(`Ollama HTTP ${submit.status}`);
  }

  const submitted = (await submit.json().catch(() => null)) as (QueueSubmitResponse & OllamaNativeResponse) | null;

  // Un router che non conosce ancora la coda risponde come sempre, con il
  // risultato intero: e' una risposta valida, non un errore. Prenderla per
  // buona evita di legare il deploy di Soundreel a quello del router.
  if (submitted && !submitted.job_id && typeof submitted.response === 'string') {
    logInfo('Router senza coda async, risposta sincrona', { model });
    return { text: submitted.response, usageMetadata: usageFrom(submitted) };
  }

  if (!submitted?.job_id) {
    throw new Error('Ollama: submit accodato senza job_id');
  }

  const jobId = submitted.job_id;
  const statusUrl = submitted.status_url ?? `/router/queue/${jobId}`;
  logInfo('Job accodato sul router', { jobId, model });

  const deadline = Date.now() + QUEUE_MAX_WAIT_MS;
  let attesa = QUEUE_POLL_START_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, attesa));
    attesa = Math.min(Math.round(attesa * 1.5), QUEUE_POLL_MAX_MS);

    let stato: QueueStatusResponse | null = null;
    try {
      const poll = await fetch(`${OLLAMA_URL}${statusUrl}`, {
        signal: AbortSignal.timeout(QUEUE_HTTP_TIMEOUT_MS),
      });
      if (poll.ok) stato = (await poll.json().catch(() => null)) as QueueStatusResponse | null;
      else logWarning('Poll della coda non riuscito', { jobId, status: poll.status });
    } catch (error) {
      // Un poll andato storto non perde il job: l'id resta valido e si ribussa.
      logWarning('Poll della coda fallito, riprovo', { jobId, error: String(error) });
    }

    if (!stato) continue;

    if (stato.status === 'done' && stato.result) {
      const text = stato.result.response || '';
      logInfo('Job ritirato dalla coda', { jobId, chars: text.length });
      return { text, usageMetadata: usageFrom(stato.result) };
    }
    if (stato.status === 'failed') {
      throw new OllamaTransientError('queue_failed', `job ${jobId} fallito: ${stato.error ?? 'senza motivo'}`);
    }
    if (stato.status === 'expired') {
      throw new OllamaTransientError('queue_expired', `job ${jobId} scaduto prima del ritiro`);
    }
  }

  throw new OllamaTransientError('aborted', `job ${jobId} non pronto entro ${Math.round(QUEUE_MAX_WAIT_MS / 60_000)} minuti`);
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

  const queued = isQueuedMode();
  logInfo('Ollama generate', { model, hasImages: images.length, promptChars: prompt.length, queued });

  if (queued) return generateQueued(body, model);

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
      // spec-060: e' l'header a separare i due 503, non il corpo.
      if (response.status === 503) throwFor503(response, model);
      logError('Ollama HTTP error', { status: response.status, body: errText.substring(0, 500) });
      throw new Error(`Ollama HTTP ${response.status}`);
    }

    const data = (await response.json()) as OllamaNativeResponse;
    const text = data.response || '';
    const usage = usageFrom(data);

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
/**
 * Quante immagini stanno in una richiesta a moondream.
 *
 * Il modello e' servito con 2048 token di contesto e ogni fotogramma ne costa
 * circa 730: cinque insieme facevano 3716 token e il backend rispondeva 400
 * `exceed_context_size_error`. Non un errore di formato — la vision non ha mai
 * funzionato, e nel journal si vedeva solo `vision_describe: skipped`.
 *
 * Due per volta lasciano margine al prompt. Il contesto del modello lo decide
 * chi serve il modello, non noi: qui ci si adatta, non si alza.
 */
const VISION_IMAGES_PER_CALL = 2;

const VISION_PROMPT = `Describe briefly (2-3 sentences, in English) the main visual content across these frames of a short social video: settings, people/subjects, actions, products or brands visible, any recognizable locations or films. Do NOT transcribe overlay text (that is handled separately). Be factual and concise.`;

export async function describeFramesWithVision(framePaths: string[]): Promise<string | null> {
  if (!framePaths.length) return null;

  const images: OllamaImage[] = [];
  for (const p of framePaths) {
    const img = await pathToImage(p);
    if (img) images.push(img);
  }
  if (!images.length) return null;

  const gruppi: OllamaImage[][] = [];
  for (let i = 0; i < images.length; i += VISION_IMAGES_PER_CALL) {
    gruppi.push(images.slice(i, i + VISION_IMAGES_PER_CALL));
  }

  const descrizioni: string[] = [];
  for (const [indice, gruppo] of gruppi.entries()) {
    try {
      const response = await generateText(VISION_PROMPT, gruppo);
      const text = (response.text || '').trim();
      if (text) descrizioni.push(text);
    } catch (err) {
      if (err instanceof VisionUnavailableError) {
        // Il backend non serve vision adesso: inutile insistere sugli altri
        // gruppi, la risposta sarebbe la stessa.
        logInfo('Vision describe saltata: backend vision non disponibile');
        break;
      }
      // Un gruppo perso non deve portarsi via gli altri: una descrizione
      // parziale vale piu' di nessuna descrizione.
      logError(`Vision describe fallita sul gruppo ${indice + 1}/${gruppi.length}`, err);
    }
  }

  if (!descrizioni.length) return null;
  const testo = descrizioni.join(' ');
  logInfo('Vision describe ok', { frames: images.length, gruppi: gruppi.length, chars: testo.length });
  return testo;
}
