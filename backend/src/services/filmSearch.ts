import { logInfo, logWarning, logError } from '../utils/logger';
import type { TmdbSearchResult, StreamingUrls } from '../types';

interface TmdbSearchResponse {
  results: Array<{
    id: number;
    title: string;
    release_date?: string;
    poster_path?: string;
  }>;
}

interface TmdbMovieDetails {
  imdb_id: string | null;
  genres?: Array<{ id: number; name: string }>;
  overview?: string | null;
  vote_average?: number;
  credits?: { cast?: Array<{ name: string }> };
}

interface MovieDetails {
  imdbId: string | null;
  genres: string[];
  overview: string | null;
  cast: string[];
  voteAverage: number | null;
}

const EMPTY_DETAILS: MovieDetails = {
  imdbId: null, genres: [], overview: null, cast: [], voteAverage: null,
};

async function getMovieDetails(tmdbId: number, apiKey: string): Promise<MovieDetails> {
  try {
    const response = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=it-IT&append_to_response=credits`
    );
    if (!response.ok) {
      logWarning('TMDb details fallita', { tmdbId, status: response.status });
      return EMPTY_DETAILS;
    }
    const data = (await response.json()) as TmdbMovieDetails;
    return {
      imdbId: data.imdb_id || null,
      genres: (data.genres ?? []).map((g) => g.name),
      overview: data.overview || null,
      cast: (data.credits?.cast ?? []).slice(0, 4).map((c) => c.name),
      voteAverage:
        typeof data.vote_average === 'number' ? Math.round(data.vote_average * 10) / 10 : null,
    };
  } catch (error) {
    logWarning('TMDb details errore', { tmdbId });
    return EMPTY_DETAILS;
  }
}

export async function searchFilm(
  title: string,
  year?: string | null
): Promise<TmdbSearchResult | null> {
  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
      logWarning('TMDB_API_KEY non configurata');
      return null;
    }

    logInfo('Ricerca film su TMDb', { title, year });

    let url = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=it-IT`;
    if (year) url += `&year=${year}`;

    const response = await fetch(url);
    if (!response.ok) {
      logWarning('TMDb search fallita', { status: response.status });
      return null;
    }

    const data = (await response.json()) as TmdbSearchResponse;
    if (!data.results.length) {
      logInfo('Nessun risultato TMDb', { title });
      return null;
    }

    const movie = data.results[0];
    const details = await getMovieDetails(movie.id, apiKey);

    const result: TmdbSearchResult = {
      id: movie.id,
      title: movie.title,
      imdbId: details.imdbId,
      posterPath: movie.poster_path
        ? `https://image.tmdb.org/t/p/w200${movie.poster_path}`
        : null,
      releaseDate: movie.release_date || null,
      genres: details.genres,
      overview: details.overview,
      cast: details.cast,
      voteAverage: details.voteAverage,
    };

    logInfo('Film trovato su TMDb', { title: result.title, imdbId: result.imdbId, enriched: details !== EMPTY_DETAILS });
    return result;
  } catch (error) {
    logError('Errore ricerca TMDb', error);
    return null;
  }
}

export function generateImdbUrl(imdbId: string): string {
  return `https://www.imdb.com/title/${imdbId}/`;
}

export function generateStreamingUrls(title: string): StreamingUrls {
  const q = encodeURIComponent(title);
  return {
    netflix: `https://www.netflix.com/search?q=${q}`,
    primeVideo: `https://www.primevideo.com/search?phrase=${q}`,
    raiPlay: `https://www.raiplay.it/ricerca.html?q=${q}`,
    now: `https://www.nowtv.it/cerca?q=${q}`,
    disneyPlus: `https://www.disneyplus.com/search/${q}`,
    appleTv: `https://tv.apple.com/search?term=${q}`,
  };
}
