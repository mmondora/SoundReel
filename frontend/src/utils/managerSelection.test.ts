import { describe, expect, it } from 'vitest';
import {
  invertMarks,
  keysMatching,
  markAllVisible,
  markMany,
  matchesPattern,
  moveCursor,
  operationTargets,
  pruneMarks,
  rangeKeys,
  reconcileCursor,
  toggleMark,
  unmarkMany,
} from './managerSelection';
import type { ManagerSong } from './managerSongs';

const KEYS = ['a', 'b', 'c', 'd', 'e'];

describe('moveCursor', () => {
  it('moves one row and clamps at the edges', () => {
    expect(moveCursor(KEYS, 'b', 'down')).toBe('c');
    expect(moveCursor(KEYS, 'b', 'up')).toBe('a');
    expect(moveCursor(KEYS, 'a', 'up')).toBe('a');
    expect(moveCursor(KEYS, 'e', 'down')).toBe('e');
  });

  it('home / end / pages', () => {
    expect(moveCursor(KEYS, 'c', 'home')).toBe('a');
    expect(moveCursor(KEYS, 'c', 'end')).toBe('e');
    expect(moveCursor(KEYS, 'c', 'pageDown')).toBe('e');
    expect(moveCursor(KEYS, 'c', 'pageUp')).toBe('a');
    const long = Array.from({ length: 30 }, (_, i) => `k${i}`);
    expect(moveCursor(long, 'k5', 'pageDown')).toBe('k15');
    expect(moveCursor(long, 'k25', 'pageUp')).toBe('k15');
  });

  it('starts at the first row without a cursor and returns null for an empty list', () => {
    expect(moveCursor(KEYS, null, 'down')).toBe('a');
    expect(moveCursor(KEYS, null, 'up')).toBe('a');
    expect(moveCursor(KEYS, 'zzz', 'down')).toBe('a');
    expect(moveCursor([], null, 'down')).toBeNull();
  });
});

describe('reconcileCursor', () => {
  it('keeps the cursor on the same song when it is still visible', () => {
    expect(reconcileCursor(KEYS, ['b', 'c'], 'c')).toBe('c');
  });

  it('falls back to the nearest slot when the song disappeared', () => {
    expect(reconcileCursor(KEYS, ['a', 'b', 'd', 'e'], 'c')).toBe('d');
    expect(reconcileCursor(KEYS, ['a'], 'e')).toBe('a');
  });

  it('picks the first row without a cursor, null for an empty list', () => {
    expect(reconcileCursor([], KEYS, null)).toBe('a');
    expect(reconcileCursor(KEYS, [], 'a')).toBeNull();
  });
});

describe('marks', () => {
  it('toggle, mark many, unmark many (never mutating the input)', () => {
    const base = new Set(['a']);
    expect([...toggleMark(base, 'b')]).toEqual(['a', 'b']);
    expect([...toggleMark(base, 'a')]).toEqual([]);
    expect([...markMany(base, ['b', 'c'])]).toEqual(['a', 'b', 'c']);
    expect([...unmarkMany(new Set(['a', 'b', 'c']), ['b'])]).toEqual(['a', 'c']);
    expect([...base]).toEqual(['a']);
  });

  it('Ctrl+A marks every visible row; * inverts among the visible rows', () => {
    expect([...markAllVisible(KEYS)]).toEqual(KEYS);
    expect([...invertMarks(new Set(['a', 'c']), KEYS)]).toEqual(['b', 'd', 'e']);
    expect([...invertMarks(new Set(), ['x', 'y'])]).toEqual(['x', 'y']);
  });

  it('pruneMarks drops hidden rows (and keeps the same set when nothing changes)', () => {
    const marked = new Set(['a', 'z']);
    expect([...pruneMarks(marked, KEYS)]).toEqual(['a']);
    const same = new Set(['a']);
    expect(pruneMarks(same, KEYS)).toBe(same);
  });
});

describe('rangeKeys', () => {
  it('returns the inclusive range in list order, either direction', () => {
    expect(rangeKeys(KEYS, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeKeys(KEYS, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeKeys(KEYS, null, 'c')).toEqual(['c']);
    expect(rangeKeys(KEYS, 'zzz', 'c')).toEqual(['c']);
    expect(rangeKeys(KEYS, 'a', 'zzz')).toEqual([]);
  });
});

const song = (title: string, artist: string, album: string | null = null): ManagerSong =>
  ({ songKey: `${artist}::${title}`, title, artist, album }) as ManagerSong;

describe('matchesPattern', () => {
  const live = song('Roxanne (Live)', 'Police', 'Live Album');
  const studio = song('Roxanne', 'Police', 'Outlandos');

  it('plain text is a case-insensitive substring over title, artist, album and "artist - title"', () => {
    expect(matchesPattern(live, 'live')).toBe(true);
    expect(matchesPattern(studio, 'live')).toBe(false);
    expect(matchesPattern(studio, 'POLICE')).toBe(true);
    expect(matchesPattern(studio, 'police - rox')).toBe(true);
  });

  it('wildcards must match a whole field', () => {
    expect(matchesPattern(live, '*live*')).toBe(true);
    expect(matchesPattern(studio, '*live*')).toBe(false);
    expect(matchesPattern(studio, 'pol*')).toBe(true);
    expect(matchesPattern(studio, 'rox')).toBe(true);
    expect(matchesPattern(studio, 'rox*')).toBe(true);
    expect(matchesPattern(studio, 'ox*')).toBe(false);
    expect(matchesPattern(studio, 'Roxann?')).toBe(true);
    expect(matchesPattern(studio, 'Roxan?')).toBe(false);
  });

  it('escapes regex characters in the mask', () => {
    expect(matchesPattern(song('a.b', 'x'), 'a.b*')).toBe(true);
    expect(matchesPattern(song('axb', 'x'), 'a.b*')).toBe(false);
    expect(matchesPattern(song('(live)', 'x'), '(*)')).toBe(true);
  });

  it('an empty pattern matches nothing', () => {
    expect(matchesPattern(studio, '   ')).toBe(false);
  });

  it('keysMatching lists the keys of the matching songs', () => {
    expect(keysMatching([live, studio], '*live*')).toEqual(['Police::Roxanne (Live)']);
  });
});

describe('operationTargets', () => {
  it('uses the marked visible rows in list order', () => {
    expect(operationTargets(new Set(['d', 'b', 'zzz']), KEYS, 'a')).toEqual(['b', 'd']);
  });

  it('falls back to the cursor row, or nothing', () => {
    expect(operationTargets(new Set(), KEYS, 'c')).toEqual(['c']);
    expect(operationTargets(new Set(), KEYS, null)).toEqual([]);
    expect(operationTargets(new Set(), KEYS, 'zzz')).toEqual([]);
  });
});
