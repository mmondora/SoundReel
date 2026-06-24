import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { mergeResults, createEmptySong, createEmptyFilm } from './resultMerger';
import type { AudioRecognitionResult, AiAnalysisResult } from '../types';

function makeAiResult(overrides: Partial<AiAnalysisResult> = {}): AiAnalysisResult {
  return {
    songs: [],
    films: [],
    notes: [],
    links: [],
    tags: [],
    summary: null,
    ...overrides,
  };
}

describe('mergeResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('song from audioResult only → source audio_fingerprint', () => {
    const audio: AudioRecognitionResult = { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours' };
    const result = mergeResults(audio, makeAiResult());
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0]).toMatchObject({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      album: 'After Hours',
      source: 'audio_fingerprint',
    });
  });

  it('song from AI only → source ai_analysis', () => {
    const result = mergeResults(null, makeAiResult({
      songs: [{ title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia' }],
    }));
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0]).toMatchObject({
      title: 'Levitating',
      artist: 'Dua Lipa',
      source: 'ai_analysis',
    });
  });

  it('same song in both (case-insensitive) → source both', () => {
    const audio: AudioRecognitionResult = { title: 'Shape of You', artist: 'Ed Sheeran', album: null };
    const result = mergeResults(audio, makeAiResult({
      songs: [{ title: 'shape of you', artist: 'ED SHEERAN', album: null }],
    }));
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0].source).toBe('both');
  });

  it('same song in both, audioResult has no album, AI has album → album promoted from AI', () => {
    const audio: AudioRecognitionResult = { title: 'Song', artist: 'Artist', album: null };
    const result = mergeResults(audio, makeAiResult({
      songs: [{ title: 'Song', artist: 'Artist', album: 'Album Name' }],
    }));
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0].source).toBe('both');
    expect(result.songs[0].album).toBe('Album Name');
  });

  it('same song in both, audioResult has album, AI has no album → audioResult album kept', () => {
    const audio: AudioRecognitionResult = { title: 'Song', artist: 'Artist', album: 'Original Album' };
    const result = mergeResults(audio, makeAiResult({
      songs: [{ title: 'Song', artist: 'Artist', album: null }],
    }));
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0].source).toBe('both');
    expect(result.songs[0].album).toBe('Original Album');
  });

  it('AI song with empty title → skipped', () => {
    const result = mergeResults(null, makeAiResult({
      songs: [{ title: '', artist: 'Some Artist', album: null }],
    }));
    expect(result.songs).toHaveLength(0);
  });

  it('AI song with empty artist → skipped', () => {
    const result = mergeResults(null, makeAiResult({
      songs: [{ title: 'Some Title', artist: '', album: null }],
    }));
    expect(result.songs).toHaveLength(0);
  });

  it('film dedup: two identical films (case-insensitive) → appears once', () => {
    const result = mergeResults(null, makeAiResult({
      films: [
        { title: 'Inception', director: 'Nolan', year: '2010' },
        { title: 'INCEPTION', director: 'Christopher Nolan', year: '2010' },
      ],
    }));
    expect(result.films).toHaveLength(1);
    expect(result.films[0].title).toBe('Inception');
  });

  it('film with empty title → skipped', () => {
    const result = mergeResults(null, makeAiResult({
      films: [{ title: '', director: null, year: null }],
    }));
    expect(result.films).toHaveLength(0);
  });

  it('null audioResult → no songs from audio, only AI songs', () => {
    const result = mergeResults(null, makeAiResult({
      songs: [{ title: 'AI Song', artist: 'AI Artist', album: null }],
    }));
    expect(result.songs).toHaveLength(1);
    expect(result.songs[0].source).toBe('ai_analysis');
  });

  it('passes notes, links, tags, summary through from aiResult', () => {
    const aiResult = makeAiResult({
      notes: [{ text: 'A note', category: 'place' }],
      links: [{ url: 'https://example.com', label: 'Example' }],
      tags: ['music', 'reel'],
      summary: 'A cool video',
    });
    const result = mergeResults(null, aiResult);
    expect(result.notes).toEqual(aiResult.notes);
    expect(result.links).toEqual(aiResult.links);
    expect(result.tags).toEqual(aiResult.tags);
    expect(result.summary).toBe('A cool video');
  });
});

describe('createEmptySong', () => {
  it('returns object with all required fields and correct defaults', () => {
    const song = createEmptySong();
    expect(song.title).toBe('');
    expect(song.artist).toBe('');
    expect(song.album).toBeNull();
    expect(song.source).toBe('ai_analysis');
    expect(song.spotifyUri).toBeNull();
    expect(song.spotifyUrl).toBeNull();
    expect(song.youtubeUrl).toBeNull();
    expect(song.soundcloudUrl).toBeNull();
    expect(song.addedToPlaylist).toBe(false);
  });
});

describe('createEmptyFilm', () => {
  it('returns object with all required fields and correct defaults', () => {
    const film = createEmptyFilm();
    expect(film.title).toBe('');
    expect(film.director).toBeNull();
    expect(film.year).toBeNull();
    expect(film.imdbUrl).toBeNull();
    expect(film.posterUrl).toBeNull();
    expect(film.streamingUrls).toBeNull();
  });
});
