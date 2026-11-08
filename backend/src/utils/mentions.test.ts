import { describe, expect, it } from 'vitest';
import { addMention, mentionOf, postUrlOf } from './mentions';

const entry = (over: Record<string, unknown> = {}) =>
  ({ id: 'e1', createdAt: '2026-11-08T07:00:00Z', sourceUrl: 'https://www.instagram.com/reel/abc/', sourcePlatform: 'instagram', ...over }) as never;

describe('mentionOf: a mention carries the post it came from', () => {
  it('has the entry, the date, the post URL and the platform', () => {
    expect(mentionOf(entry())).toEqual({ entryId: 'e1', createdAt: '2026-11-08T07:00:00Z', sourceUrl: 'https://www.instagram.com/reel/abc/', sourcePlatform: 'instagram' });
  });

  it('is null (not missing, not empty) when the entry has no URL or platform', () => {
    expect(mentionOf(entry({ sourceUrl: '', sourcePlatform: null }))).toMatchObject({ sourceUrl: null, sourcePlatform: null });
    expect(mentionOf(entry({ sourceUrl: undefined, sourcePlatform: undefined }))).toMatchObject({ sourceUrl: null, sourcePlatform: null });
    expect(mentionOf(entry({ sourceUrl: '   ' })).sourceUrl).toBeNull();
  });

  it('trims the URL and survives a missing date', () => {
    expect(mentionOf(entry({ sourceUrl: '  https://x.it/a  ', createdAt: undefined }))).toMatchObject({ sourceUrl: 'https://x.it/a', createdAt: '' });
  });
});

describe('postUrlOf: a stray character before the address does not break the link', () => {
  it('drops up to four characters in front of http(s)://, as in the real journal entry stored with a leading "x"', () => {
    expect(postUrlOf('xhttps://www.instagram.com/reel/DWrmSv6iHT9/?utm_source=ig_web_copy_link')).toBe('https://www.instagram.com/reel/DWrmSv6iHT9/?utm_source=ig_web_copy_link');
    expect(postUrlOf('  >http://x.it/a ')).toBe('http://x.it/a');
    expect(mentionOf(entry({ sourceUrl: 'xhttps://www.instagram.com/reel/abc/' })).sourceUrl).toBe('https://www.instagram.com/reel/abc/');
  });

  it('leaves a good address alone, and anything that is not one', () => {
    expect(postUrlOf('https://www.instagram.com/reel/abc/')).toBe('https://www.instagram.com/reel/abc/');
    expect(postUrlOf('HTTPS://X.IT/A')).toBe('HTTPS://X.IT/A');
    expect(postUrlOf('not a url at all')).toBe('not a url at all');
    expect(postUrlOf('far far away https://x.it/a')).toBe('far far away https://x.it/a'); // too much in front: not touched
    expect(postUrlOf('')).toBeNull();
    expect(postUrlOf(undefined)).toBeNull();
  });
});

describe('addMention: one mention per entry', () => {
  it('an entry that names the same thing twice counts once', () => {
    const list: Array<{ entryId: string }> = [];
    addMention(list, { entryId: 'a' });
    addMention(list, { entryId: 'a' });
    addMention(list, { entryId: 'b' });
    expect(list.map((m) => m.entryId)).toEqual(['a', 'b']);
  });
});
