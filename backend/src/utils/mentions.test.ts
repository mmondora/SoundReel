import { describe, expect, it } from 'vitest';
import { addMention, mentionOf } from './mentions';

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

describe('addMention: one mention per entry', () => {
  it('an entry that names the same thing twice counts once', () => {
    const list: Array<{ entryId: string }> = [];
    addMention(list, { entryId: 'a' });
    addMention(list, { entryId: 'a' });
    addMention(list, { entryId: 'b' });
    expect(list.map((m) => m.entryId)).toEqual(['a', 'b']);
  });
});
