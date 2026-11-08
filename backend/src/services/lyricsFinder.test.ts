import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }));

import {
  _resetLyricsThrottle, findLyricsOnline, fold, isSameSong, LRCLIB_SEARCH, MIN_INTERVAL_MS, pickLyrics, sameArtist, searchLrclib, stripMarkers,
  titleCore, type LyricsCandidate, type LyricsFetchDeps,
} from './lyricsFinder';

const WORDS = 'First line of the song\nSecond line of the song\nThird line of the song';

const track = (over: Partial<LyricsCandidate> = {}): LyricsCandidate => ({
  id: 1, trackName: 'Song', artistName: 'Artist', albumName: 'Album', duration: 200, instrumental: false, plainLyrics: WORDS, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  _resetLyricsThrottle();
});

describe('folding: the same name written two ways is one', () => {
  it('drops case, accents, punctuation and apostrophes, and keeps the letters of every alphabet', () => {
    expect(fold('  Élan  Vital!! ')).toBe('elan vital');
    expect(fold("Don't Stop")).toBe('dont stop');
    expect(fold('Guns N’ Roses')).toBe('guns n roses');
    expect(fold('Hell Raton & Ensi')).toBe('hell raton and ensi');
    expect(fold('Мария 99')).toBe('мария 99');
    expect(fold('')).toBe('');
  });
});

describe('the title, without its markers', () => {
  it.each([
    ['Song (feat. Someone)', 'Song'],
    ['Song [Live at Wembley]', 'Song'],
    ['Song - 2011 Remaster', 'Song'],
    ['Song (Remastered 2011) - Single Version', 'Song'],
    ['(I Can\'t Get No) Satisfaction', 'Satisfaction'],
    ['Plain', 'Plain'],
  ])('%s → %s', (title, shown) => {
    expect(stripMarkers(title)).toBe(shown);
    expect(titleCore(title)).toBe(fold(shown));
  });

  it('a title that is only markers has no core (nothing to match) but is still searched as written', () => {
    expect(titleCore('(Intro)')).toBe('');
    expect(stripMarkers('(Intro)')).toBe('(Intro)');
  });
});

describe('the artist', () => {
  it('agrees when a credited name is in common', () => {
    expect(sameArtist('Hell Raton', 'Hell Raton, Ensi')).toBe(true);
    expect(sameArtist('Ensi', 'Hell Raton feat. Ensi')).toBe(true);
    expect(sameArtist('daft  punk', 'Daft Punk')).toBe(true);
    expect(sameArtist('Beyoncé', 'Beyonce')).toBe(true);
  });

  it('does not agree on a part of a name, or on another artist', () => {
    expect(sameArtist('Simon', 'Simon & Garfunkel')).toBe(false);   // «Simon & Garfunkel» is one name
    expect(sameArtist('Madonna', 'Madonna Louise')).toBe(false);
    expect(sameArtist('Other', 'Artist')).toBe(false);
    expect(sameArtist('', 'Artist')).toBe(false);
  });
});

describe('the strong match: better no text than another song\'s words', () => {
  const wanted = { artist: 'Artist', title: 'Song (Remastered 2011)' };

  it('is the same title without markers and a credited artist in common', () => {
    expect(isSameSong(track(), wanted)).toBe(true);
    expect(isSameSong(track({ trackName: 'Song - Radio Edit' }), wanted)).toBe(true);
    expect(isSameSong(track({ trackName: undefined, name: 'Song' }), wanted)).toBe(true);
  });

  it('is not a title that merely CONTAINS ours, nor the same title by another artist', () => {
    expect(isSameSong(track({ trackName: 'Song of the Sea' }), wanted)).toBe(false);
    expect(isSameSong(track({ trackName: 'Love Story' }), { artist: 'Artist', title: 'Love' })).toBe(false);
    expect(isSameSong(track({ artistName: 'Someone Else' }), wanted)).toBe(false);
  });

  it('is never a match without an artist to match (an empty one agrees with everybody) or without a title', () => {
    expect(isSameSong(track(), { artist: '   ', title: 'Song' })).toBe(false);
    expect(isSameSong(track({ trackName: '' }), { artist: 'Artist', title: '(Intro)' })).toBe(false);
  });
});

describe('choosing among what the archive sent', () => {
  const wanted = { artist: 'Artist', title: 'Song' };

  it('takes the words of the same song, cleaned', () => {
    const r = pickLyrics([track({ plainLyrics: 'Line one of it\r\n\r\n\r\n\r\nLine two of it   \r\nLine three of it\r\n' })], wanted);
    expect(r).toEqual({ answered: true, kind: 'lyrics', text: 'Line one of it\n\nLine two of it\nLine three of it', sourceId: '1' });
  });

  it('leaves out other songs, stubs and empty texts', () => {
    const r = pickLyrics([
      track({ id: 1, trackName: 'Another Song' }),
      track({ id: 2, plainLyrics: 'la la la' }),
      track({ id: 3, plainLyrics: '' }),
      track({ id: 4, plainLyrics: null }),
    ], wanted);
    expect(r).toEqual({ answered: true, kind: 'none' });
  });

  it('prefers the version on the album we know, then the archive\'s own order', () => {
    const first = track({ id: 10, albumName: 'Greatest Hits', plainLyrics: `${WORDS}\nfrom the compilation` });
    const onAlbum = track({ id: 11, albumName: 'The Album', plainLyrics: `${WORDS}\nfrom the album` });
    expect(pickLyrics([first, onAlbum], { ...wanted, album: 'the album' })).toMatchObject({ kind: 'lyrics', sourceId: '11' });
    expect(pickLyrics([first, onAlbum], wanted)).toMatchObject({ kind: 'lyrics', sourceId: '10' });
  });

  it('calls a song instrumental only when no version of it has words', () => {
    expect(pickLyrics([track({ id: 5, instrumental: true, plainLyrics: null })], wanted)).toEqual({ answered: true, kind: 'instrumental', sourceId: '5' });
    expect(pickLyrics([track({ id: 5, instrumental: true, plainLyrics: null }), track({ id: 6 })], wanted)).toMatchObject({ kind: 'lyrics', sourceId: '6' });
  });

  it('says nothing for an empty answer', () => {
    expect(pickLyrics([], wanted)).toEqual({ answered: true, kind: 'none' });
  });
});

