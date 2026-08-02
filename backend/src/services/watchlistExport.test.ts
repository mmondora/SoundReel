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
});
