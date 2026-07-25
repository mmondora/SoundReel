import { describe, it, expect } from 'vitest';
import { isPlausibleUrl } from './linkValidation';

describe('isPlausibleUrl', () => {
  it('accepts real http(s) URLs', () => {
    expect(isPlausibleUrl('https://www.plex.tv')).toBe(true);
    expect(isPlausibleUrl('https://jellyfin.org')).toBe(true);
    expect(isPlausibleUrl('http://sub.example.co.uk/path?q=1')).toBe(true);
  });

  // new URL() parses this happily, with "..." as the hostname — it is exactly
  // what a model emits when it has no real address to give.
  it('rejects the ellipsis placeholder', () => {
    expect(isPlausibleUrl('https://...')).toBe(false);
    expect(isPlausibleUrl('https://.')).toBe(false);
    expect(isPlausibleUrl('https://a..b')).toBe(false);
    expect(isPlausibleUrl('https://.com')).toBe(false);
  });

  it('rejects a hostname with no dot', () => {
    expect(isPlausibleUrl('https://localhost')).toBe(false);
  });

  it('rejects non-http schemes', () => {
    expect(isPlausibleUrl('javascript:alert(1)')).toBe(false);
    expect(isPlausibleUrl('ftp://example.com')).toBe(false);
    expect(isPlausibleUrl('data:text/html,hi')).toBe(false);
  });

  it('rejects text that is not a URL', () => {
    expect(isPlausibleUrl('')).toBe(false);
    expect(isPlausibleUrl('not a url')).toBe(false);
    expect(isPlausibleUrl('the link is in the pinned comment')).toBe(false);
  });
});
