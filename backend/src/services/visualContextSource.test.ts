import { describe, it, expect } from 'vitest';
import { chooseVisualContext } from './visualContextSource';

/**
 * Questa decisione è costata due giri a vuoto il 19 settembre.
 *
 * Il primo: il prompt lungo zittiva moondream, e nel journal si leggeva solo
 * `vision_describe: skipped` — che sembrava «non c'erano fotogrammi».
 *
 * Il secondo: sistemato il prompt e condensate le descrizioni, il contesto
 * restava di 2312 caratteri. Perché una seconda passata non ricalcola, riusa —
 * e il riuso non passava dalla condensazione. Se ne è accorta la prova sul
 * campo, non la suite: dentro la route quella riga si poteva solo leggere.
 */
const BASE = {
  stored: null,
  framePaths: [] as string[],
  skipAi: false,
  mediaAnalysisEnabled: true,
};

const SCENA = 'The image features a woman with long brown hair, wearing a white shirt. She is standing in front of a window.';

describe('chooseVisualContext', () => {
  describe('quando c’è già un contesto salvato', () => {
    it('lo riusa invece di rifare la vision', () => {
      const out = chooseVisualContext({ ...BASE, stored: SCENA, framePaths: ['a.jpg'] });
      expect(out).toEqual({ kind: 'reused', text: SCENA });
    });

    // Il difetto vero: le entry analizzate prima di oggi portano cinque
    // descrizioni della stessa inquadratura, e riusarle intatte significa
    // trascinarle dentro ogni analisi futura.
    it('lo condensa prima di riusarlo', () => {
      const vecchio = Array(5).fill(SCENA).join(' ');
      const out = chooseVisualContext({ ...BASE, stored: vecchio });

      expect(out.kind).toBe('reused');
      expect(out.kind === 'reused' && out.text).toBe(SCENA);
      expect(out.kind === 'reused' && out.text.length).toBeLessThan(vecchio.length);
    });

    // Il riuso vince anche quando la passata avrebbe i fotogrammi per
    // ricalcolare: rifare la vision su media immutati è lavoro buttato.
    it('vince sui fotogrammi disponibili', () => {
      const out = chooseVisualContext({ ...BASE, stored: SCENA, framePaths: ['a.jpg', 'b.jpg'] });
      expect(out.kind).toBe('reused');
    });

    // Un contesto salvato vuoto o fatto di spazi non è un contesto.
    it('un salvataggio vuoto non conta come riuso', () => {
      expect(chooseVisualContext({ ...BASE, stored: '   ', framePaths: ['a.jpg'] }).kind).toBe('compute');
      expect(chooseVisualContext({ ...BASE, stored: '', framePaths: ['a.jpg'] }).kind).toBe('compute');
    });
  });

  describe('quando non c’è niente da riusare', () => {
    it('calcola se ci sono fotogrammi', () => {
      expect(chooseVisualContext({ ...BASE, framePaths: ['a.jpg'] })).toEqual({ kind: 'compute' });
    });

    // Su un carosello è la risposta corretta, non un guasto: le slide hanno il
    // loro percorso di analisi, una per volta.
    it('senza fotogrammi lo dice per nome', () => {
      expect(chooseVisualContext(BASE)).toEqual({ kind: 'skipped', reason: 'no frames' });
    });

    it('una passata di solo download non chiama ollama', () => {
      const out = chooseVisualContext({ ...BASE, framePaths: ['a.jpg'], skipAi: true });
      expect(out).toEqual({ kind: 'skipped', reason: 'deferred to the batched AI pass' });
    });

    it('rispetta l’interruttore nelle impostazioni', () => {
      const out = chooseVisualContext({ ...BASE, framePaths: ['a.jpg'], mediaAnalysisEnabled: false });
      expect(out).toEqual({ kind: 'skipped', reason: 'disabled in settings' });
    });

    // L'ordine dei motivi conta: una passata di solo download è tale anche a
    // interruttore spento, e il journal deve dire quello vero.
    it('una passata di solo download lo dice anche a analisi disattivata', () => {
      const out = chooseVisualContext({
        ...BASE, framePaths: ['a.jpg'], skipAi: true, mediaAnalysisEnabled: false,
      });
      expect(out).toEqual({ kind: 'skipped', reason: 'deferred to the batched AI pass' });
    });
  });

  // Il riuso precede ogni motivo di rinuncia: un contesto che c'è va usato
  // anche in una passata di solo download, dove costa zero.
  it('riusa anche durante una passata di solo download', () => {
    const out = chooseVisualContext({ ...BASE, stored: SCENA, skipAi: true });
    expect(out.kind).toBe('reused');
  });
});
