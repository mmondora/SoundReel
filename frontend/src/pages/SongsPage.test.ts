import { describe, it, expect } from 'vitest';
import { mergePatch } from './SongsPage';
import type { SongMetaRecord } from '../types';

function meta(partial: Partial<SongMetaRecord>): SongMetaRecord {
  return {
    songKey: 'artist::title',
    deezerId: 123,
    itunesId: null,
    genres: ['Pop'],
    album: 'An Album',
    coverUrl: 'https://example.com/cover.jpg',
    previewUrl: 'https://example.com/preview.mp3',
    deezerUrl: 'https://deezer.com/track/123',
    itunesUrl: null,
    enrichedAt: '2026-01-01T00:00:00Z',
    listened: false,
    favorite: false,
    downloaded: false,
    rating: null,
    score: null,
    ...partial,
  };
}

describe('mergePatch', () => {
  it('creates a default meta record when meta is null', () => {
    const result = mergePatch(null, 'artist::new', { listened: true });
    expect(result).toEqual({
      songKey: 'artist::new',
      deezerId: null,
      itunesId: null,
      genres: [],
      album: null,
      coverUrl: null,
      previewUrl: null,
      deezerUrl: null,
      itunesUrl: null,
      enrichedAt: null,
      listened: true,
      favorite: false,
      downloaded: false,
      rating: null,
      score: null,
    });
  });

  it('forces listened true when rating is set to a non-null value', () => {
    const result = mergePatch(meta({ listened: false, rating: null }), 'artist::title', { rating: 'like' });
    expect(result.rating).toBe('like');
    expect(result.listened).toBe(true);
  });

  it('forces listened true when score is set to a non-null value', () => {
    const result = mergePatch(meta({ listened: false }), 'artist::title', { score: 87 });
    expect(result.score).toBe(87);
    expect(result.listened).toBe(true);
  });

  it('clears the rating without forcing listened back to false', () => {
    const base = meta({ listened: true, rating: 'like' });
    const result = mergePatch(base, 'artist::title', { rating: null });
    expect(result.rating).toBeNull();
    expect(result.listened).toBe(true);
  });

  it('passes through favorite toggles', () => {
    const result = mergePatch(meta({ favorite: false }), 'artist::title', { favorite: true });
    expect(result.favorite).toBe(true);
    // Unrelated fields untouched.
    expect(result.listened).toBe(false);
  });

  it('passes through downloaded toggles', () => {
    const result = mergePatch(meta({ downloaded: false }), 'artist::title', { downloaded: true });
    expect(result.downloaded).toBe(true);
  });

  it('does not mutate the source meta object', () => {
    const base = meta({ rating: 'like', favorite: false });
    mergePatch(base, 'artist::title', { rating: 'dislike', favorite: true });
    expect(base.rating).toBe('like');
    expect(base.favorite).toBe(false);
  });
});
