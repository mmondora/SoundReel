import { describe, it, expect } from 'vitest';
import { selectBackfillCandidates } from './backfillTranscripts';

describe('selectBackfillCandidates', () => {
  const hasAudio = (id: string) => id.startsWith('audio');

  it('selects entries with audio and no transcript', () => {
    const rows = [
      { id: 'audio-1', transcript: null, pendingTranscribe: false },
      { id: 'audio-2', transcript: '', pendingTranscribe: false },
    ];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual(['audio-1', 'audio-2']);
  });

  it('skips entries that already have a transcript', () => {
    const rows = [{ id: 'audio-3', transcript: 'già trascritto', pendingTranscribe: false }];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual([]);
  });

  it('skips entries with no audio on disk', () => {
    const rows = [{ id: 'noaudio-1', transcript: null, pendingTranscribe: false }];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual([]);
  });

  it('is idempotent: skips entries already queued', () => {
    const rows = [{ id: 'audio-4', transcript: null, pendingTranscribe: true }];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual([]);
  });

  it('bounds the wave when a limit is given', () => {
    const rows = [
      { id: 'audio-a', transcript: null, pendingTranscribe: false },
      { id: 'audio-b', transcript: null, pendingTranscribe: false },
      { id: 'audio-c', transcript: null, pendingTranscribe: false },
    ];
    expect(selectBackfillCandidates(rows, hasAudio, { limit: 2 })).toHaveLength(2);
  });

  it('puts the entries with the most to lose first', () => {
    const rows = [
      { id: 'audio-poor', transcript: null, pendingTranscribe: false, richness: 0 },
      { id: 'audio-rich', transcript: null, pendingTranscribe: false, richness: 9 },
    ];
    expect(selectBackfillCandidates(rows, hasAudio, { richestFirst: true, limit: 1 }))
      .toEqual(['audio-rich']);
  });

  it('keeps natural order when richestFirst is off', () => {
    const rows = [
      { id: 'audio-poor', transcript: null, pendingTranscribe: false, richness: 0 },
      { id: 'audio-rich', transcript: null, pendingTranscribe: false, richness: 9 },
    ];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual(['audio-poor', 'audio-rich']);
  });

  it('treats a whitespace-only transcript as missing', () => {
    const rows = [{ id: 'audio-5', transcript: '   \n\t', pendingTranscribe: false }];
    expect(selectBackfillCandidates(rows, hasAudio)).toEqual(['audio-5']);
  });

  it('bounds the wave to the richest entries, not the first N of the unsorted list', () => {
    const rows = [
      { id: 'audio-first', transcript: null, pendingTranscribe: false, richness: 1 },
      { id: 'audio-mid', transcript: null, pendingTranscribe: false, richness: 5 },
      { id: 'audio-richest', transcript: null, pendingTranscribe: false, richness: 9 },
    ];
    expect(selectBackfillCandidates(rows, hasAudio, { richestFirst: true, limit: 2 }))
      .toEqual(['audio-richest', 'audio-mid']);
  });
});
