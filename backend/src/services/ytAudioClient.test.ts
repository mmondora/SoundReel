import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestYtAudio, stagingBasename, stagingDir } from './ytAudioClient';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const job = { songKey: 'bishop briggs::white flag', artist: 'Bishop Briggs', title: 'White Flag' };

afterEach(() => {
  delete process.env.INSTALOADER_URL;
  delete process.env.STAGING_DIR;
  delete process.env.MEDIA_ROOT;
});

describe('staging', () => {
  it('lives in the shared media volume, and the file name never depends on how the song is spelled', () => {
    expect(stagingDir()).toBe('/data/media/_staging');
    process.env.MEDIA_ROOT = '/mnt/m';
    expect(stagingDir()).toBe('/mnt/m/_staging');
    process.env.STAGING_DIR = '/x/y';
    expect(stagingDir()).toBe('/x/y');
    const a = stagingBasename("guns n' roses::don't cry / (live)");
    expect(a).toMatch(/^sf-[0-9a-f]{16}$/);
    expect(stagingBasename("guns n' roses::don't cry / (live)")).toBe(a);
    expect(stagingBasename('other::song')).not.toBe(a);
  });
});

describe('requestYtAudio', () => {
  it('posts the job to the sidecar and returns the downloaded file', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json({ ok: true, path: '/data/media/_staging/sf-1.mp3', bytes: 5720510, durationS: 231, videoId: 'RWzZeA2GMsk',
        videoTitle: 'Bishop Briggs - White Flag (Audio)', channel: 'Bishop Briggs', score: 15.2, tagged: true }),
    );
    const res = await requestYtAudio({ ...job, album: 'Church of Scars', coverUrl: 'https://c/x.jpg', expectedDurationS: 230, videoUrl: null }, fetchImpl);

    expect(res).toEqual({ ok: true, path: '/data/media/_staging/sf-1.mp3', bytes: 5720510, durationS: 231, videoId: 'RWzZeA2GMsk',
      videoTitle: 'Bishop Briggs - White Flag (Audio)', channel: 'Bishop Briggs', score: 15.2, tagged: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://soundreel-instaloader:5000/yt/audio');
    expect(JSON.parse(String(init?.body))).toEqual({
      artist: 'Bishop Briggs', title: 'White Flag', album: 'Church of Scars', coverUrl: 'https://c/x.jpg', expectedDurationS: 230,
      videoUrl: null, outDir: '/data/media/_staging', basename: stagingBasename(job.songKey),
    });
  });

  it('passes a person-chosen video link through and honours INSTALOADER_URL', async () => {
    process.env.INSTALOADER_URL = 'http://other:9/';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true, path: '/p.mp3', videoId: 'x' }));
    await requestYtAudio({ ...job, videoUrl: 'https://youtu.be/syhBqULC99I' }, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://other:9/yt/audio');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).videoUrl).toBe('https://youtu.be/syhBqULC99I');
  });

  it('keeps the sidecar’s failure code (and the video that failed)', async () => {
    const res = await requestYtAudio(job, vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false, code: 'blocked', error: 'HTTP Error 403', videoId: 'abc' })));
    expect(res).toEqual({ ok: false, code: 'blocked', error: 'HTTP Error 403', videoId: 'abc' });
  });

  it('turns every other failure into a code instead of throwing', async () => {
    expect(await requestYtAudio(job, vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))).toMatchObject({ ok: false, code: 'transport', error: 'fetch failed' });
    expect(await requestYtAudio(job, vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>', { status: 502 })))).toMatchObject({ ok: false, code: 'transport' });
    expect(await requestYtAudio(job, vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false, error: 'x' }, 400)))).toMatchObject({ ok: false, code: 'transport', error: 'x' });
    expect(await requestYtAudio(job, vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false, code: 'weird', error: 'x' })))).toMatchObject({ ok: false, code: 'error' });
    expect(await requestYtAudio(job, vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false, code: 'bad_request', error: 'title richiesto' }, 400)))).toMatchObject({ ok: false, code: 'bad_request' });
  });
});
