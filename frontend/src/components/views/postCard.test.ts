import { describe, expect, it } from 'vitest';
import { postFromEntry, postFromSearch, postFromSummary } from './postCard';
import type { Entry, EntrySummary, SearchResult } from '../../types';

// One model for the card of a post, whatever list it comes from (the journal, the list of summaries, a search): the wall draws only this.

const song = (n: number) => ({ title: `Song ${n}`, artist: `Artist ${n}`, album: null, source: 'ai_analysis' as const, spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });
const film = (n: number, year: string | null = '1999') => ({ title: `Film ${n}`, director: null, year, imdbUrl: null, posterUrl: null, streamingUrls: null });

function entry(partial: Partial<Entry> = {}, results: Partial<Entry['results']> = {}): Entry {
  return {
    id: 'e1', sourceUrl: 'https://instagram.com/reel/abc', sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null,
    caption: 'the caption', thumbnailUrl: 'https://img/1.jpg', mediaUrl: null, status: 'completed',
    results: { songs: [], films: [], notes: [], links: [], tags: [], ...results },
    actionLog: [], createdAt: '2026-11-10T10:00:00.000Z', ...partial,
  };
}

describe('postFromEntry', () => {
  it('takes the summary, the platform, the picture, the status and the date', () => {
    const post = postFromEntry(entry({}, { summary: '  A good summary  ' }));
    expect(post).toMatchObject({ id: 'e1', platform: 'instagram', thumbnailUrl: 'https://img/1.jpg', status: 'completed', summary: 'A good summary', createdAt: '2026-11-10T10:00:00.000Z' });
  });

  it('without a summary the caption is the text, without a caption the link; always cut at 140 characters', () => {
    expect(postFromEntry(entry()).summary).toBe('the caption');
    expect(postFromEntry(entry({ caption: null })).summary).toBe('https://instagram.com/reel/abc');
    expect(postFromEntry(entry({ caption: '   ' })).summary).toBe('https://instagram.com/reel/abc');
    const long = postFromEntry(entry({}, { summary: 'x'.repeat(300) })).summary;
    expect(long).toHaveLength(141);
    expect(long.endsWith('…')).toBe(true);
    expect(postFromEntry(entry({}, { summary: 'y'.repeat(140) })).summary).toHaveLength(140);
  });

  it('puts in view the first three songs and the first two films, and counts them all', () => {
    const post = postFromEntry(entry({}, { songs: [1, 2, 3, 4, 5].map(song), films: [1, 2, 3].map((n) => film(n)), notes: [{ text: 'n' } as never] }));
    expect(post.songs).toEqual([{ title: 'Song 1', artist: 'Artist 1' }, { title: 'Song 2', artist: 'Artist 2' }, { title: 'Song 3', artist: 'Artist 3' }]);
    expect(post.films).toEqual([{ title: 'Film 1', year: '1999' }, { title: 'Film 2', year: '1999' }]);
    expect([post.songCount, post.filmCount, post.noteCount]).toEqual([5, 3, 1]);
  });

  it('keeps at most four tags and drops the ones that are not text', () => {
    const post = postFromEntry(entry({}, { tags: ['a', '', '  ', 'b', 'c', 'd', 'e', 'f'] }));
    expect(post.tags).toEqual(['a', 'b', 'c', 'd']);
  });

  it('the placeholder tags the model copied from its prompt are not tags of the post', () => {
    const post = postFromEntry(entry({}, { tags: ['#tag', '#vino', '@utente', '#hashtag', '#cantina'] }));
    expect(post.tags).toEqual(['#vino', '#cantina']);
  });

  it('an entry of the full journal carries no chips of collections (the server sends them on the summaries)', () => {
    expect(postFromEntry(entry()).collections).toEqual([]);
  });

  it('a date in the form of the old database ({ _seconds }) is read; one that cannot be read is no date', () => {
    expect(postFromEntry(entry({ createdAt: { _seconds: 1_794_304_800 } as never })).createdAt).toBe(new Date(1_794_304_800 * 1000).toISOString());
    expect(postFromEntry(entry({ createdAt: 'not a date' })).createdAt).toBeNull();
    expect(postFromEntry(entry({ createdAt: undefined as never })).createdAt).toBeNull();
  });

  it('an entry with no results at all (an old row) is still a card', () => {
    const post = postFromEntry({ ...entry(), results: undefined as never });
    expect(post.songs).toEqual([]);
    expect([post.songCount, post.filmCount, post.noteCount]).toEqual([0, 0, 0]);
  });
});

describe('postFromSummary', () => {
  const row: EntrySummary = {
    id: 's1', sourceUrl: 'https://tiktok.com/x', sourcePlatform: 'tiktok', caption: 'cap', thumbnailUrl: null, status: 'processing',
    createdAt: '2026-11-09T08:00:00.000Z', summary: 'sum', songCount: 12, filmCount: 2, noteCount: 1, tags: ['t1', 't2'],
  };

  it('has only the counts (the list of summaries carries no songs), and the same fields otherwise', () => {
    expect(postFromSummary(row)).toEqual({
      id: 's1', platform: 'tiktok', createdAt: '2026-11-09T08:00:00.000Z', thumbnailUrl: null, summary: 'sum', status: 'processing',
      songs: [], films: [], songCount: 12, filmCount: 2, noteCount: 1, tags: ['t1', 't2'], collections: [],
    });
  });

  it('carries the chips of the collections the server sent, in its order', () => {
    const chips = [{ id: 'abc', name: 'Vino' }, { id: 'place:milano', name: 'Milano' }];
    expect(postFromSummary({ ...row, collections: chips }).collections).toEqual(chips);
    expect(postFromSummary(row).collections).toEqual([]);
  });

  it('without a summary the caption, then the link', () => {
    expect(postFromSummary({ ...row, summary: null }).summary).toBe('cap');
    expect(postFromSummary({ ...row, summary: null, caption: null }).summary).toBe('https://tiktok.com/x');
  });
});

describe('postFromSearch', () => {
  const found: SearchResult = {
    id: 'r1', sourceUrl: 'https://youtube.com/watch?v=1', sourcePlatform: 'youtube', caption: null, thumbnailUrl: 'https://img/2.jpg',
    results: { songs: [{ title: 'S', artist: 'A' }, { title: 'S2', artist: 'A2' }], films: [{ title: 'F' }], notes: [], tags: ['x'], summary: 'found' },
    createdAt: '2026-11-08T08:00:00.000Z', rank: 1,
  };

  it('puts in view what the result carries (a film of a search has no year)', () => {
    expect(postFromSearch(found)).toMatchObject({
      id: 'r1', platform: 'youtube', summary: 'found', thumbnailUrl: 'https://img/2.jpg', status: 'completed',
      songs: [{ title: 'S', artist: 'A' }, { title: 'S2', artist: 'A2' }], films: [{ title: 'F', year: null }], songCount: 2, filmCount: 1, noteCount: 0, tags: ['x'], collections: [],
    });
  });
});
