import { describe, it, expect } from 'vitest';
import { isQuotaError } from './backfillStreaming';

describe('isQuotaError', () => {
  it('matches a plain 429', () => {
    expect(isQuotaError('watchmode 429: too many requests')).toBe(true);
  });

  it('matches Watchmode-style 401 with a quota/entitlement statusMessage (the real signal, 429 is undocumented)', () => {
    expect(isQuotaError('watchmode 401: {"statusMessage":"Your monthly limit has been reached"}')).toBe(true);
  });

  it('matches a bare "quota" mention regardless of status code', () => {
    expect(isQuotaError('movie_of_the_night 403: quota exceeded for this API key')).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isQuotaError('watchmode 500: internal server error blah blah')).toBe(false);
    expect(isQuotaError('TypeError: Cannot read properties of undefined')).toBe(false);
  });

  it('a bad API key (also surfaced as 401) is treated as a quota-style abort too', () => {
    expect(isQuotaError('watchmode 401: {"statusMessage":"Invalid API Key"}')).toBe(true);
  });
});
