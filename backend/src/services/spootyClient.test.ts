import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addToSpooty,
  postToSpooty,
  listSpootyPlaylists,
  listSpootyTracks,
  findSpootyPlaylistByUrl,
  isFinalSpootyStatus,
  SpootyStatus,
} from './spootyClient';

vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }));

const ID = '22kBlINGUYm2rc1Wd7RPfw';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('spootyClient', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('status codes match the verified Spooty enum', () => {
    expect(SpootyStatus).toEqual({ New: 0, Searching: 1, Queued: 2, Downloading: 3, Completed: 4, Error: 5 });
    expect(isFinalSpootyStatus(4)).toBe(true);
    expect(isFinalSpootyStatus(5)).toBe(true);
    expect(isFinalSpootyStatus(3)).toBe(false);
  });

  it('addToSpooty posts JSON and never throws', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 201 }));
    await expect(addToSpooty(`https://open.spotify.com/track/${ID}`)).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://spooty:3000/api/playlist');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ spotifyUrl: `https://open.spotify.com/track/${ID}` });

    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(addToSpooty('x')).resolves.toEqual({ ok: false, error: 'Spooty HTTP 500: boom' });

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(addToSpooty('x')).resolves.toEqual({ ok: false, error: 'ECONNREFUSED' });
  });

  it('postToSpooty keeps the boolean contract', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 201 }));
    await expect(postToSpooty('u')).resolves.toBe(true);
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expect(postToSpooty('u')).resolves.toBe(false);
  });

  it('parses playlists and tracks defensively', async () => {
    fetchMock.mockResolvedValueOnce(json([{ id: 38, name: 'Say it Ain\'t So', spotifyUrl: 'u', error: null, active: false, isTrack: true, coverUrl: 'c' }]));
    await expect(listSpootyPlaylists()).resolves.toEqual([
      { id: 38, name: "Say it Ain't So", spotifyUrl: 'u', error: null, active: false, isTrack: true, coverUrl: 'c' },
    ]);
    fetchMock.mockResolvedValueOnce(json([{ id: 609, artist: 'PENNY', name: 'Say it Ain\'t So', spotifyUrl: 'u', youtubeUrl: null, status: 5, error: 'HTTP Error 403', coverUrl: null }]));
    const tracks = await listSpootyTracks(38);
    expect(tracks[0]).toMatchObject({ id: 609, artist: 'PENNY', status: 5, error: 'HTTP Error 403', youtubeUrl: null });
  });

  it('listSpootyPlaylists throws when Spooty is unreachable or answers non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    await expect(listSpootyPlaylists()).rejects.toThrow('Spooty HTTP 502');
  });

  it('finds the newest playlist for a canonical URL even if Spooty stored it with ?si=', async () => {
    const stored = (id: number, url: string) => ({ id, name: 'n', spotifyUrl: url, error: null, active: false, isTrack: true, coverUrl: null });
    fetchMock.mockResolvedValueOnce(json([
      stored(10, `https://open.spotify.com/track/${ID}?si=old`),
      stored(11, 'https://open.spotify.com/track/OTHERidOTHERidOTHERid'),
      stored(38, `https://open.spotify.com/track/${ID}?si=new&utm_source=copy-link`),
    ]));
    const found = await findSpootyPlaylistByUrl(`https://open.spotify.com/track/${ID}`);
    expect(found?.id).toBe(38);

    fetchMock.mockResolvedValueOnce(json([]));
    await expect(findSpootyPlaylistByUrl(`https://open.spotify.com/track/${ID}`)).resolves.toBeNull();
  });
});
