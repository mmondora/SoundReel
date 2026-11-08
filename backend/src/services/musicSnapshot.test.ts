import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../utils/db', () => ({ query: m.query }));

import { getMediaSnapshot, invalidateMediaSnapshot } from './musicSnapshot';
import { matchesAll, normalizeSearch, tokenize } from '../utils/searchText';

const rows = [
  { rel_path: 'Music/Bassi Maestro/Cuore Nero/01 - Cuore Nero.mp3', artist: 'Bassi Maestro', title: 'Cuore Nero', album: 'Cuore Nero', bytes: '6000000', norm_key: 'bassi maestro|cuore nero' },
  { rel_path: 'Music/Björk/Homogenic/02 - Jóga.mp3', artist: 'Björk', title: 'Jóga', album: null, bytes: null, norm_key: 'björk|jóga' },
];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateMediaSnapshot();
  m.query.mockResolvedValue(rows);
});

describe('search text', () => {
  it('ignores case, accents and punctuation, and the order of the words', () => {
    expect(normalizeSearch('  Björk — Jóga!! ')).toBe('bjork joga');
    expect(tokenize('Maestro   BASSI')).toEqual(['maestro', 'bassi']);
    const text = normalizeSearch('Bassi Maestro Cuore Nero Music/Bassi Maestro/Cuore Nero');
    expect(matchesAll(text, tokenize('Maestro Bassi'))).toBe(true);
    expect(matchesAll(text, tokenize('maestro bassi zzz'))).toBe(false);
    expect(matchesAll(text, [])).toBe(true);
  });
});

describe('getMediaSnapshot', () => {
  it('holds the box\'s catalogue with a search text over artist, title, album and path, and a lookup by normalised key', async () => {
    const snap = await getMediaSnapshot();
    expect(snap.files).toHaveLength(2);
    expect(snap.files[0]).toMatchObject({ artist: 'Bassi Maestro', bytes: 6_000_000 });
    expect(snap.files[0].searchText).toContain('music bassi maestro cuore nero');
    expect(snap.files[1]).toMatchObject({ bytes: null, album: null });
    expect(snap.files[1].searchText).toContain('bjork joga'); // accents folded: "Bjork" finds Björk
    expect(snap.byNormKey.get('bassi maestro|cuore nero')).toHaveLength(1);
    expect(m.query.mock.calls[0][0]).toContain("store = 'fritz'");
  });

  it('is kept for a minute, shared by concurrent callers, and rebuilt after invalidation', async () => {
    const [a, b] = await Promise.all([getMediaSnapshot(), getMediaSnapshot()]);
    expect(a).toBe(b);
    await getMediaSnapshot();
    expect(m.query).toHaveBeenCalledTimes(1);
    invalidateMediaSnapshot();
    await getMediaSnapshot();
    expect(m.query).toHaveBeenCalledTimes(2);
  });
});
