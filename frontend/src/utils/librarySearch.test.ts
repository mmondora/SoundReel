import { describe, expect, it } from 'vitest';
import {
  MIN_QUERY_LENGTH,
  SCOPE_OPTIONS,
  canSearch,
  elsewhere,
  formatBytes,
  groupHits,
  normalizeQuery,
  scopeCount,
  searchFailure,
} from './librarySearch';
import type { LibraryHit, LibrarySearchResponse } from '../types';

const hit = (scope: LibraryHit['scope'], n: number, extra: Partial<LibraryHit> = {}): LibraryHit => ({
  scope, artist: 'Bassi Maestro', title: `Brano ${n}`, album: null, folder: scope === 'songs' ? 'Libreria' : 'Media server',
  location: scope === 'songs' ? null : `/x/${n}.mp3`, bytes: 1000, songKey: `bassi maestro::brano ${n}`, inJournal: scope === 'songs', ...extra,
});

const response = (counts: LibrarySearchResponse['counts'], results: LibraryHit[]): LibrarySearchResponse => ({ q: 'bassi', scope: 'all', counts, results });

describe('when to search', () => {
  it('needs at least 2 characters once trimmed (the server answers 400 below that)', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(canSearch('')).toBe(false);
    expect(canSearch(' a ')).toBe(false);
    expect(canSearch('ab')).toBe(true);
    expect(canSearch('  ab  ')).toBe(true);
  });

  it('normalises the text the server gets: trimmed, inner spaces collapsed, word order untouched', () => {
    expect(normalizeQuery('  Maestro   Bassi ')).toBe('Maestro Bassi');
  });

  it('the selector lists the journal first, then media server, local files, everything', () => {
    expect(SCOPE_OPTIONS).toEqual(['songs', 'media', 'local', 'all']);
  });
});

describe('counts', () => {
  it('a scope counts its own matches; "all" is the sum', () => {
    const counts = { songs: 3, media: 2, local: 41 };
    expect(scopeCount(counts, 'songs')).toBe(3);
    expect(scopeCount(counts, 'media')).toBe(2);
    expect(scopeCount(counts, 'local')).toBe(41);
    expect(scopeCount(counts, 'all')).toBe(46);
  });

  it('lists the OTHER places that have matches, never the one asked about, never an empty one', () => {
    expect(elsewhere({ songs: 0, media: 2, local: 41 }, 'songs')).toEqual([{ scope: 'media', count: 2 }, { scope: 'local', count: 41 }]);
    expect(elsewhere({ songs: 5, media: 0, local: 41 }, 'songs')).toEqual([{ scope: 'local', count: 41 }]);
    expect(elsewhere({ songs: 0, media: 0, local: 0 }, 'songs')).toEqual([]);
    expect(elsewhere({ songs: 1, media: 1, local: 1 }, 'media').map((e) => e.scope)).toEqual(['songs', 'local']);
  });
});

describe('groupHits', () => {
  const all = response({ songs: 1, media: 2, local: 150 }, [hit('songs', 1), hit('media', 2), hit('media', 3), hit('local', 4), hit('local', 5)]);

  it('"all" groups per place in a fixed order, with the total BEFORE the limit', () => {
    const groups = groupHits(all, 'all');
    expect(groups.map((g) => [g.scope, g.hits.length, g.total])).toEqual([['songs', 1, 1], ['media', 2, 2], ['local', 2, 150]]);
  });

  it('a single scope shows only its own hits', () => {
    expect(groupHits(all, 'media').map((g) => g.scope)).toEqual(['media']);
    expect(groupHits(all, 'media')[0].hits.map((h) => h.title)).toEqual(['Brano 2', 'Brano 3']);
  });

  it('drops places without hits, and never reports a total below what is shown', () => {
    const odd = response({ songs: 0, media: 0, local: 1 }, [hit('local', 1), hit('local', 2)]);
    expect(groupHits(odd, 'all').map((g) => [g.scope, g.total])).toEqual([['local', 2]]);
    expect(groupHits(all, 'songs')).toHaveLength(1);
    expect(groupHits(response({ songs: 0, media: 0, local: 0 }, []), 'all')).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('says sizes the way people read them, with a decimal comma in Italian', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(5_123_456)).toBe('4,9 MB');
    expect(formatBytes(5_123_456, 'en-GB')).toBe('4.9 MB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3,0 GB');
  });

  it('is empty when the size is unknown or nonsense', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
  });
});

describe('searchFailure', () => {
  it('maps what the server answered to what the page says', () => {
    const info = (code: string | null, status: number | null = null) => ({ code, index: null, status, message: '' });
    expect(searchFailure(info('query_too_short'))).toBe('tooShort');
    expect(searchFailure(info('invalid_scope'))).toBe('scope');
    expect(searchFailure(info('forbidden'))).toBe('forbidden');
    expect(searchFailure(info(null, 403))).toBe('forbidden');
    expect(searchFailure(info(null, 401))).toBe('forbidden');
    expect(searchFailure(info('network'))).toBe('network');
    expect(searchFailure(info(null, 500))).toBe('server');
    expect(searchFailure(info('library search failed'))).toBe('server');
  });
});
