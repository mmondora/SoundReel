import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { enrichSong, _resetItunesThrottle } from './songEnrichment';

beforeEach(() => {
  // Every test gets a fresh 3s iTunes throttle window — without this, the
  // second (and every later) test in this file to reach tryItunes would
  // really `await sleep(...)` out the remainder of the window left over
  // from a prior test's call, since lastItunesCall is module-level state.
  _resetItunesThrottle();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const DEEZER_TRACK = {
  id: 111,
  title: 'One More Time',
  artist: { name: 'Daft Punk' },
  link: 'https://www.deezer.com/track/111',
  preview: 'https://cdns-preview.deezer.com/preview111.mp3',
  album: {
    id: 222,
    title: 'Discovery',
    cover_medium: 'https://cdn-images.dzcdn.net/images/cover/222/medium.jpg',
  },
};

const DEEZER_ALBUM_RESPONSE = {
  genres: { data: [{ id: 1, name: 'Electronic' }, { id: 2, name: 'Dance' }] },
};

const ITUNES_TRACK = {
  trackId: 333,
  trackViewUrl: 'https://music.apple.com/track/333',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/333.jpg',
  previewUrl: 'https://audio-ssl.itunes.apple.com/preview333.m4a',
  collectionName: 'Discovery',
  primaryGenreName: 'Dance',
  artistName: 'Daft Punk',
  trackName: 'One More Time',
};

describe('enrichSong — Deezer happy path', () => {
  it('maps first Deezer result + fetches album genres', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [DEEZER_TRACK] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => DEEZER_ALBUM_RESPONSE });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('api.deezer.com/search');
    expect(fetchMock.mock.calls[0][0]).toContain(encodeURIComponent('artist:"Daft Punk" track:"One More Time"'));
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.deezer.com/album/222');

    expect(result).toEqual({
      deezerId: 111,
      itunesId: null,
      genres: ['Electronic', 'Dance'],
      album: 'Discovery',
      coverUrl: 'https://cdn-images.dzcdn.net/images/cover/222/medium.jpg',
      // Never persisted — Deezer preview URLs are signed and expire ~14min
      // after issue; on-demand resolution happens via GET
      // /api/songs/:songKey/preview instead.
      previewUrl: null,
      deezerUrl: 'https://www.deezer.com/track/111',
      itunesUrl: null,
    });
  });

  it('tolerates album-genres fetch failure, keeps track fields, genres []', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [DEEZER_TRACK] }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result).not.toBeNull();
    expect(result?.genres).toEqual([]);
    expect(result?.deezerId).toBe(111);
  });

  it('tolerates album-genres fetch network throw, genres []', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [DEEZER_TRACK] }) })
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result).not.toBeNull();
    expect(result?.genres).toEqual([]);
  });

  it('tolerates the album endpoint returning HTTP 200 with a rate-limit error body — genres [], track kept, no iTunes fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [DEEZER_TRACK] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ error: { code: 4, message: 'Quota limit exceeded' } }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    expect(result?.deezerId).toBe(111);
    expect(result?.itunesId).toBeNull();
    expect(result?.genres).toEqual([]);
  });

  it('skips the album genres call when the track has no album id', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ ...DEEZER_TRACK, album: undefined }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.genres).toEqual([]);
    expect(result?.album).toBeNull();
    expect(result?.coverUrl).toBeNull();
  });
});

describe('enrichSong — Deezer miss / error → iTunes fallback', () => {
  it('falls back to iTunes when Deezer returns empty data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('itunes.apple.com/search');
    expect(result).toEqual({
      deezerId: null,
      itunesId: 333,
      genres: ['Dance'],
      album: 'Discovery',
      coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/333.jpg',
      previewUrl: 'https://audio-ssl.itunes.apple.com/preview333.m4a',
      deezerUrl: null,
      itunesUrl: 'https://music.apple.com/track/333',
    });
  });

  it('falls back to iTunes on Deezer rate-limit body ({"error":{"code":4}}) with HTTP 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ error: { code: 4, message: 'Quota limit exceeded' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.itunesId).toBe(333);
    expect(result?.deezerId).toBeNull();
  });

  it('falls back to iTunes when Deezer search HTTP call is not ok', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.itunesId).toBe(333);
  });

  it('falls back to iTunes when Deezer search throws (network error)', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.itunesId).toBe(333);
  });
});

