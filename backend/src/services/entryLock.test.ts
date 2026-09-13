import { describe, it, expect } from 'vitest';
import { isAnalysisInFlight, passBoundaries, STALE_PROCESSING_MS } from './entryLock';
import type { Entry } from '../types';

const T0 = Date.parse('2026-09-13T19:00:00.000Z');

function log(atMs: number, action: string) {
  return { action, details: {}, timestamp: new Date(atMs).toISOString() };
}

function entry(actionLog: unknown[], status: Entry['status'] = 'processing') {
  return { status, actionLog } as Pick<Entry, 'status' | 'actionLog'>;
}

describe('passBoundaries', () => {
  it('takes the latest of each marker', () => {
    const e = entry([
      log(T0, 'analysis_started'),
      log(T0 + 60_000, 'completed'),
      log(T0 + 120_000, 'analysis_started'),
    ]);
    expect(passBoundaries(e)).toEqual({ startedAt: T0 + 120_000, endedAt: T0 + 60_000 });
  });

  it('ignores unparseable timestamps', () => {
    const e = entry([{ action: 'analysis_started', details: {}, timestamp: 'boh' }]);
    expect(passBoundaries(e)).toEqual({ startedAt: null, endedAt: null });
  });
});

describe('isAnalysisInFlight', () => {
  /**
   * La regressione del 2026-09-13, in produzione per un'ora: il webhook
   * Telegram crea uno stub gia' in `processing` con il solo `url_received`,
   * poi accoda il job. Leggere quello stato come "passata viva" faceva
   * rifiutare con 409 proprio la passata che doveva riempire lo stub, i
   * tentativi si esaurivano e ogni post mandato al bot restava vuoto.
   */
  it('uno stub appena creato dal bot non è una passata viva', () => {
    const e = entry([log(T0, 'url_received')]);
    expect(isAnalysisInFlight(e, T0 + 1_000)).toBe(false);
  });

  it('nemmeno uno stub rimasto lì da un po', () => {
    const e = entry([log(T0, 'url_received')]);
    expect(isAnalysisInFlight(e, T0 + 60 * 60_000)).toBe(false);
  });

  it('una passata che ha appena cominciato è viva', () => {
    const e = entry([log(T0, 'url_received'), log(T0 + 500, 'analysis_started')]);
    expect(isAnalysisInFlight(e, T0 + 30_000)).toBe(true);
  });

  it('anche una seconda passata (reanalyze) conta come viva', () => {
    const e = entry([log(T0, 'reanalyze_started')]);
    expect(isAnalysisInFlight(e, T0 + 30_000)).toBe(true);
  });

  // Chiusa e basta: senza questo, un'entry che finisce in errore resterebbe
  // rifiutata per un quarto d'ora invece di poter essere riprovata subito.
  it('una passata chiusa non è più viva', () => {
    const e = entry([log(T0, 'analysis_started'), log(T0 + 10_000, 'completed')]);
    expect(isAnalysisInFlight(e, T0 + 20_000)).toBe(false);
  });

  it('ma una nuova passata dopo la chiusura torna viva', () => {
    const e = entry([
      log(T0, 'analysis_started'),
      log(T0 + 10_000, 'completed'),
      log(T0 + 20_000, 'analysis_started'),
    ]);
    expect(isAnalysisInFlight(e, T0 + 25_000)).toBe(true);
  });

  // L'altra metà: un container morto a metà passata lascia la riga in
  // `processing` per sempre, e rifiutare all'infinito la incastrerebbe.
  it('una passata muta oltre la soglia è considerata morta', () => {
    const e = entry([log(T0, 'analysis_started')]);
    expect(isAnalysisInFlight(e, T0 + STALE_PROCESSING_MS + 1)).toBe(false);
  });

  it('completed o error non sono mai in lavorazione', () => {
    const e = [log(T0, 'analysis_started')];
    expect(isAnalysisInFlight(entry(e, 'completed'), T0 + 1_000)).toBe(false);
    expect(isAnalysisInFlight(entry(e, 'error'), T0 + 1_000)).toBe(false);
  });
});
