import { describe, expect, it } from 'vitest';
import {
  MAX_PLAYLIST_PAGE,
  applyPlaylistList,
  normalizeForSearch,
  parsePlaylistListQuery,
  type ListablePlaylist,
  type PlaylistListQuery,
} from './playlistList';

const parse = (raw: Record<string, unknown>): PlaylistListQuery => {
  const r = parsePlaylistListQuery(raw);
  if (!r.ok) throw new Error(`unexpected error: ${r.error}`);
  return r.query;
};

const pl = (name: string, over: Partial<ListablePlaylist> = {}): ListablePlaylist => ({
  name,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  songCount: 3,
  kind: 'static',
  ownerUser: 'mike',
  ...over,
});

const names = (rows: ListablePlaylist[]) => rows.map((r) => r.name);

describe('reading the query string', () => {
  it('a request with none of the parameters is the answer of before (legacy)', () => {
    expect(parse({}).legacy).toBe(true);
    expect(parsePlaylistListQuery(undefined)).toMatchObject({ ok: true, query: { legacy: true } });
    // a parameter we do not know is not one of ours: it does not turn the list into a new-style one
    expect(parse({ _: '1699999' }).legacy).toBe(true);
  });

  it('with any parameter it is not legacy, and the defaults are the order of before: last change first, every playlist', () => {
    const q = parse({ q: '' });
    expect(q).toMatchObject({ legacy: false, filter: 'all', sort: 'updated', order: 'desc', limit: null, offset: 0, words: [] });
  });

  it('reads every parameter', () => {
    const q = parse({ q: '  Più  Jazz! ', filter: 'auto', sort: 'created', order: 'asc', limit: '30', offset: '60' });
    expect(q).toEqual({ words: ['piu', 'jazz'], filter: 'auto', sort: 'created', order: 'asc', limit: 30, offset: 60, legacy: false });
  });

  it('by name the natural order is A to Z, by anything else the newest or biggest first; an explicit order always wins', () => {
    expect(parse({ sort: 'name' }).order).toBe('asc');
    expect(parse({ sort: 'created' }).order).toBe('desc');
    expect(parse({ sort: 'size' }).order).toBe('desc');
    expect(parse({ sort: 'name', order: 'desc' }).order).toBe('desc');
    expect(parse({ sort: 'created', order: 'asc' }).order).toBe('asc');
  });

  it('a page is never bigger than the maximum', () => {
    expect(parse({ limit: '500' }).limit).toBe(MAX_PLAYLIST_PAGE);
    expect(parse({ limit: String(MAX_PLAYLIST_PAGE) }).limit).toBe(MAX_PLAYLIST_PAGE);
    expect(parse({ limit: '1' }).limit).toBe(1);
  });

  it('a search is cut at 100 characters', () => {
    expect(parse({ q: 'a'.repeat(300) }).words).toEqual(['a'.repeat(100)]);
  });

  it.each([
    [{ filter: 'banana' }, 'filter'],
    [{ sort: 'banana' }, 'sort'],
    [{ order: 'up' }, 'order'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '-3' }, 'limit'],
    [{ limit: 'abc' }, 'limit'],
    [{ limit: '2.5' }, 'limit'],
    [{ offset: '-1' }, 'offset'],
    [{ offset: 'x' }, 'offset'],
    [{ q: ['a', 'b'] }, 'q'],
    [{ sort: ['created', 'name'] }, 'sort'],
  ])('%j is an error that says which parameter', (raw, key) => {
    const r = parsePlaylistListQuery(raw as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(key);
  });
});

describe('what a search sees', () => {
  it('has no case, no accents and no punctuation', () => {
    expect(normalizeForSearch('Più Ascoltate!')).toBe('piu ascoltate');
    expect(normalizeForSearch('  Jazz — da   ascoltare ')).toBe('jazz da ascoltare');
    expect(normalizeForSearch('Caffè & Co.')).toBe('caffe co');
  });

  it('keeps letters that are not Latin', () => {
    expect(normalizeForSearch('夜に駆ける 2019')).toBe('夜に駆ける 2019');
  });
});

