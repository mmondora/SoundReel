import { describe, it, expect } from 'vitest';
import { renderWatchlistHtml } from './watchlistExport';
import type { AggregatedFilm } from '../types';

function film(overrides: Partial<AggregatedFilm> = {}): AggregatedFilm {
  return {
    filmKey: 'metropolis::1927',
    title: 'Metropolis',
    director: 'Fritz Lang',
    year: '1927',
    imdbUrl: 'https://www.imdb.com/title/tt0017136/',
    posterUrl: 'https://image.tmdb.org/t/p/w200/poster.jpg',
    streamingUrls: {
      netflix: 'https://www.netflix.com/search?q=Metropolis',
      primeVideo: 'https://www.primevideo.com/search?phrase=Metropolis',
      raiPlay: 'https://www.raiplay.it/ricerca.html?q=Metropolis',
      now: 'https://www.nowtv.it/cerca?q=Metropolis',
      disneyPlus: 'https://www.disneyplus.com/search/Metropolis',
      appleTv: 'https://tv.apple.com/search?term=Metropolis',
    },
    mentions: [{ entryId: 'e1', createdAt: '2026-08-01T00:00:00Z' }],
    meta: null,
    ...overrides,
  } as AggregatedFilm;
}

describe('renderWatchlistHtml', () => {
  it('renders a self-contained document with the film title', () => {
    const html = renderWatchlistHtml([film()]);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Metropolis');
    expect(html).toContain('Fritz Lang');
    expect(html).toContain('1927');
    // Self-contained: no external stylesheet or script.
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('<script src=');
  });

  it('includes every platform link', () => {
    const html = renderWatchlistHtml([film()]);
    expect(html).toContain('netflix.com/search?q=Metropolis');
    expect(html).toContain('primevideo.com/search?phrase=Metropolis');
    expect(html).toContain('raiplay.it/ricerca.html?q=Metropolis');
    expect(html).toContain('nowtv.it/cerca?q=Metropolis');
    expect(html).toContain('disneyplus.com/search/Metropolis');
    expect(html).toContain('tv.apple.com/search?term=Metropolis');
  });

  it('renders a film with no streaming data at all', () => {
    const html = renderWatchlistHtml([film({ streamingUrls: null, posterUrl: null, director: null, year: null })]);
    expect(html).toContain('Metropolis');
  });

  it('escapes HTML metacharacters in titles', () => {
    const html = renderWatchlistHtml([film({ title: 'Fear & <Loathing>' })]);
    expect(html).toContain('Fear &amp; &lt;Loathing&gt;');
    expect(html).not.toContain('<Loathing>');
  });

  it('marks a film downloaded to the archive', () => {
    const html = renderWatchlistHtml([
      film({
        meta: {
          iaDownloadedPath: '/films/Metropolis (1927).mp4',
          iaPageUrl: 'https://archive.org/details/metropolis',
        } as AggregatedFilm['meta'],
      }),
    ]);
    expect(html).toContain('archive.org/details/metropolis');
  });

  it('renders an empty list without crashing', () => {
    const html = renderWatchlistHtml([]);
    expect(html).toContain('<!doctype html>');
  });

  it('sorts films alphabetically by title', () => {
    const html = renderWatchlistHtml([
      film({ filmKey: 'z::1', title: 'Zabriskie Point' }),
      film({ filmKey: 'a::2', title: 'Amarcord' }),
    ]);
    expect(html.indexOf('Amarcord')).toBeLessThan(html.indexOf('Zabriskie Point'));
  });

  it('rejects a javascript: poster URL and falls back to the no-poster placeholder', () => {
    const html = renderWatchlistHtml([film({ posterUrl: 'javascript:alert(1)' })]);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<div class="noposter">');
  });

  it('omits imdbUrl and archive links entirely when they use a javascript: scheme', () => {
    const html = renderWatchlistHtml([
      film({
        imdbUrl: 'javascript:alert(1)',
        meta: { iaPageUrl: 'javascript:alert(1)' } as AggregatedFilm['meta'],
      }),
    ]);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('>IMDb<');
    expect(html).not.toContain('>Archive<');
  });

  it('neutralizes a quote-breakout payload in a URL without breaking out of the attribute', () => {
    const payload = 'https://x/"><script>alert(1)</script>';
    const html = renderWatchlistHtml([film({ posterUrl: payload })]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('renders deep links from meta.streamingOptions when present, in preference to the search links', () => {
    const html = renderWatchlistHtml([
      film({
        meta: {
          streamingOptions: [
            {
              platform: 'Netflix',
              type: 'SUBSCRIPTION',
              is_free: false,
              price: null,
              url: 'https://www.netflix.com/watch/12345',
            },
          ],
        } as AggregatedFilm['meta'],
      }),
    ]);
    expect(html).toContain('href="https://www.netflix.com/watch/12345"');
    expect(html).toContain('>Netflix<');
    expect(html).not.toContain('netflix.com/search?q=Metropolis');
  });

  it('falls back to the generic search links when meta.streamingOptions is empty', () => {
    const html = renderWatchlistHtml([
      film({ meta: { streamingOptions: [] } as unknown as AggregatedFilm['meta'] }),
    ]);
    expect(html).toContain('netflix.com/search?q=Metropolis');
  });

  it('falls back to the generic search links when meta is absent entirely', () => {
    const html = renderWatchlistHtml([film({ meta: null })]);
    expect(html).toContain('netflix.com/search?q=Metropolis');
  });

  it('rejects a javascript: URL carried by a streamingOptions entry', () => {
    const html = renderWatchlistHtml([
      film({
        meta: {
          streamingOptions: [
            { platform: 'Evil', type: 'FREE', is_free: true, price: null, url: 'javascript:alert(1)' },
          ],
        } as AggregatedFilm['meta'],
      }),
    ]);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('>Evil<');
  });

  it('still renders well-formed https URLs for poster, imdb and archive links', () => {
    const html = renderWatchlistHtml([
      film({
        posterUrl: 'https://image.tmdb.org/t/p/w200/poster.jpg',
        imdbUrl: 'https://www.imdb.com/title/tt0017136/',
        meta: { iaPageUrl: 'https://archive.org/details/metropolis' } as AggregatedFilm['meta'],
      }),
    ]);
    expect(html).toContain('src="https://image.tmdb.org/t/p/w200/poster.jpg"');
    expect(html).toContain('>IMDb<');
    expect(html).toContain('archive.org/details/metropolis');
    expect(html).toContain('>Archive<');
  });
});
