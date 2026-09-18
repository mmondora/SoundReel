import { AsyncLocalStorage } from 'async_hooks';

/**
 * Come questa passata vuole ritirare il risultato dal gpu-router.
 *
 * spec-061: la coda del router e' una sola e serializza comunque sulla GPU;
 * l'header `X-GPU-Queue` cambia soltanto *come* il risultato torna indietro.
 * Tenere la connessione aperta va bene per un'attesa breve — qualcuno sta
 * guardando lo schermo — ed e' sbagliato per una passata batch: il 15 settembre
 * 42 chiamate su 75 sono morte in abort proprio cosi', con il router che
 * lavorava e noi che avevamo gia' riagganciato.
 */
export interface AiRequestMode {
  /** Accoda e ritira dopo, invece di restare appesi alla risposta. */
  queued: boolean;
}

const storage = new AsyncLocalStorage<AiRequestMode>();

/**
 * Dichiara la modalita' per tutto il lavoro che segue in questo contesto async.
 *
 * `enterWith` invece di `run`: le chiamate a ollama sono sparse su otto punti
 * fra route, analisi, slide e vision, e passarsi un parametro fino in fondo
 * avrebbe toccato tutte le firme per un dato che riguarda la *richiesta*, non
 * la singola funzione. Va chiamata una volta per richiesta e sempre in modo
 * esplicito — anche per dire `queued: false` — cosi' nessuna richiesta eredita
 * la modalita' di un'altra.
 */
export function setAiRequestMode(mode: AiRequestMode): void {
  storage.enterWith(mode);
}

/** Per i test e per i percorsi che vogliono un confine netto. */
export function runWithAiRequestMode<T>(mode: AiRequestMode, fn: () => T): T {
  return storage.run(mode, fn);
}

/**
 * Fuori da una richiesta (script, hook di arricchimento) si resta sincroni:
 * sono chiamate singole, e il default deve essere quello che non cambia il
 * comportamento di chi non sa niente di questa modalita'.
 */
export function isQueuedMode(): boolean {
  return storage.getStore()?.queued === true;
}
