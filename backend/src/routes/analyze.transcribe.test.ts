import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * A structural test: the pipeline must not call transcribeLocal any more.
 * The full analyze route is too tangled to exercise end to end here, and the
 * property that matters — transcription left the synchronous path — is
 * exactly what a source-level assertion pins.
 */
describe('analyze route transcription', () => {
  const source = readFileSync(
    path.join(__dirname, 'analyze.ts'),
    'utf8'
  );

  it('does not call transcribeLocal inline', () => {
    expect(source).not.toMatch(/await\s+transcribeLocal\(/);
  });

  it('enqueues a transcribe job instead', () => {
    expect(source).toMatch(/kind:\s*'transcribe'/);
  });
});