describe('applying the list', () => {
  const rows = [
    pl('Jazz da ascoltare', { createdAt: '2026-11-09T10:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z', origin: 'auto', songCount: 12 }),
    pl('Le 5 musiche di Natale', { createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z', origin: 'auto', songCount: 5 }),
    pl('Road trip', { createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-11-08T10:00:00.000Z', songCount: 40 }),
    pl('Notte', { createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-11-07T10:00:00.000Z', kind: 'dynamic', songCount: 25 }),
    pl('Di Sara', { createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-11-06T10:00:00.000Z', ownerUser: 'sara', songCount: 7 }),
    pl('Èstate', { createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T10:00:00.000Z', songCount: 9 }),
  ];
  const run = (raw: Record<string, unknown>) => applyPlaylistList(rows, parse(raw), 'mike');

  it('legacy: every playlist, in the order it was given, and the total', () => {
    const out = applyPlaylistList(rows, parse({}), 'mike');
    expect(out.items).toEqual(rows);
    expect(out.total).toBe(6);
  });

  it('searches the name: words in any order, without case or accents', () => {
    expect(names(run({ q: 'ascoltare jazz' }).items)).toEqual(['Jazz da ascoltare']);
    expect(names(run({ q: 'ESTATE' }).items)).toEqual(['Èstate']);
    expect(names(run({ q: 'musiche natale' }).items)).toEqual(['Le 5 musiche di Natale']);
    expect(names(run({ q: 'jazz natale' }).items)).toEqual([]);
    expect(run({ q: 'zzz' }).total).toBe(0);
  });

  it('a partial word matches', () => {
    expect(names(run({ q: 'ro' }).items)).toEqual(expect.arrayContaining(['Road trip']));
  });

  it('filters: automatic, mine, shared with me, dynamic', () => {
    expect(names(run({ filter: 'auto', sort: 'name' }).items)).toEqual(['Jazz da ascoltare', 'Le 5 musiche di Natale']);
    expect(names(run({ filter: 'mine', sort: 'name' }).items)).toEqual(['Èstate', 'Jazz da ascoltare', 'Le 5 musiche di Natale', 'Notte', 'Road trip']);
    expect(names(run({ filter: 'shared' }).items)).toEqual(['Di Sara']);
    expect(names(run({ filter: 'dynamic' }).items)).toEqual(['Notte']);
    expect(run({ filter: 'all' }).total).toBe(6);
  });

  it('a filter and a search work together', () => {
    expect(names(run({ filter: 'auto', q: 'jazz' }).items)).toEqual(['Jazz da ascoltare']);
    expect(run({ filter: 'shared', q: 'jazz' }).total).toBe(0);
  });

  it('sorts by creation date, the newest first, and the other way round', () => {
    expect(names(run({ sort: 'created' }).items)).toEqual(['Jazz da ascoltare', 'Le 5 musiche di Natale', 'Road trip', 'Notte', 'Di Sara', 'Èstate']);
    expect(names(run({ sort: 'created', order: 'asc' }).items)).toEqual(['Èstate', 'Di Sara', 'Notte', 'Road trip', 'Le 5 musiche di Natale', 'Jazz da ascoltare']);
  });

  it('sorts by last change, by name (accents and numbers the human way) and by size', () => {
    expect(names(run({ sort: 'updated' }).items)[0]).toBe('Jazz da ascoltare');
    expect(names(run({ sort: 'name' }).items)).toEqual(['Di Sara', 'Èstate', 'Jazz da ascoltare', 'Le 5 musiche di Natale', 'Notte', 'Road trip']);
    expect(names(run({ sort: 'name', order: 'desc' }).items)[0]).toBe('Road trip');
    expect(names(run({ sort: 'size' }).items)).toEqual(['Road trip', 'Notte', 'Jazz da ascoltare', 'Èstate', 'Di Sara', 'Le 5 musiche di Natale']);
    expect(names(run({ sort: 'size', order: 'asc' }).items)[0]).toBe('Le 5 musiche di Natale');
  });

  it('a tie is settled by the newest, then by name, whatever the direction', () => {
    const tied = [
      pl('B', { songCount: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
      pl('A', { songCount: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
      pl('C', { songCount: 1, createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(names(applyPlaylistList(tied, parse({ sort: 'size' }), 'mike').items)).toEqual(['C', 'A', 'B']);
    expect(names(applyPlaylistList(tied, parse({ sort: 'size', order: 'asc' }), 'mike').items)).toEqual(['C', 'A', 'B']);
  });

  it('a date that cannot be read counts as the oldest, never breaks the list', () => {
    const odd = [pl('Senza data', { createdAt: '' }), pl('Con data', { createdAt: '2026-05-01T00:00:00.000Z' })];
    expect(names(applyPlaylistList(odd, parse({ sort: 'created' }), 'mike').items)).toEqual(['Con data', 'Senza data']);
  });

  it('pages: the slice, and the total BEFORE the page is cut', () => {
    const first = run({ sort: 'created', limit: '4', offset: '0' });
    expect(names(first.items)).toEqual(['Jazz da ascoltare', 'Le 5 musiche di Natale', 'Road trip', 'Notte']);
    expect(first.total).toBe(6);
    const second = run({ sort: 'created', limit: '4', offset: '4' });
    expect(names(second.items)).toEqual(['Di Sara', 'Èstate']);
    expect(second.total).toBe(6);
  });

  it('an offset past the end is an empty page that still knows the total', () => {
    const out = run({ limit: '10', offset: '60' });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(6);
  });

  it('the total counts only what matched the search and the filter', () => {
    const out = run({ filter: 'auto', limit: '1' });
    expect(out.items).toHaveLength(1);
    expect(out.total).toBe(2);
  });

  it('without a limit every match comes back (an offset still skips)', () => {
    expect(run({ sort: 'created', offset: '4' }).items).toHaveLength(2);
    expect(run({ sort: 'created' }).items).toHaveLength(6);
  });

  it('does not change the list it was given', () => {
    const copy = JSON.stringify(rows);
    run({ sort: 'name', limit: '2' });
    expect(JSON.stringify(rows)).toBe(copy);
  });
});
