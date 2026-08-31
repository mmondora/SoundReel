/**
 * Where an entry's spoken text should come from.
 *
 * Two sources can produce it. A written track that YouTube already carries is
 * instant, costs nothing, and — the reason that matters on this host — never
 * touches the GPU, which hangs under ROCm and takes the whole Ollama pool down
 * with it for the requests that follow. Whisper stays the fallback for
 * everything with no track of its own, which is most of what this app sees.
 *
 * The choice lives here, as one pure function, rather than inline in the
 * analyze route: the route is too tangled to exercise end to end, so logic
 * buried in it can only be pinned by asserting on its source text — a test
 * that passes whether or not the behaviour is right.
 */

export type TranscriptSource =
  | { kind: 'subtitles'; text: string; lang: string | null; subtitleKind: 'manual' | 'auto' }
  | { kind: 'whisper'; audioPath: string }
  | { kind: 'none'; reason: string };

export interface TranscriptSourceInput {
  subtitleText?: string | null;
  subtitleLang?: string | null;
  subtitleKind?: string | null;
  audioPath?: string | null;
  transcriptionEnabled: boolean;
  reanalyze: boolean;
}

export function chooseTranscriptSource(input: TranscriptSourceInput): TranscriptSource {
  // A second pass exists *because* a transcript landed. Letting it choose a
  // source again would queue another transcribe, which would queue another
  // second pass, forever.
  if (input.reanalyze) {
    return { kind: 'none', reason: 'second pass: transcript already in hand' };
  }

  // The switch means "I do not want transcripts", not "I do not want whisper
  // specifically" — so it silences the subtitle path too.
  if (!input.transcriptionEnabled) {
    return { kind: 'none', reason: 'disabled in settings' };
  }

  const text = input.subtitleText?.trim();
  if (text) {
    return {
      kind: 'subtitles',
      text,
      lang: input.subtitleLang || null,
      // Only two values mean anything downstream, and "manual" is the claim
      // worth being sure about: it is the one that says a person wrote this.
      // Anything else crossing the service boundary reads as machine output.
      subtitleKind: input.subtitleKind === 'manual' ? 'manual' : 'auto',
    };
  }

  if (input.audioPath) {
    return { kind: 'whisper', audioPath: input.audioPath };
  }

  return { kind: 'none', reason: 'no audio path' };
}
