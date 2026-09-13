import { describe, it, expect } from 'vitest';
import { isRedditShell } from './pageExtractor';

/**
 * Il guscio che Reddit serve a chi non è loggato: `og:title` = "Reddit",
 * description "...". Passava per estrazione riuscita, e quei due valori
 * finivano come caption e summary dell'entry — un risultato finto, che
 * nessun retry avrebbe mai ripreso perché l'entry risultava `completed`.
 */
describe('isRedditShell', () => {
  it('riconosce il guscio reale visto in produzione', () => {
    expect(isRedditShell('Reddit', '...')).toBe(true);
  });

  it('riconosce il guscio senza description', () => {
    expect(isRedditShell('Reddit', null)).toBe(true);
    expect(isRedditShell('Reddit', '')).toBe(true);
  });

  it('non è sensibile al maiuscolo né agli spazi', () => {
    expect(isRedditShell('  reddit  ', '…'.repeat(0) || '...')).toBe(true);
  });

  // Il post vero porta sempre il proprio titolo: è questo che separa i due
  // casi, non la lunghezza del testo — l'interstiziale ne ha quasi 3000
  // caratteri, più di molti post veri.
  it('lascia passare un post vero', () => {
    expect(isRedditShell('Part 2 of our blowjob guide. Do you like to be sucked like this too?', '...')).toBe(false);
    expect(isRedditShell('Anyone else hitting this bug?', 'r/FireIT')).toBe(false);
  });

  // Una pagina che si chiama "Reddit" ma ha una description vera ha comunque
  // qualcosa da analizzare: bocciarla sarebbe peggio del guscio.
  it('lascia passare un titolo generico con contenuto vero', () => {
    expect(isRedditShell('Reddit', 'Il thread di oggi su r/vibecoding')).toBe(false);
  });

  it('non scambia per guscio un titolo che contiene "reddit"', () => {
    expect(isRedditShell('Reddit is down again', '...')).toBe(false);
    expect(isRedditShell('Best of Reddit', '')).toBe(false);
  });
});
