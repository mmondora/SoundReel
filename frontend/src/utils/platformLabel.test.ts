import { describe, expect, it } from 'vitest';
import { platformLabel } from './platformLabel';

describe('platformLabel', () => {
  it.each([
    ['instagram', 'IG'], ['tiktok', 'TT'], ['youtube', 'YT'], ['facebook', 'FB'], ['twitter', 'X'], ['threads', 'TH'], ['snapchat', 'SC'],
    ['pinterest', 'PIN'], ['linkedin', 'LI'], ['reddit', 'RD'], ['vimeo', 'VM'], ['twitch', 'TW'], ['spotify', 'SP'], ['soundcloud', 'SND'], ['shazam', 'SZ'],
  ])('%s is %s', (platform, label) => {
    expect(platformLabel(platform)).toBe(label);
  });

  it('anything else is «WEB»', () => {
    expect(platformLabel('other')).toBe('WEB');
    expect(platformLabel('')).toBe('WEB');
    expect(platformLabel('mastodon')).toBe('WEB');
    expect(platformLabel('constructor')).toBe('WEB');                    // the names every object inherits are not platforms
    expect(platformLabel('toString')).toBe('WEB');
    expect(platformLabel('__proto__')).toBe('WEB');
  });
});
