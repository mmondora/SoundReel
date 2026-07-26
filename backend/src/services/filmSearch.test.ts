import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { searchFilm } from './filmSearch';
import * as logger from '../utils/logger';

const SEARCH_RESPONSE = {
  results: [{ id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: '/p.jpg' }],
};
const DETAILS_RESPONSE = {
  imdb_id: 'tt0113277',
  genres: [{ id: 28, name: 'Azione' }, { id: 80, name: 'Crime' }],
  overview: 'Un detective ossessionato...',
  vote_average: 7.916,
  credits: {
    cast: [
      { name: 'Al Pacino' }, { name: 'Robert De Niro' }, { name: 'Val Kilmer' },
      { name: 'Jon Voight' }, { name: 'Tom Sizemore' },
    ],
  },
};

describe('searchFilm', () => {
  beforeEach(() => {
    process.env.TMDB_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => SEARCH_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => DETAILS_RESPONSE }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TMDB_API_KEY;
  });

  it('captures genres, overview, top-4 cast and vote average', async () => {
    const result = await searchFilm('Heat', '1995');
    expect(result).not.toBeNull();
    expect(result?.genres).toEqual(['Azione', 'Crime']);
    expect(result?.overview).toBe('Un detective ossessionato...');
    expect(result?.cast).toEqual(['Al Pacino', 'Robert De Niro', 'Val Kilmer', 'Jon Voight']);
    expect(result?.voteAverage).toBe(7.9);
    expect(result?.imdbId).toBe('tt0113277');
  });

  it('requests credits and italian language on the details call', async () => {
    await searchFilm('Heat', '1995');
    const detailsUrl = vi.mocked(fetch).mock.calls[1][0] as string;
    expect(detailsUrl).toContain('append_to_response=credits');
    expect(detailsUrl).toContain('language=it-IT');
  });

  it('returns empty enrichment when the details call fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => SEARCH_RESPONSE })
      .mockResolvedValueOnce({ ok: false, status: 500 }));
    const result = await searchFilm('Heat', '1995');
    expect(result?.genres).toEqual([]);
    expect(result?.cast).toEqual([]);
    expect(result?.voteAverage).toBeNull();
    expect(result?.imdbId).toBeNull();
  });

  it('logs warning when details call fails and enriched: false in final log', async () => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => SEARCH_RESPONSE })
      .mockResolvedValueOnce({ ok: false, status: 500 }));
    await searchFilm('Heat', '1995');
    expect(vi.mocked(logger.logWarning)).toHaveBeenCalledWith('TMDb details fallita', { tmdbId: 949, status: 500 });
    expect(vi.mocked(logger.logInfo)).toHaveBeenCalledWith('Film trovato su TMDb', expect.objectContaining({ enriched: false }));
  });
});
