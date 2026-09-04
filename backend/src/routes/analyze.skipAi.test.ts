import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Structural tests, same spirit as analyze.reanalyze.test.ts: the route is too
 * tangled to exercise end to end here, but "this pass makes no ollama call" is
 * a property a refactor could silently undo, and the cost of undoing it is a
 * hung GPU rather than a wrong result.
 *
 * Why the flag exists: a repair batch is spaced by tens of minutes so
 * Instagram does not challenge the account again, while ollama keeps a single
 * model resident for 90 seconds (MAX_LOADED_MODELS=1) and every analysis uses
 * two — moondream on the frames, then qwen on the text. Analysing inline is
 * therefore one GPU wake-up and two model swaps per job: the queue teardown
 * that hangs this Phoenix3 APU.
 */
describe('analyze route: download-only pass', () => {
  const source = readFileSync(path.join(__dirname, 'analyze.ts'), 'utf8');

  /** Comments dropped: prose about a guard must not pass for the guard. */
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  it('reads the flag off the request, never inferring it', () => {
    expect(code).toMatch(/const skipAi = req\.body\?\.skipAi === true;/);
  });

  it('turns the AI analysis off for that request', () => {
    expect(code).toMatch(/skipAi\s*\?\s*\{ \.\.\.storedFeatures, aiAnalysisEnabled: false \}/);
  });

  // The vision call has its own gate (mediaAnalysisEnabled), so switching off
  // aiAnalysisEnabled alone would still have sent every frame to moondream —
  // half the model swaps this exists to prevent.
  it('turns the vision pass off too', () => {
    const at = code.indexOf('describeFramesWithVision(keyFrames)');
    expect(at).toBeGreaterThan(-1);
    const guard = code.slice(code.lastIndexOf('} else if (', at), at);
    expect(guard).toContain('!skipAi');
  });

  // The deferred pass finds its work by reading this reason out of the
  // actionLog; a different string there leaves the entries unanalysed forever.
  it('records why the analysis is missing, in the words the second pass looks for', () => {
    expect(code).toContain("reason: skipAi ? 'deferred to the batched AI pass' : 'disabled in settings'");
    const script = readFileSync(path.join(__dirname, '..', 'scripts', 'requeueAiPass.ts'), 'utf8');
    expect(script).toContain("'deferred to the batched AI pass'");
  });

  // Subtractive only: OCR, Shazam and the transcription queue reach the OCR
  // sidecar, Shazam and Whisper — not ollama — and a download pass that
  // dropped them would have to re-download to get them back.
  it('leaves everything that is not ollama alone', () => {
    expect(code).not.toMatch(/skipAi[^\n]*transcriptionEnabled/);
    expect(code).not.toMatch(/skipAi\s*\?\s*\{[^}]*mediaAnalysisEnabled: false/);
  });
});
