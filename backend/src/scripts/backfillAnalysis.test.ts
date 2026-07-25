import { describe, it, expect, vi } from 'vitest';

// The module opens a DB pool and reads argv at import time; neither is needed
// to exercise the pure merge helper.
vi.mock('../utils/db', () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  updateEntry: vi.fn(),
  appendActionLog: vi.fn(),
  createActionLog: vi.fn(),
}));
vi.mock('../services/aiAnalysis', () => ({
  buildAnalysisPrompt: vi.fn(), parseAnalysisResponse: vi.fn(), isEmptyAnalysis: vi.fn(),
}));
vi.mock('../services/claudeFallback', () => ({ runClaudePrompt: vi.fn() }));
vi.mock('../services/filmSearch', () => ({
  searchFilm: vi.fn(), generateImdbUrl: vi.fn(), generateStreamingUrls: vi.fn(),
}));
vi.mock('../services/spotify', () => ({
  searchTrack: vi.fn(), generateYoutubeSearchUrl: vi.fn(), generateSoundcloudSearchUrl: vi.fn(),
}));

import { mergeAdditive } from './backfillAnalysis';
import type { EntryResults, Song, Film } from '../types';

function song(partial: Partial<Song>): Song {
  return {
    title: 'T', artist: 'A', album: null, source: 'ai_analysis',
    spotifyUri: null, spotifyUrl: null, youtubeUrl: null,
    soundcloudUrl: null, addedToPlaylist: false, ...partial,
  };
}

function film(partial: Partial<Film>): Film {
  return {
    title: 'F', director: null, year: null, imdbUrl: null,
    posterUrl: null, streamingUrls: null, ...partial,
  };
}

function results(partial: Partial<EntryResults>): EntryResults {
  return {
    songs: [], films: [], notes: [], links: [], tags: [], summary: null, ...partial,
  };
}

const NOTHING = { songs: [], films: [], notes: [], tags: [], links: [], summary: null };

describe('mergeAdditive', () => {
  // The governing rule: a repair pass re-reads text and knows nothing about
  // what the original run learned from audio, media or a manual edit.
  it('never drops an existing song, even when the re-analysis found none', () => {
    const existing = results({ songs: [song({ title: 'Background', source: 'audio_fingerprint' })] });
    const merged = mergeAdditive(existing, NOTHING);
    expect(merged.songs).toHaveLength(1);
    expect(merged.songs[0].title).toBe('Background');
  });

  it('never drops existing films, notes, tags or links', () => {
    const existing = results({
      films: [film({ title: 'Old Film' })],
      notes: [{ text: 'old note', category: 'other' }],
      tags: ['#old'],
      links: [{ url: 'https://old.example.com', label: null }],
    });
    const merged = mergeAdditive(existing, NOTHING);
    expect(merged.films).toHaveLength(1);
    expect(merged.notes).toHaveLength(1);
    expect(merged.tags).toEqual(['#old']);
    expect(merged.links).toHaveLength(1);
  });

  it('never overwrites an existing summary', () => {
    const existing = results({ summary: 'original summary' });
    const merged = mergeAdditive(existing, { ...NOTHING, summary: 'new summary' });
    expect(merged.summary).toBe('original summary');
  });

  it('fills a missing summary', () => {
    const merged = mergeAdditive(results({}), { ...NOTHING, summary: 'new summary' });
    expect(merged.summary).toBe('new summary');
  });

  it('appends new items alongside existing ones', () => {
    const existing = results({ songs: [song({ title: 'Kept', artist: 'X' })] });
    const merged = mergeAdditive(existing, { ...NOTHING, songs: [song({ title: 'Added', artist: 'Y' })] });
    expect(merged.songs.map((s) => s.title)).toEqual(['Kept', 'Added']);
  });

  it('does not duplicate an item that is already stored', () => {
    const existing = results({ songs: [song({ title: 'Same', artist: 'Same' })] });
    const merged = mergeAdditive(existing, {
      ...NOTHING,
      songs: [song({ title: 'SAME', artist: 'same' })],
    });
    expect(merged.songs).toHaveLength(1);
  });

  it('dedupes notes, tags and links case-insensitively where appropriate', () => {
    const existing = results({
      notes: [{ text: 'Same Note', category: 'other' }],
      tags: ['#Tag'],
      links: [{ url: 'https://a.example.com', label: null }],
    });
    const merged = mergeAdditive(existing, {
      ...NOTHING,
      notes: [{ text: 'same note', category: 'other' }],
      tags: ['#tag'],
      links: [{ url: 'https://a.example.com', label: 'dup' }],
    });
    expect(merged.notes).toHaveLength(1);
    expect(merged.tags).toHaveLength(1);
    expect(merged.links).toHaveLength(1);
  });

  it('preserves fields it does not manage, like transcript and OCR text', () => {
    const existing = results({ transcript: 'spoken words', overlayText: 'on-screen text' });
    const merged = mergeAdditive(existing, NOTHING);
    expect(merged.transcript).toBe('spoken words');
    expect(merged.overlayText).toBe('on-screen text');
  });

  it('tolerates a stored result missing array fields entirely', () => {
    const legacy = { summary: null } as unknown as EntryResults;
    const merged = mergeAdditive(legacy, { ...NOTHING, songs: [song({ title: 'New' })] });
    expect(merged.songs).toHaveLength(1);
    expect(merged.films).toEqual([]);
  });
});
