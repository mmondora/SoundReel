import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPlayPlan } from './api';

// `GET /api/songs/:songKey/play?prefer=auto|internet|media` (rule P, ADR-0018): the browser sends its preference and gets the
// plan of the server. An answer it does not understand is read on the safe side (the video, no file, the external network).

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const FILE_PLAN = {
  songKey: 'bassi maestro::capirai',
  prefer: 'auto',
  network: 'internal',
  choice: 'media',
  from: 'media-server',
  download: false,
  fileUrl: '/api/songs/bassi%20maestro%3A%3Acapirai/file',
};

describe('fetchPlayPlan', () => {
  it('asks for the song by its key (URL-encoded) with the preference, and never from the cache', async () => {
    const f = stubFetch(200, FILE_PLAN);
    await fetchPlayPlan('bassi maestro::capirai/live', 'internet');
    const url = new URL(String(f.mock.calls[0][0]), 'http://x');
    expect(url.pathname).toBe('/api/songs/bassi%20maestro%3A%3Acapirai%2Flive/play');
    expect(Object.fromEntries(url.searchParams)).toEqual({ prefer: 'internet' });
    expect(f.mock.calls[0][1]?.cache).toBe('no-store');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each(['auto', 'internet', 'media'] as const)('sends %s as `prefer`; Auto when none is given', async (prefer) => {
    const f = stubFetch(200, FILE_PLAN);
    await fetchPlayPlan('a::b', prefer);
    expect(new URL(String(f.mock.calls[0][0]), 'http://x').searchParams.get('prefer')).toBe(prefer);
    const g = stubFetch(200, FILE_PLAN);
    await fetchPlayPlan('a::b');
    expect(new URL(String(g.mock.calls[0][0]), 'http://x').searchParams.get('prefer')).toBe('auto');
  });

  it('returns what the server decided, as it said it', async () => {
    stubFetch(200, FILE_PLAN);
    expect(await fetchPlayPlan('bassi maestro::capirai', 'auto')).toEqual(FILE_PLAN);
    stubFetch(200, { ...FILE_PLAN, prefer: 'media', network: 'external', choice: 'media', from: 'disk', fileUrl: '/api/songs/x/file' });
    expect(await fetchPlayPlan('x')).toMatchObject({ prefer: 'media', network: 'external', from: 'disk', fileUrl: '/api/songs/x/file' });
    stubFetch(200, { ...FILE_PLAN, network: 'internal', choice: 'media', from: 'youtube', download: true, fileUrl: null });
    expect(await fetchPlayPlan('x')).toMatchObject({ from: 'youtube', download: true, fileUrl: null });
  });

  it('a file without an address is the video: nothing is played from a path the server did not give', async () => {
    stubFetch(200, { ...FILE_PLAN, fileUrl: null });
    expect(await fetchPlayPlan('x')).toMatchObject({ from: 'youtube', fileUrl: null });
    stubFetch(200, { ...FILE_PLAN, fileUrl: '' });
    expect(await fetchPlayPlan('x')).toMatchObject({ from: 'youtube', fileUrl: null });
  });

  it('a video never carries an address', async () => {
    stubFetch(200, { ...FILE_PLAN, from: 'youtube', fileUrl: '/api/songs/x/file' });
    expect(await fetchPlayPlan('x')).toMatchObject({ from: 'youtube', fileUrl: null });
  });

  it('a plan it does not understand is read on the safe side: the video, no file, the external network, no download', async () => {
    stubFetch(200, {});
    expect(await fetchPlayPlan('x', 'internet')).toEqual({
      songKey: 'x',
      prefer: 'internet',
      network: 'external',
      choice: 'internet',
      from: 'youtube',
      download: false,
      fileUrl: null,
    });
    stubFetch(200, { network: 'lan', choice: 'both', from: 'floppy', download: 'yes', fileUrl: 42 });
    expect(await fetchPlayPlan('x')).toMatchObject({ network: 'external', choice: 'internet', from: 'youtube', download: false, fileUrl: null });
  });

  it('fails when the server does (404 song not found, 500, an answer that is not JSON): the caller plays the video', async () => {
    stubFetch(404, { error: 'song not found' });
    await expect(fetchPlayPlan('nope::nope')).rejects.toThrow(/song not found/);
    stubFetch(500, { error: 'play plan failed' });
    await expect(fetchPlayPlan('x')).rejects.toThrow();
    stubFetch(200, '<!doctype html><title>SoundReel</title>');
    await expect(fetchPlayPlan('x')).rejects.toThrow();
  });
});
