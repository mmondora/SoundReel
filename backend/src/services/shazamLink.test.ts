import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalShazamUrl,
  fetchShazamTrack,
  parseShazamLink,
  parseShazamPage,
  ShazamFetchError,
  SHAZAM_USER_AGENT,
} from './shazamLink';

const fixture = (name: string): string => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
const WHITE_FLAG_PAGE = fixture('shazam-song-white-flag.html');
// What shazam.com really answered for /track/404798580 to browser-like User-Agents (verified 2026-11-07):
// HTTP 200, no redirect, a generic page about ANOTHER song.
const GENERIC_FALLBACK_PAGE = fixture('shazam-generic-fallback.html');

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string, status = 301): Response =>
  new Response(null, { status, headers: { location } });

describe('parseShazamLink', () => {
  it('reads the link the iOS Shazam app shares (track key, referrer param) and drops the noise', () => {
    expect(parseShazamLink('https://www.shazam.com/track/404798580?referrer=share')).toEqual({
      kind: 'track',
      id: '404798580',
      slug: null,
      url: 'https://www.shazam.com/track/404798580',
    });
  });

  it('gives slug, locale prefix, bare host, http and surrounding spaces the same canonical form', () => {
    const forms = [
      'https://www.shazam.com/track/404798580/white-flag',
      'https://www.shazam.com/it-it/track/404798580/white-flag?referrer=share',
      'https://www.shazam.com/it/track/404798580',
      'https://shazam.com/track/404798580#top',
      'http://www.shazam.com/track/404798580',
      '  https://www.shazam.com/track/404798580  ',
    ];
    for (const f of forms) expect(canonicalShazamUrl(f)).toBe('https://www.shazam.com/track/404798580');
  });

  it('understands /song/<adamId>/<slug> pages (what the browser address bar gives), keeping the slug', () => {
    expect(parseShazamLink('https://www.shazam.com/song/1360212103/white-flag')).toEqual({
      kind: 'song',
      id: '1360212103',
      slug: 'white-flag',
      url: 'https://www.shazam.com/song/1360212103/white-flag',
    });
    for (const f of [
      'https://www.shazam.com/song/1360212103/white-flag/music-video',
      'https://www.shazam.com/it-it/song/1360212103/white-flag?referrer=share',
      'https://shazam.com/song/1360212103/white-flag#lyrics',
    ]) {
      expect(canonicalShazamUrl(f)).toBe('https://www.shazam.com/song/1360212103/white-flag');
    }
  });

  it.each([
    // Shazam answers a slug-less /song/<id> with HTTP 204 (verified live 2026-11-07): nothing to read.
    'https://www.shazam.com/song/1360212103',
    'https://www.shazam.com/artist/bishop-briggs/1126808565',
    'https://www.shazam.com/charts/top-200/italy',
    'https://www.shazam.com/discovery',
    'https://www.shazam.com/',
    'https://www.shazam.com/track/',
    'https://www.shazam.com/track/not-a-number',
    'https://shazam.com.evil.example/track/404798580',
    'https://evil.example/www.shazam.com/track/404798580',
    'https://notshazam.com/track/404798580',
    'https://open.spotify.com/track/22kBlINGUYm2rc1Wd7RPfw',
    'ftp://www.shazam.com/track/404798580',
    'javascript:alert(1)',
    'not a url',
    '',
  ])('does not treat %j as a Shazam track', (input) => {
    expect(parseShazamLink(input)).toBeNull();
  });
});

