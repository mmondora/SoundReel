import { describe, expect, it } from 'vitest';
import { pendingLocks, withEntryKeyLock } from './entryKeyLock';
import { postKey } from '../services/urlNormalize';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('postKey: one identity for the ways a post can be written', () => {
  it.each([
    ['https://www.instagram.com/reel/DWDZS4Qob0U/?utm_source=ig_web_copy_link', 'instagram:DWDZS4Qob0U'],
    ['https://www.instagram.com/reel/DWDZS4Qob0U/?igsh=MWY3bW45dHN', 'instagram:DWDZS4Qob0U'],
    ['https://www.instagram.com/p/DYuKJ_aCJsd?img_index=3', 'instagram:DYuKJ_aCJsd'],
    ['https://www.instagram.com/reel/DYlDIyGCor-?igsh=x', 'instagram:DYlDIyGCor-'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube:dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'youtube:dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/abcDEF12345', 'youtube:abcDEF12345'],
    ['https://www.tiktok.com/@someone/video/7234567890123456789?is_from_webapp=1', 'tiktok:7234567890123456789'],
    ['https://x.com/someone/status/1790000000000000000?s=20', 'x:1790000000000000000'],
    ['https://twitter.com/someone/status/1790000000000000000', 'x:1790000000000000000'],
    ['https://www.reddit.com/r/music/comments/1abc2de/some_title/', 'reddit:1abc2de'],
    ['https://example.com/a/?utm_source=x#frag', 'url:https://example.com/a'],
    ['not a url', 'url:not a url'],
  ])('%s → %s', (url, key) => {
    expect(postKey(url)).toBe(key);
  });

  it('the same post written two ways has one key; different posts do not', () => {
    expect(postKey('https://youtu.be/dQw4w9WgXcQ')).toBe(postKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    expect(postKey('https://x.com/a/status/1')).toBe(postKey('https://twitter.com/b/status/1'));
    expect(postKey('https://www.instagram.com/reel/AAA')).not.toBe(postKey('https://www.instagram.com/reel/BBB'));
  });
});

describe('withEntryKeyLock', () => {
  it('runs the same (owner, post) one at a time, in order', async () => {
    const log: string[] = [];
    const run = (name: string, ms: number) =>
      withEntryKeyLock('mike', 'https://www.instagram.com/reel/AAA/?igsh=1', async () => {
        log.push(`${name} in`);
        await sleep(ms);
        log.push(`${name} out`);
        return name;
      });
    const results = await Promise.all([run('first', 20), run('second', 1), run('third', 1)]);
    expect(results).toEqual(['first', 'second', 'third']);
    expect(log).toEqual(['first in', 'first out', 'second in', 'second out', 'third in', 'third out']);
  });

  it('the same post written two ways is the same lock', async () => {
    const log: string[] = [];
    await Promise.all([
      withEntryKeyLock('mike', 'https://youtu.be/dQw4w9WgXcQ', async () => { log.push('a in'); await sleep(15); log.push('a out'); }),
      withEntryKeyLock('mike', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', async () => { log.push('b in'); log.push('b out'); }),
    ]);
    expect(log).toEqual(['a in', 'a out', 'b in', 'b out']);
  });

  it('different posts, or different users, do not wait for each other', async () => {
    const log: string[] = [];
    await Promise.all([
      withEntryKeyLock('mike', 'https://www.instagram.com/reel/AAA', async () => { await sleep(20); log.push('mike AAA'); }),
      withEntryKeyLock('mike', 'https://www.instagram.com/reel/BBB', async () => { log.push('mike BBB'); }),
      withEntryKeyLock('sara', 'https://www.instagram.com/reel/AAA', async () => { log.push('sara AAA'); }),
    ]);
    expect(log).toEqual(['mike BBB', 'sara AAA', 'mike AAA']);
  });

  it('a failure frees the lock and reaches its own caller only', async () => {
    const url = 'https://www.instagram.com/reel/AAA';
    const failing = withEntryKeyLock('mike', url, async () => { throw new Error('boom'); });
    const next = withEntryKeyLock('mike', url, async () => 'fine');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('fine');
  });

  it('forgets the key when nobody waits, so the table never grows', async () => {
    await withEntryKeyLock('mike', 'https://www.instagram.com/reel/AAA', async () => 1);
    await withEntryKeyLock('mike', 'https://www.instagram.com/reel/BBB', async () => 2);
    expect(pendingLocks()).toBe(0);
  });
});
