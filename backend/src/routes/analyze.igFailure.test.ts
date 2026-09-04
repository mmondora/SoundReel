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