describe('enrichSong — both providers miss', () => {
  it('returns null when Deezer empty and iTunes empty', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Obscure Artist', 'Unknown Track');

    expect(result).toBeNull();
  });

  it('returns null (logged, never throws) when both providers throw on network', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Obscure Artist', 'Unknown Track');

    expect(result).toBeNull();
  });
});

describe('enrichSong — iTunes loose match selection', () => {
  it('prefers a both-match candidate over an earlier either-match candidate (avoids a cover-band same-title pick)', async () => {
    // index 0: either-match only (artist matches, track is an unrelated cover-band title)
    const eitherMatch = { ...ITUNES_TRACK, trackId: 10, artistName: 'Daft Punk Official', trackName: 'Nope Not This' };
    // index 1: no match at all
    const decoy = { ...ITUNES_TRACK, trackId: 11, artistName: 'Someone Else', trackName: 'Totally Different' };
    // index 2: both-match — the real one, but listed after the either-match candidate
    const bothMatch = { ...ITUNES_TRACK, trackId: 12, artistName: 'Daft Punk', trackName: 'One More Time' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [eitherMatch, decoy, bothMatch] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.itunesId).toBe(12);
  });

  it('picks the result whose artistName loosely matches when no both-match candidate exists', async () => {
    const decoy = { ...ITUNES_TRACK, trackId: 1, artistName: 'Someone Else', trackName: 'Totally Different' };
    const matchByArtist = { ...ITUNES_TRACK, trackId: 2, artistName: 'Daft Punk Official', trackName: 'Nope Not This' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [decoy, matchByArtist] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.itunesId).toBe(2);
  });

  it('matches on trackName containment alone, but only wins when no both-match candidate exists', async () => {
    const decoy = { ...ITUNES_TRACK, trackId: 1, artistName: 'Someone Else', trackName: 'Totally Different' };
    const matchByTrack = { ...ITUNES_TRACK, trackId: 3, artistName: 'Cover Band', trackName: 'One More Time (cover)' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [decoy, matchByTrack] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.itunesId).toBe(3);
  });

  it('falls back to the first result when nothing loosely matches', async () => {
    const decoy1 = { ...ITUNES_TRACK, trackId: 1, artistName: 'Someone Else', trackName: 'Totally Different' };
    const decoy2 = { ...ITUNES_TRACK, trackId: 2, artistName: 'Another One', trackName: 'Also Different' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [decoy1, decoy2] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.itunesId).toBe(1);
  });

  it('search url includes media=music, limit=5 and country=IT', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);

    await enrichSong('Daft Punk', 'One More Time');

    const itunesUrl = fetchMock.mock.calls[1][0] as string;
    expect(itunesUrl).toContain('media=music');
    expect(itunesUrl).toContain('limit=5');
    expect(itunesUrl).toContain('country=IT');
  });
});

describe('enrichSong — URL validation', () => {
  it('drops a javascript: deezer preview/link/cover url to null', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            ...DEEZER_TRACK,
            link: 'javascript:alert(1)',
            preview: 'javascript:alert(2)',
            album: { ...DEEZER_TRACK.album, cover_medium: 'javascript:alert(3)' },
          },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => DEEZER_ALBUM_RESPONSE });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.deezerUrl).toBeNull();
    expect(result?.previewUrl).toBeNull();
    expect(result?.coverUrl).toBeNull();
  });

  it('drops a javascript: iTunes url to null', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              ...ITUNES_TRACK,
              trackViewUrl: 'javascript:alert(1)',
              artworkUrl100: 'javascript:alert(2)',
              previewUrl: 'javascript:alert(3)',
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.itunesUrl).toBeNull();
    expect(result?.coverUrl).toBeNull();
    expect(result?.previewUrl).toBeNull();
  });
});

describe('enrichSong — iTunes-only edge cases', () => {
  it('maps missing primaryGenreName to an empty genres array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ ...ITUNES_TRACK, primaryGenreName: undefined }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.genres).toEqual([]);
  });

  it('returns null when iTunes search HTTP call is not ok', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result).toBeNull();
  });
});

