import { describe, it, expect } from 'vitest';
import { condensaDescrizioni } from './ollamaClient';

/**
 * Misurato il 19 settembre, appena la vision ha ricominciato a funzionare: su
 * tre reel il contesto visivo usciva da 2312 e 2099 caratteri — cinque
 * descrizioni della stessa scena, una per fotogramma, concatenate.
 *
 * Non è un testo che qualcuno legge: finisce nel prompt di analisi, dove
 * duemila caratteri di ripetizioni diluiscono caption e trascrizione. Il terzo
 * reel, con 92 caratteri, mostra quanto dovrebbe bastare.
 */
describe('condensaDescrizioni', () => {
  const scena = 'The image features a woman with long brown hair, wearing a white shirt. She is standing in front of a window.';

  it('una descrizione sola passa intatta', () => {
    expect(condensaDescrizioni([scena])).toBe(scena);
  });

  it('toglie le copie identiche', () => {
    expect(condensaDescrizioni([scena, scena, scena])).toBe(scena);
  });

  // Il caso vero: fotogrammi consecutivi della stessa inquadratura. Moondream
  // apre sempre allo stesso modo e diverge solo in fondo.
  it('toglie anche le descrizioni che cambiano solo in coda', () => {
    const varianti = [
      'The image features a woman with long brown hair, wearing a white shirt. She is standing in front of a window.',
      'The image features a woman with long brown hair, wearing a white shirt. She appears to be talking to the camera.',
      'The image features a woman with long brown hair, wearing a white shirt. Her hand is raised.',
    ];
    expect(condensaDescrizioni(varianti)).toBe(varianti[0]);
  });

  // Scene diverse vanno tenute: è per questo che guardiamo più fotogrammi.
  it('tiene le scene davvero diverse', () => {
    const diverse = [
      'The image features a woman with long brown hair standing in front of a window.',
      'A close-up of a wooden board on a workbench, surrounded by tools.',
    ];
    const out = condensaDescrizioni(diverse);
    expect(out).toContain('woman with long brown hair');
    expect(out).toContain('wooden board');
  });

  it('non supera il tetto di lunghezza', () => {
    const tante = Array.from({ length: 12 }, (_, i) =>
      `Scene number ${i}: a completely different subject appears here, described at some length to fill space.`
    );
    expect(condensaDescrizioni(tante).length).toBeLessThanOrEqual(600);
  });

  // Un testo tagliato a metà parola nel prompt è rumore travestito da
  // contenuto: si taglia alla fine di una frase.
  it('taglia alla fine di una frase', () => {
    const tante = Array.from({ length: 12 }, (_, i) =>
      `Scene number ${i}: a completely different subject appears here, described at some length to fill space.`
    );
    const out = condensaDescrizioni(tante);
    expect(out.endsWith('.')).toBe(true);
    expect(out).not.toMatch(/\s\S{1,3}$/);
  });

  // Se non c'è nessun confine di frase utile, meglio dire che è troncato che
  // fingere che finisca lì.
  it('segnala il troncamento quando non trova una frase', () => {
    const senzaPunti = ['a'.repeat(900)];
    const out = condensaDescrizioni(senzaPunti);
    expect(out.length).toBeLessThanOrEqual(601);
    expect(out.endsWith('…')).toBe(true);
  });

  it('regge una lista vuota o fatta di spazi', () => {
    expect(condensaDescrizioni([])).toBe('');
    expect(condensaDescrizioni(['   ', ''])).toBe('');
  });
});