// A fake archive: records the requests and a clock that moves only when somebody sleeps.
function archive(answer: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
  let clock = 1_000_000;
  const requests: Array<{ url: string; headers: Record<string, string>; at: number }> = [];
  const sleeps: number[] = [];
  const deps: LyricsFetchDeps = {
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers, at: clock });
      return answer();
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    userAgent: 'TestAgent/1',
  };
  return { deps, requests, sleeps };
}
const ok = (data: unknown) => async () => ({ ok: true, status: 200, json: async () => data });

describe('asking the archive', () => {
  it('searches by the first credited artist and the title without markers, and says who is asking', async () => {
    const a = archive(ok([track()]));
    const found = await searchLrclib('Hell Raton, Ensi', 'Song (feat. X) - Live', a.deps);
    expect(found).toHaveLength(1);
    const url = new URL(a.requests[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(LRCLIB_SEARCH);
    expect(url.searchParams.get('track_name')).toBe('Song');
    expect(url.searchParams.get('artist_name')).toBe('Hell Raton');
    expect(a.requests[0].headers['User-Agent']).toBe('TestAgent/1');
  });

  it('sends nothing else about anybody: only the artist and the title are in the address', async () => {
    const a = archive(ok([]));
    await searchLrclib('Artist', 'Song', a.deps);
    expect([...new URL(a.requests[0].url).searchParams.keys()].sort()).toEqual(['artist_name', 'track_name']);
  });

  it('tells an empty answer (the archive has nothing) from an outage (it could not be asked)', async () => {
    expect(await searchLrclib('A', 'S', archive(ok([])).deps)).toEqual([]);
    expect(await searchLrclib('A', 'S', archive(ok({ not: 'a list' })).deps)).toEqual([]);
    expect(await searchLrclib('A', 'S', archive(async () => ({ ok: false, status: 503, json: async () => ({}) })).deps)).toBeNull();
    expect(await searchLrclib('A', 'S', archive(async () => ({ ok: false, status: 429, json: async () => ({}) })).deps)).toBeNull();
    expect(await searchLrclib('A', 'S', archive(async () => { throw new Error('ECONNRESET'); }).deps)).toBeNull();
  });

  it('looks at no more than 15 results', async () => {
    const many = Array.from({ length: 40 }, (_, i) => track({ id: i }));
    expect(await searchLrclib('A', 'S', archive(ok(many)).deps)).toHaveLength(15);
  });

  it('keeps the requests at least a second apart, one at a time, even when asked together', async () => {
    const a = archive(ok([]));
    await Promise.all([searchLrclib('A', 'one', a.deps), searchLrclib('A', 'two', a.deps), searchLrclib('A', 'three', a.deps)]);
    expect(a.requests).toHaveLength(3);
    const gaps = a.requests.slice(1).map((r, i) => r.at - a.requests[i].at);
    expect(gaps.every((g) => g >= MIN_INTERVAL_MS)).toBe(true);
    expect(a.requests.map((r) => new URL(r.url).searchParams.get('track_name'))).toEqual(['one', 'two', 'three']);
  });

  it('does not wait when the last request was long ago', async () => {
    const a = archive(ok([]));
    await searchLrclib('A', 'one', a.deps);
    a.deps.sleep = async () => { throw new Error('should not sleep'); };
    // a clock far in the future: no gap to wait for
    const later: LyricsFetchDeps = { ...a.deps, now: () => 1_000_000 + 10 * MIN_INTERVAL_MS };
    await expect(searchLrclib('A', 'two', later)).resolves.toEqual([]);
  });
});

describe('findLyricsOnline', () => {
  it('does not even ask without an artist or without a title to match', async () => {
    const a = archive(ok([track()]));
    expect(await findLyricsOnline({ artist: '', title: 'Song' }, a.deps)).toEqual({ answered: true, kind: 'none' });
    expect(await findLyricsOnline({ artist: 'Artist', title: '(Intro)' }, a.deps)).toEqual({ answered: true, kind: 'none' });
    expect(a.requests).toHaveLength(0);
  });

  it('finds the words, says «none» when the archive has another song, and says «not answered» for an outage', async () => {
    expect(await findLyricsOnline({ artist: 'Artist', title: 'Song' }, archive(ok([track()])).deps)).toMatchObject({ answered: true, kind: 'lyrics' });
    expect(await findLyricsOnline({ artist: 'Artist', title: 'Song' }, archive(ok([track({ trackName: 'Other' })])).deps)).toEqual({ answered: true, kind: 'none' });
    expect(await findLyricsOnline({ artist: 'Artist', title: 'Song' }, archive(async () => { throw new Error('down'); }).deps)).toEqual({ answered: false });
  });
});
