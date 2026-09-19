import { describe, it, expect } from 'vitest';
import { repairJsonEscapes, sanitizeForPrompt } from './aiAnalysis';

/**
 * Il 19 settembre un'analisi corretta di qwen — note giuste, persona giusta,
 * link giusto — è stata buttata e rifatta da Claude a pagamento, per una barra
 * rovesciata che l'OCR aveva letto in un fotogramma e che il modello aveva
 * ricopiato fedelmente nel proprio JSON. Cinque tentativi su cinque, sempre
 * allo stesso punto: `"visualContext": "wif We % \ N..."`.
 */
describe('repairJsonEscapes', () => {
  it('ripara il caso reale: barra isolata dentro una stringa', () => {
    const rotto = '{"visualContext": "wif We % \\ N"}';
    expect(() => JSON.parse(rotto)).toThrow();
    const parsed = JSON.parse(repairJsonEscapes(rotto));
    expect(parsed.visualContext).toBe('wif We % \\ N');
  });

  it('lascia intatti gli escape validi', () => {
    const buono = '{"a": "riga\\nnuova", "b": "virgolette \\" dentro", "c": "barra \\\\ vera", "d": "tab\\there"}';
    expect(repairJsonEscapes(buono)).toBe(buono);
    expect(JSON.parse(repairJsonEscapes(buono)).a).toBe('riga\nnuova');
  });

  it('lascia intatto uno unicode ben formato', () => {
    const buono = '{"a": "\\u00e8 accentata"}';
    expect(repairJsonEscapes(buono)).toBe(buono);
    expect(JSON.parse(repairJsonEscapes(buono)).a).toBe('è accentata');
  });

  // Uno `\u` senza quattro cifre esadecimali è rotto quanto una barra isolata.
  //
  // Nota su cosa NON ripara: in `\documenti` la `\d` non è un escape valido e
  // viene raddoppiata, mentre in `\test` la `\t` lo è e diventa davvero un tab.
  // È JSON che funziona così, non una svista: il riparatore tocca solo ciò che
  // è illegale, e indovinare l'intenzione del modello sarebbe inventare.
  it('ripara uno unicode monco', () => {
    const rotto = '{"a": "C:\\users\\documenti"}';
    expect(() => JSON.parse(rotto)).toThrow();
    expect(JSON.parse(repairJsonEscapes(rotto)).a).toBe('C:\\users\\documenti');
  });

  it('regge una barra in fondo al documento', () => {
    expect(() => repairJsonEscapes('{"a": "finisce con \\')).not.toThrow();
  });

  it('non tocca un documento già valido', () => {
    const buono = JSON.stringify({ songs: [], notes: [{ text: 'Deepak Chopra', category: 'person' }] });
    expect(repairJsonEscapes(buono)).toBe(buono);
  });
});

describe('sanitizeForPrompt', () => {
  // Meglio togliere il rumore prima che il modello lo ricopi: la riparazione
  // è la rete di sicurezza, non la cura.
  it("toglie le barre rovesciate che l'OCR inventa", () => {
    expect(sanitizeForPrompt('wif We % \\ N')).toBe('wif We % N');
  });

  it('toglie i caratteri di controllo', () => {
    expect(sanitizeForPrompt('testo\u0007con\u001frumore')).toBe('testoconrumore');
  });

  it('lascia intatto il testo leggibile, accenti e emoji compresi', () => {
    const vero = "L'IMPERMANENZA — Deepak Chopra 👉 www.deepakchopra.it";
    expect(sanitizeForPrompt(vero)).toBe(vero);
  });

  it("conserva gli a capo, che separano le righe dell'OCR", () => {
    expect(sanitizeForPrompt('riga uno\nriga due')).toBe('riga uno\nriga due');
  });

  it('un testo fatto di solo rumore diventa niente', () => {
    expect(sanitizeForPrompt('\\    ')).toBeNull();
  });

  it('null resta null', () => {
    expect(sanitizeForPrompt(null)).toBeNull();
  });
});
