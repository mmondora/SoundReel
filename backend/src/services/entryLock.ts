import type { Entry } from '../types';

/**
 * Quanto a lungo un'entry ferma in `processing` viene creduta viva.
 *
 * Non e' il timeout della pipeline (120s): una passata con Whisper, OCR e
 * vision puo' durare molto di piu', e interromperla sarebbe peggio del
 * problema. E' la soglia oltre la quale si assume che il processo sia morto
 * senza chiudere la riga — un riavvio del container, un OOM — e quindi
 * riprovare e' giusto.
 */
export const STALE_PROCESSING_MS = 15 * 60 * 1000;

/**
 * L'istante dell'ultimo passo scritto, o la creazione se non c'e' nulla.
 *
 * `entries` non ha `updated_at`, ma ogni passo della pipeline appende
 * all'actionLog con il proprio timestamp: e' gia' l'orologio che serve, senza
 * migrazione ne' trigger.
 */
export function lastActivityAt(entry: Pick<Entry, 'actionLog' | 'createdAt'>): number {
  let latest = Date.parse(entry.createdAt);
  if (Number.isNaN(latest)) latest = 0;
  for (const item of entry.actionLog ?? []) {
    const t = Date.parse(item?.timestamp ?? '');
    if (!Number.isNaN(t) && t > latest) latest = t;
  }
  return latest;
}

/**
 * C'e' gia' una passata viva su questa entry?
 *
 * Serve perche' la route non ha nessuna mutua esclusione: due analisi sullo
 * stesso entry si sovrascrivono a vicenda e vince l'ultima che scrive, non la
 * migliore. E' successo davvero il 2026-09-12 su un link Reddit: due retry
 * partiti nello stesso minuto, una passata ha estratto il post via RSS,
 * l'altra si e' vista rifiutare l'`.rss` (due richieste identiche insieme,
 * 429) ed e' ripiegata sull'HTML, scrivendo caption "Reddit" e summary "..."
 * sopra il lavoro buono.
 *
 * Le corsie della coda serializzano i job, ma una chiamata diretta dal
 * frontend le scavalca — quindi il controllo sta qui, dove passano tutte.
 */
export function isAnalysisInFlight(
  entry: Pick<Entry, 'status' | 'actionLog' | 'createdAt'>,
  now: number = Date.now(),
): boolean {
  if (entry.status !== 'processing') return false;
  return now - lastActivityAt(entry) < STALE_PROCESSING_MS;
}
