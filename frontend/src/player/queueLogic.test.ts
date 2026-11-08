import { describe, it, expect } from 'vitest';
import {
  nextIndex,
  prevIndex,
  queueFromList,
  rebuildQueueFromKeys,
  shuffleKeepingCurrent,
  cycleRepeat,
  isLikedSong,
  isPlayableFull,
} from './queueLogic';

describe('nextIndex', () => {
  it('advances within the queue', () => {
    expect(nextIndex(0, 3, 'off')).toBe(1);
    expect(nextIndex(1, 3, 'off')).toBe(2);
  });

  it('stops at the end when repeat is off', () => {
    expect(nextIndex(2, 3, 'off')).toBeNull();
  });

  it('wraps when repeat is all', () => {
    expect(nextIndex(2, 3, 'all')).toBe(0);
  });

  it('stays on the same track when repeat is one', () => {
    expect(nextIndex(1, 3, 'one')).toBe(1);
  });

  it('returns null for an empty queue', () => {
    expect(nextIndex(0, 0, 'all')).toBeNull();
  });
});

describe('prevIndex', () => {
  it('steps backward', () => {
    expect(prevIndex(2, 3, 'off')).toBe(1);
  });

  it('stops at the start when repeat is off', () => {
    expect(prevIndex(0, 3, 'off')).toBeNull();
  });

  it('wraps when repeat is all', () => {
    expect(prevIndex(0, 3, 'all')).toBe(2);
  });
});

describe('queueFromList', () => {
  const list = [{ songKey: 'a' }, { songKey: 'b' }, { songKey: 'c' }];

  it('starts at the matching song', () => {
    expect(queueFromList(list, 'b')).toEqual({ queue: list, index: 1 });
  });

  it('falls back to 0 when the key is missing', () => {
    expect(queueFromList(list, 'missing').index).toBe(0);
  });
});

describe('rebuildQueueFromKeys', () => {
  const catalog = [{ songKey: 'a' }, { songKey: 'b' }, { songKey: 'c' }, { songKey: 'd' }];

  it('keeps persisted order and current index', () => {
    expect(rebuildQueueFromKeys(catalog, ['c', 'a', 'd'], 'a')).toEqual({
      queue: [{ songKey: 'c' }, { songKey: 'a' }, { songKey: 'd' }],
      index: 1,
    });
  });

  it('drops keys missing from the catalog', () => {
    const out = rebuildQueueFromKeys(catalog, ['a', 'gone', 'b'], 'gone');
    expect(out).toEqual({
      queue: [{ songKey: 'a' }, { songKey: 'b' }],
      index: 0,
    });
  });

  it('returns null when nothing matches', () => {
    expect(rebuildQueueFromKeys(catalog, ['x', 'y'], null)).toBeNull();
  });
});

describe('shuffleKeepingCurrent', () => {
  it('puts the current track first', () => {
    const queue = ['a', 'b', 'c', 'd'];
    const out = shuffleKeepingCurrent(queue, 2, () => 0);
    expect(out.queue[0]).toBe('c');
    expect(out.index).toBe(0);
    expect(out.queue).toHaveLength(4);
    expect(new Set(out.queue)).toEqual(new Set(queue));
  });
});

describe('cycleRepeat', () => {
  it('cycles off → all → one → off', () => {
    expect(cycleRepeat('off')).toBe('all');
    expect(cycleRepeat('all')).toBe('one');
    expect(cycleRepeat('one')).toBe('off');
  });
});

describe('isLikedSong / isPlayableFull', () => {
  it('likes by rating or high score', () => {
    expect(isLikedSong({ rating: 'like', score: null })).toBe(true);
    expect(isLikedSong({ rating: null, score: 80 })).toBe(true);
    expect(isLikedSong({ rating: null, score: 79 })).toBe(false);
    expect(isLikedSong(null)).toBe(false);
  });

  it('playable when inLibrary or downloaded flag', () => {
    expect(isPlayableFull({ inLibrary: true })).toBe(true);
    expect(isPlayableFull({ inLibrary: false, meta: { downloaded: true } })).toBe(true);
    expect(isPlayableFull({ inLibrary: false, meta: { downloaded: false } })).toBe(false);
  });
});
