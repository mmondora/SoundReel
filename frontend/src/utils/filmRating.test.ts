import { describe, it, expect } from 'vitest';
import { ratingFromScore } from './filmRating';

describe('ratingFromScore', () => {
  it('derives rotten below 20', () => {
    expect(ratingFromScore(0)).toBe('rotten');
    expect(ratingFromScore(19)).toBe('rotten');
  });

  it('derives fresh above 80', () => {
    expect(ratingFromScore(81)).toBe('fresh');
    expect(ratingFromScore(100)).toBe('fresh');
  });

  it('is neutral at the boundaries and in between', () => {
    expect(ratingFromScore(20)).toBeNull();
    expect(ratingFromScore(50)).toBeNull();
    expect(ratingFromScore(80)).toBeNull();
  });
});