describe('parseShazamPage', () => {
  it('reads the real song page: title, artist, album, cover and page url from the top-level recording', () => {
    expect(parseShazamPage(WHITE_FLAG_PAGE)).toEqual({
      title: 'White Flag',
      artist: 'Bishop Briggs',
      album: 'Church of Scars',
      coverUrl:
        'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/d5/38/ba/d538baf9-3a91-429b-f392-cc1465f0e9ea/18UMGIM13190.rgb.jpg/800x800cc.jpg',
      pageUrl: 'https://www.shazam.com/song/1360212103/white-flag',
    });
  });

  it('ignores the related recordings listed under citation[] (their album/artist are not this song)', () => {
    const page = `<html><head><title>X</title></head><body><script type="application/ld+json">${JSON.stringify({
      '@type': 'MusicRecording',
      name: 'Song A',
      byArtist: 'Artist A',
      url: 'https://www.shazam.com/song/1/song-a',
      citation: [
        { '@type': 'MusicRecording', name: 'Song B', byArtist: 'Artist B', inAlbum: { name: 'Album B' } },
      ],
    })}</script></body></html>`;
    expect(parseShazamPage(page)).toMatchObject({ title: 'Song A', artist: 'Artist A', album: null });
  });

  it('accepts byArtist as object or list, @graph wrappers, array @type and a creator fallback', () => {
    const wrap = (ld: unknown): string =>
      `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    expect(
      parseShazamPage(wrap({ '@graph': [{ '@type': 'BreadcrumbList' }, { '@type': ['Thing', 'MusicRecording'], name: 'T', byArtist: { '@type': 'MusicGroup', name: 'Band' } }] })),
    ).toMatchObject({ title: 'T', artist: 'Band' });
    expect(
      parseShazamPage(wrap({ '@type': 'MusicRecording', name: 'T', byArtist: [{ name: 'A' }, 'B'] })),
    ).toMatchObject({ artist: 'A, B' });
    expect(
      parseShazamPage(wrap({ '@type': 'MusicRecording', name: 'T', creator: { name: 'Maker' } })),
    ).toMatchObject({ artist: 'Maker' });
    expect(parseShazamPage(wrap([{ '@type': 'WebSite' }, { '@type': 'MusicRecording', name: 'T', byArtist: 'A' }]))).toMatchObject({
      title: 'T',
      artist: 'A',
    });
  });

  it('skips a broken JSON-LD block and falls back to og:title ("Title - Artist: …"), decoding entities', () => {
    const page = `<html><head>
      <meta property="og:title" content="Rock &amp; Roll: Part 2 - Some &quot;Band&quot;: Song Lyrics, Music Videos &amp; Concerts"/>
      <meta property='og:image' content='https://img.example/cover.jpg'/>
      </head><body><script type="application/ld+json">{ not json</script></body></html>`;
    expect(parseShazamPage(page)).toEqual({
      title: 'Rock & Roll: Part 2',
      artist: 'Some "Band"',
      album: null,
      coverUrl: 'https://img.example/cover.jpg',
      pageUrl: null,
    });
  });

  it('uses the last " - " of og:title as the artist separator (titles carry " - Remastered")', () => {
    const page = '<meta property="og:title" content="Song - Remastered 2011 - The Artist: Song Lyrics, Music Videos &amp; Concerts"/>';
    expect(parseShazamPage(page)).toMatchObject({ title: 'Song - Remastered 2011', artist: 'The Artist' });
  });

  it('returns null when nothing identifies a song', () => {
    expect(parseShazamPage('<html><head><title>Shazam</title></head><body></body></html>')).toBeNull();
    expect(parseShazamPage('')).toBeNull();
    expect(parseShazamPage('<script type="application/ld+json">{"@type":"MusicRecording"}</script>')).toBeNull();
  });
});

describe('fetchShazamTrack', () => {
  const trackRef = parseShazamLink('https://www.shazam.com/track/404798580?referrer=share')!;

  it('follows Shazam’s own redirect from /track/<key> to /song/<adamId> and sends the verified User-Agent', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect('https://www.shazam.com/song/1360212103/white-flag'))
      .mockResolvedValueOnce(html(WHITE_FLAG_PAGE));

    const info = await fetchShazamTrack(trackRef, fetchImpl);

    expect(info).toMatchObject({ title: 'White Flag', artist: 'Bishop Briggs', album: 'Church of Scars' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchImpl.mock.calls[0];
    expect(String(firstUrl)).toBe('https://www.shazam.com/track/404798580');
    expect(firstInit?.redirect).toBe('manual');
    expect((firstInit?.headers as Record<string, string>)['User-Agent']).toBe(SHAZAM_USER_AGENT);
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://www.shazam.com/song/1360212103/white-flag');
  });

  it('resolves a relative Location header against the current URL', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect('/song/1360212103/white-flag', 302))
      .mockResolvedValueOnce(html(WHITE_FLAG_PAGE));
    await expect(fetchShazamTrack(trackRef, fetchImpl)).resolves.toMatchObject({ title: 'White Flag' });
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://www.shazam.com/song/1360212103/white-flag');
  });

  it('reads a /song/<adamId>/<slug> link directly, at its canonical URL', async () => {
    const ref = parseShazamLink('https://www.shazam.com/it-it/song/1360212103/white-flag?referrer=share')!;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html(WHITE_FLAG_PAGE));
    await expect(fetchShazamTrack(ref, fetchImpl)).resolves.toMatchObject({ artist: 'Bishop Briggs' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://www.shazam.com/song/1360212103/white-flag');
  });

  it('REJECTS the generic page Shazam serves to browser-like agents (200, no redirect, another song)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html(GENERIC_FALLBACK_PAGE));
    const err = await fetchShazamTrack(trackRef, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShazamFetchError);
    expect((err as ShazamFetchError).code).toBe('mismatch');
  });

  it('rejects a page for a different song than the /song/<adamId> that was asked for', async () => {
    const ref = parseShazamLink('https://www.shazam.com/song/111111111/some-other-song')!;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(html(WHITE_FLAG_PAGE));
    await expect(fetchShazamTrack(ref, fetchImpl)).rejects.toMatchObject({ code: 'mismatch' });
  });

  it('never leaves shazam.com: a redirect to another host is refused without fetching it (SSRF guard)', async () => {
    for (const target of [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:8080/api/entries',
      'https://shazam.com.evil.example/song/1360212103',
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect(target));
      await expect(fetchShazamTrack(trackRef, fetchImpl)).rejects.toMatchObject({ code: 'host' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after a few redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => redirect('https://www.shazam.com/track/404798580'));
    await expect(fetchShazamTrack(trackRef, fetchImpl)).rejects.toMatchObject({ code: 'redirect' });
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('reports HTTP errors, network errors and pages without metadata with distinct codes', async () => {
    await expect(
      fetchShazamTrack(trackRef, vi.fn<typeof fetch>().mockResolvedValueOnce(html('nope', 404))),
    ).rejects.toMatchObject({ code: 'status' });
    await expect(
      fetchShazamTrack(trackRef, vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))),
    ).rejects.toMatchObject({ code: 'network' });
    const noMeta = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect('https://www.shazam.com/song/1360212103/white-flag'))
      .mockResolvedValueOnce(html('<html><head><title>Shazam</title></head></html>'));
    await expect(fetchShazamTrack(trackRef, noMeta)).rejects.toMatchObject({ code: 'parse' });
  });

  it('stops downloading once the JSON-LD block is complete (the real page is ~1 MB, the data is in the first ~135 KB)', async () => {
    let cancelled = false;
    let pulled = 0;
    const enc = new TextEncoder();
    const head = enc.encode(WHITE_FLAG_PAGE);
    const filler = enc.encode('x'.repeat(64 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(pulled === 1 ? head : filler);
        if (pulled > 200) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const ref = parseShazamLink('https://www.shazam.com/song/1360212103/white-flag')!;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await expect(fetchShazamTrack(ref, fetchImpl)).resolves.toMatchObject({ title: 'White Flag' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
});
