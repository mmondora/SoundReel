import { describe, expect, it } from 'vitest';
import { youtubeErrorMessage, youtubeErrorShouldSkip } from './youtubeErrors';

describe('youtubeErrors', () => {
  it('labels known codes with Uffa — errore N', () => {
    expect(youtubeErrorMessage(2)).toMatch(/^Uffa — errore 2:/);
    expect(youtubeErrorMessage(5)).toMatch(/^Uffa — errore 5:/);
    expect(youtubeErrorMessage(101)).toMatch(/embed/i);
    expect(youtubeErrorMessage(9)).toMatch(/^Uffa — errore 9:/);
  });

  it('skips on fatal playback codes', () => {
    expect(youtubeErrorShouldSkip(2)).toBe(true);
    expect(youtubeErrorShouldSkip(5)).toBe(true);
    expect(youtubeErrorShouldSkip(150)).toBe(true);
    expect(youtubeErrorShouldSkip(0)).toBe(false);
  });
});
