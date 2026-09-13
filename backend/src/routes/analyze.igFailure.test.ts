import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Structural test, same spirit as analyze.reanalyze.test.ts: the analyze route
 * is too tangled to exercise end to end here, but the one property that broke
 * the whole Instagram retry story is pinnable at the source level.
 *
 * The bug: a failed Instagram download replied HTTP 200 with
 * `success: false`. The queue worker decides "retry or done" from the HTTP
 * status, so every expired session produced a *completed* job — one warning
 * message to Telegram, then permanent silence, no retry even after the session
 * was re-seeded hours later.
 */
describe('analyze route: failed Instagram download', () => {
  const source = readFileSync(path.join(__dirname, 'analyze.ts'), 'utf8');

  /** Comments dropped: prose about a guard must not pass for the guard. */
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('answers with a non-2xx so the queue worker treats it as a failure', () => {
    const at = code.indexOf("error: dlError });");
    expect(at).toBeGreaterThan(-1);
    const statement = code.slice(code.lastIndexOf('reply', at), at);
    expect(statement).toMatch(/reply\.code\(5\d\d\)/);
  });

  it('still returns the error string, which is what picks the backoff', () => {
    // isAuthFailure() reads this field to tell an expired session (retried for
    // days) from an ordinary download failure (three attempts, eleven minutes).
    expect(code).toMatch(/reply\.code\(5\d\d\)\.send\(\{ success: false, entryId, entry: entryErr, error: dlError \}\)/);
  });
});

/**
 * Stessa proprietà, altro ramo. Il pipeline pagina rispondeva 200 con
 * `success: false`, quindi ogni fallimento chiudeva il job come riuscito e
 * l'entry restava in `error` senza nessuno che la riprendesse.
 */
describe('analyze route: pipeline pagina fallito', () => {
  const source = readFileSync(path.join(__dirname, 'analyze.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('risponde non-2xx così il worker riprova', () => {
    expect(code).toMatch(/reply\.code\(5\d\d\)\.send\(\{ success: false, entryId, entry: errEntry, error: 'page_pipeline_failed' \}\)/);
  });

  // Il guscio senza contenuto è diverso da un errore di rete, e la cura è
  // diversa: una sessione, non un altro tentativo. Va nel journal col suo nome.
  it('logga il guscio con il suo nome, non come fetch fallito', () => {
    expect(code).toContain('page_shell_detected');
    expect(code).toMatch(/e instanceof PageShellError/);
  });
});

/**
 * Due analisi concorrenti sulla stessa entry si sovrascrivevano e vinceva
 * l'ultima che scriveva. Le corsie della coda serializzano i job, ma una
 * chiamata diretta dal frontend le scavalca: il controllo deve stare nella
 * route, dove passano tutte.
 */
describe('analyze route: analisi concorrenti', () => {
  const source = readFileSync(path.join(__dirname, 'analyze.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('rifiuta una seconda passata su un entry già in lavorazione', () => {
    expect(code).toMatch(/if \(isAnalysisInFlight\(existingEntry\)\) \{/);
  });

  // 409 e non 200: il worker legge lo status HTTP per decidere se riprovare.
  it('risponde 409, così il job torna in coda invece di chiudersi', () => {
    const at = code.indexOf('isAnalysisInFlight(existingEntry)');
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at, at + 400)).toContain('reply.code(409)');
  });

  // Il controllo deve precedere la scorciatoia di idempotenza, altrimenti su
  // un entry `processing` si passa oltre e si riprocessa comunque.
  it('controlla prima di riusare l\'entry esistente', () => {
    expect(code.indexOf('isAnalysisInFlight(existingEntry)'))
      .toBeLessThan(code.indexOf("existingEntry.status === 'completed'"));
  });
});
