import { describe, expect, it, vi } from 'vitest';
import {
  parseSpotifyLink,
  canonicalSpotifyUrl,
  isSpotifyShortLink,
  resolveSpotifyShortLink,
} from './spotifyLink';

const ID = '22kBlINGUYm2rc1Wd7RPfw';

describe('parseSpotifyLink', () => {
  it('canonicalizes the real shared link (si + utm params)', () => {
    const ref = parseSpotifyLink(`https://open.spotify.com/track/${ID}?si=6840D4mBRcW8-6xkWXS8wA&utm_source=copy-link`);
    expect(ref).toEqual({ kind: 'track', id: ID, url: `https://open.spotify.com/track/${ID}` });
  });

  it.each([
    ['album', 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3'],
    ['playlist', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
  ])('accepts %s links', (kind, url) => {
    expect(parseSpotifyLink(url)?.kind).toBe(kind);
  });

  it('strips locale and embed prefixes', () => {
    expect(canonicalSpotifyUrl(`https://open.spotify.com/intl-it/track/${ID}`)).toBe(`https://open.spotify.com/track/${ID}`);
    expect(canonicalSpotifyUrl(`https://open.spotify.com/embed/track/${ID}`)).toBe(`https://open.spotify.com/track/${ID}`);
    expect(canonicalSpotifyUrl(`http://open.spotify.com/intl-pt-br/album/${ID}?x=1#frag`)).toBe(`https://open.spotify.com/album/${ID}`);
  });

  it('accepts spotify: URIs', () => {
    expect(canonicalSpotifyUrl(`spotify:track:${ID}`)).toBe(`https://open.spotify.com/track/${ID}`);
  });

  it.each([
    'https://open.spotify.com/',
    'https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg',
    'https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk',
    'https://open.spotify.com/track/',
    'https://open.spotify.com.evil.example/track/' + ID,
    'https://example.com/open.spotify.com/track/' + ID,
    'spotify:artist:' + ID,
    'not a url',
    '',
  ])('rejects %s', (input) => {
    expect(parseSpotifyLink(input)).toBeNull();
  });
});

describe('short links', () => {
  it('recognizes Spotify short-link hosts only', () => {
    expect(isSpotifyShortLink('https://spotify.link/abc123')).toBe(true);
    expect(isSpotifyShortLink('https://link.tospotify.com/abc')).toBe(true);
    expect(isSpotifyShortLink('https://evil.example/spotify.link')).toBe(false);
  });

  it('follows redirects to the canonical URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `https://open.spotify.com/track/${ID}?si=zz` } })) as unknown as typeof fetch;
    await expect(resolveSpotifyShortLink('https://spotify.link/abc', fetchImpl)).resolves.toBe(`https://open.spotify.com/track/${ID}`);
  });

  it('refuses to follow a redirect to a non-Spotify host (SSRF guard)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })) as unknown as typeof fetch;
    await expect(resolveSpotifyShortLink('https://spotify.link/abc', fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('extracts the target from an HTML landing page', async () => {
    const html = `<html><a href="https://open.spotify.com/intl-it/album/${ID}?si=q">open</a></html>`;
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(html, { status: 200 })) as unknown as typeof fetch;
    await expect(resolveSpotifyShortLink('https://spotify.link/abc', fetchImpl)).resolves.toBe(`https://open.spotify.com/album/${ID}`);
  });
});