describe('enrichSong — Deezer match verification (consistent with the iTunes T2 ruling)', () => {
  it('skips a wrong-artist same-title first result in favor of a later both-match result', async () => {
    const titleOnlyMatch = { ...DEEZER_TRACK, id: 10, artist: { name: 'Some Cover Band' }, title: 'One More Time' };
    const bothMatch = { ...DEEZER_TRACK, id: 12, artist: { name: 'Daft Punk' }, title: 'One More Time' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [titleOnlyMatch, bothMatch] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => DEEZER_ALBUM_RESPONSE });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    expect(result?.deezerId).toBe(12);
  });

  it('falls through to iTunes when no Deezer result matches title or artist', async () => {
    const decoy1 = { ...DEEZER_TRACK, id: 1, artist: { name: 'Someone Else' }, title: 'Totally Different' };
    const decoy2 = { ...DEEZER_TRACK, id: 2, artist: { name: 'Another One' }, title: 'Also Different' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [decoy1, decoy2] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('Daft Punk', 'One More Time');

    // Only the search call was made — no album-genres call, since selectDeezerMatch
    // returned null before a track was ever chosen.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('itunes.apple.com/search');
    expect(result?.deezerId).toBeNull();
    expect(result?.itunesId).toBe(333);
  });

  it('matches on title alone when the input artist is empty (vacuous-true artist check)', async () => {
    const titleMatchOnly = { ...DEEZER_TRACK, id: 21, artist: { name: 'Whoever Performed It' }, title: 'One More Time' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [titleMatchOnly] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => DEEZER_ALBUM_RESPONSE });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('', 'One More Time');

    expect(result?.deezerId).toBe(21);
  });

  it('still misses (falls through) when the input artist is empty but no title matches', async () => {
    const decoy = { ...DEEZER_TRACK, id: 30, artist: { name: 'Whoever' }, title: 'Totally Different' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [decoy] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrichSong('', 'One More Time');

    expect(result?.deezerId).toBeNull();
    expect(result?.itunesId).toBe(333);
  });
});

describe('resolveDeezerPreviewUrl — live, on-demand resolution (never cached)', () => {
  it('returns the fresh preview url from GET /track/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: 'https://cdns-preview.deezer.com/fresh.mp3' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { resolveDeezerPreviewUrl } = await import('./songEnrichment');
    const result = await resolveDeezerPreviewUrl(111);

    expect(fetchMock).toHaveBeenCalledWith('https://api.deezer.com/track/111');
    expect(result).toBe('https://cdns-preview.deezer.com/fresh.mp3');
  });

  it('returns null when the HTTP call is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);

    const { resolveDeezerPreviewUrl } = await import('./songEnrichment');
    expect(await resolveDeezerPreviewUrl(111)).toBeNull();
  });

  it('returns null on a rate-limit error body with HTTP 200', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: { code: 4, message: 'Quota limit exceeded' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { resolveDeezerPreviewUrl } = await import('./songEnrichment');
    expect(await resolveDeezerPreviewUrl(111)).toBeNull();
  });

  it('returns null on a network throw', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveDeezerPreviewUrl } = await import('./songEnrichment');
    expect(await resolveDeezerPreviewUrl(111)).toBeNull();
  });

  it('drops a javascript: preview url to null', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ preview: 'javascript:alert(1)' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { resolveDeezerPreviewUrl } = await import('./songEnrichment');
    expect(await resolveDeezerPreviewUrl(111)).toBeNull();
  });
});

describe('tryItunes throttle — module-level min 3000ms interval, shared by every caller', () => {
  it('lets a lone call through immediately (no artificial delay on the common case)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    const result = await enrichSong('Daft Punk', 'One More Time');
    expect(result?.itunesId).toBe(333);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('delays a second iTunes call until the 3000ms window since the first has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) }) // deezer miss #1
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) }) // itunes hit #1
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) }) // deezer miss #2
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) }); // itunes hit #2
    vi.stubGlobal('fetch', fetchMock);

    const first = enrichSong('Daft Punk', 'One More Time');
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = enrichSong('Daft Punk', 'One More Time');
    // Deezer's own call for the second lookup isn't throttled, but the
    // second iTunes fetch should not have fired yet after only 1000ms.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Advancing past the full 3000ms window releases it.
    await vi.advanceTimersByTimeAsync(2000);
    const result = await second;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result?.itunesId).toBe(333);
    expect(Date.now()).toBe(3000);
  });

  it('_resetItunesThrottle lets an immediate next call through without waiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock);
    const p1 = enrichSong('Daft Punk', 'One More Time');
    await vi.advanceTimersByTimeAsync(0);
    await p1;

    _resetItunesThrottle();

    const fetchMock2 = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [ITUNES_TRACK] }) });
    vi.stubGlobal('fetch', fetchMock2);

    const p2 = enrichSong('Daft Punk', 'One More Time');
    await vi.advanceTimersByTimeAsync(0);
    const result = await p2;

    expect(fetchMock2).toHaveBeenCalledTimes(2);
    expect(result?.itunesId).toBe(333);
  });
});
