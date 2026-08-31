import { describe, it, expect } from 'vitest';
import { chooseTranscriptSource } from './transcriptSource';

const base = {
  transcriptionEnabled: true,
  reanalyze: false,
  subtitleText: null,
  subtitleLang: null,
  subtitleKind: null,
  audioPath: null,
};

describe('chooseTranscriptSource', () => {
  it('prefers subtitles over whisper when both are available', () => {
    // The whole point of the feature: an existing written track is instant,
    // free, and does not touch the GPU that hangs on this host.
    const s = chooseTranscriptSource({
      ...base,
      subtitleText: 'gia scritto',
      subtitleLang: 'it',
      subtitleKind: 'auto',
      audioPath: '/data/media/x/audio.wav',
    });
    expect(s).toEqual({
      kind: 'subtitles',
      text: 'gia scritto',
      lang: 'it',
      subtitleKind: 'auto',
    });
  });

  it('falls back to whisper when there are no subtitles', () => {
    const s = chooseTranscriptSource({ ...base, audioPath: '/data/media/x/audio.wav' });
    expect(s).toEqual({ kind: 'whisper', audioPath: '/data/media/x/audio.wav' });
  });

  it('treats blank subtitle text as absent', () => {
    // A track that downloaded but parsed to nothing must not shadow whisper:
    // it would leave the entry with no transcript at all and no job queued.
    const s = chooseTranscriptSource({
      ...base,
      subtitleText: '   ',
      audioPath: '/data/media/x/audio.wav',
    });
    expect(s).toEqual({ kind: 'whisper', audioPath: '/data/media/x/audio.wav' });
  });

  it('reports no audio path when there is neither', () => {
    const s = chooseTranscriptSource({ ...base });
    expect(s).toEqual({ kind: 'none', reason: 'no audio path' });
  });

  it('respects the settings switch even when subtitles exist', () => {
    // The switch means "I do not want transcripts", not "I do not want
    // whisper specifically".
    const s = chooseTranscriptSource({
      ...base,
      transcriptionEnabled: false,
      subtitleText: 'gia scritto',
      audioPath: '/data/media/x/audio.wav',
    });
    expect(s).toEqual({ kind: 'none', reason: 'disabled in settings' });
  });

  it('does nothing on a second pass', () => {
    // Without this the second pass would queue another transcribe, which
    // would queue another second pass, forever.
    const s = chooseTranscriptSource({
      ...base,
      reanalyze: true,
      subtitleText: 'gia scritto',
      audioPath: '/data/media/x/audio.wav',
    });
    expect(s).toEqual({ kind: 'none', reason: 'second pass: transcript already in hand' });
  });

  it('keeps a null language rather than inventing one', () => {
    const s = chooseTranscriptSource({ ...base, subtitleText: 'testo', subtitleKind: 'manual' });
    expect(s).toEqual({ kind: 'subtitles', text: 'testo', lang: null, subtitleKind: 'manual' });
  });

  it('normalises an unexpected subtitle kind to auto', () => {
    // The value crosses a service boundary; only two values are meaningful,
    // and "manual" is the claim worth being sure about.
    const s = chooseTranscriptSource({
      ...base,
      subtitleText: 'testo',
      subtitleKind: 'qualcosaltro',
    });
    expect(s).toMatchObject({ kind: 'subtitles', subtitleKind: 'auto' });
  });

  it('trims the subtitle text it hands back', () => {
    const s = chooseTranscriptSource({ ...base, subtitleText: '  testo  ' });
    expect(s).toMatchObject({ kind: 'subtitles', text: 'testo' });
  });
});
