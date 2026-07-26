import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { enrichSong } from './songEnrichment';

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEEZER_TRACK = {
  id: 111,
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
      previewUrl: 'https://cdns-preview.deezer.com/preview111.mp3',
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
  it('picks the result whose artistName/trackName loosely match over the first result', async () => {
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

  it('matches on trackName containment even if artistName differs', async () => {
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
