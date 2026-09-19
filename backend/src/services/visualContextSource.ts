import { condensaContestoVisivo } from './ollamaClient';

export interface VisualContextInput {
  /** Il contesto visivo che una passata precedente ha lasciato sull'entry. */
  stored: string | null;
  /** I fotogrammi estratti dal video, come stanno su disco. */
  framePaths: string[];
  /** La passata è solo download: l'analisi AI arriva dopo, in blocco. */
  skipAi: boolean;
  /** L'analisi dei media è accesa nelle impostazioni. */
  mediaAnalysisEnabled: boolean;
}

export type VisualContextSource =
  /** C'è già, e va riusato invece di rifare la vision. */
  | { kind: 'reused'; text: string }
  /** Non c'è: si chiede a moondream, su questi fotogrammi. */
  | { kind: 'compute' }
  /** Non si fa, e questo è il motivo da scrivere nel journal. */
  | { kind: 'skipped'; reason: string };

/**
 * Da dove arriva il contesto visivo di questa passata.
 *
 * Estratta dalla route perché è la decisione che ci è costata due giri a
 * vuoto il 19 settembre, e dentro un handler da millecinquecento righe si
 * poteva solo verificare leggendo il sorgente.
 *
 * Il riuso è la strada giusta — rifare la vision su media che non sono
 * cambiati è lavoro buttato — ma porta con sé un vincolo che è facile
 * dimenticare: il testo salvato può venire da prima che imparassimo a
 * condensarlo. Le entry analizzate fino a oggi contengono 2300 battute di
 * ripetizioni, cinque descrizioni della stessa inquadratura, e riusarle così
 * com'erano significava trascinarsele dentro ogni analisi futura, a diluire
 * caption e trascrizione. Per questo il riuso passa dalla condensazione: le
 * entry vecchie si sistemano da sole al primo passaggio, senza migrazione.
 */
export function chooseVisualContext(input: VisualContextInput): VisualContextSource {
  const condensato = condensaContestoVisivo(input.stored);
  if (condensato) return { kind: 'reused', text: condensato };

  if (input.skipAi) {
    return { kind: 'skipped', reason: 'deferred to the batched AI pass' };
  }
  if (!input.mediaAnalysisEnabled) {
    return { kind: 'skipped', reason: 'disabled in settings' };
  }
  if (!input.framePaths.length) {
    // Detto per nome: su un carosello è la risposta corretta, non un guasto.
    // Le slide hanno il loro percorso di analisi, una per volta.
    return { kind: 'skipped', reason: 'no frames' };
  }
  return { kind: 'compute' };
}
