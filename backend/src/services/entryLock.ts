import type { Entry } from '../types';

/**
 * Quanto a lungo una passata che ha smesso di scrivere viene creduta viva.
 *
 * Non e' il timeout della pipeline (120s): una passata con Whisper, OCR e
 * vision dura molto di piu'. E' la soglia oltre la quale si assume che il
 * processo sia morto senza chiudere la riga — un riavvio del container, un
 * OOM — e quindi riprovare e' giusto.
 */
export const STALE_PROCESSING_MS = 15 * 60 * 1000;

/**
 * Le azioni che aprono una passata, e quella che la chiude.
 *
 * Il marcatore e' scritto dalla route quando comincia a lavorare, e questo e'
 * il punto: `status = 'processing'` da solo non basta a dire che qualcuno sta
 * lavorando. Il webhook Telegram crea uno stub gia' in `processing` con il
 * solo `url_received` e poi accoda il job; leggere quello stato come "passata
 * viva" faceva rifiutare con 409 proprio la passata che doveva riempirlo, e
 * ogni post inviato dal bot moriva cosi'.
 */
const START_ACTIONS = new Set(['analysis_started', 'reanalyze_started']);
const END_ACTIONS = new Set(['completed']);

function parseTs(value: unknown): number | null {
  const t = Date.parse(String(value ?? ''));
  return Number.isNaN(t) ? null : t;
}

/** L'ultimo istante per ciascuno dei due marcatori. */
export function passBoundaries(
  entry: Pick<Entry, 'actionLog'>,
): { startedAt: number | null; endedAt: number | null } {
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  for (const item of entry.actionLog ?? []) {
    const t = parseTs(item?.timestamp);
    if (t === null) continue;
    const action = item?.action;
    if (START_ACTIONS.has(action) && (startedAt === null || t > startedAt)) startedAt = t;
    if (END_ACTIONS.has(action) && (endedAt === null || t > endedAt)) endedAt = t;
  }
  return { startedAt, endedAt };
}

/**
 * C'e' gia' una passata viva su questa entry?
 *
 * Serve perche' la route non ha nessuna mutua esclusione: due analisi sullo
 * stesso entry si sovrascrivono a vicenda e vince l'ultima che scrive, non la
 * migliore. E' successo davvero il 2026-09-12 su un link Reddit: due retry
 * partiti nello stesso minuto, una passata ha estratto il post via RSS,
 * l'altra si e' vista rifiutare l'`.rss` (429) ed e' ripiegata sull'HTML,
 * scrivendo caption "Reddit" e summary "..." sopra il lavoro buono.
 *
 * Le corsie della coda serializzano i job, ma una chiamata diretta dal
 * frontend le scavalca — quindi il controllo sta nella route, dove passano
 * tutte.
 *
 * Viva significa tre cose insieme: un marcatore di inizio esiste, nessuna
 * chiusura e' arrivata dopo di esso, e non e' passato troppo tempo dall'ultimo
 * segno di vita. Togliendo la prima condizione si blocca ogni stub del bot;
 * togliendo la terza, un container morto a meta' lascia la riga bloccata per
 * sempre.
 */
export function isAnalysisInFlight(
  entry: Pick<Entry, 'status' | 'actionLog'>,
  now: number = Date.now(),
): boolean {
  if (entry.status !== 'processing') return false;
  const { startedAt, endedAt } = passBoundaries(entry);
  if (startedAt === null) return false;
  if (endedAt !== null && endedAt >= startedAt) return false;
  return now - startedAt < STALE_PROCESSING_MS;
}
