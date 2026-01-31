import { defineSecret } from 'firebase-functions/params';
import { logInfo, logWarning, logError } from '../utils/logger';
import type { TmdbSearchResult } from '../types';

const tmdbApiKey = defineSecret('TMDB_API_KEY');

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
}

export async function searchFilm(
  title: string,
  year?: string | null
): Promise<TmdbSearchResult | null> {
  try {
    const apiKey = tmdbApiKey.value();
    if (!apiKey) {
      logWarning('TMDB_API_KEY non configurata');
      return null;
    }

    logInfo('Ricerca film su TMDb', { title, year });

    let url = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=it-IT`;
    if (year) {
      url += `&year=${year}`;
    }

    const response = await fetch(url);

    if (!response.ok) {
      logWarning('TMDb search fallita', { status: response.status });
      return null;
    }

    const data = await response.json() as TmdbSearchResponse;

    if (!data.results.length) {
      logInfo('Nessun risultato TMDb', { title });
      return null;
    }

    const movie = data.results[0];

    const imdbId = await getImdbId(movie.id, apiKey);

    const result: TmdbSearchResult = {
      id: movie.id,
      title: movie.title,
      imdbId,
      posterPath: movie.poster_path
        ? `https://image.tmdb.org/t/p/w200${movie.poster_path}`
        : null,
      releaseDate: movie.release_date || null
    };

    logInfo('Film trovato su TMDb', { title: result.title, imdbId: result.imdbId });
    return result;
  } catch (error) {
    logError('Errore ricerca TMDb', error);
    return null;
  }
}

async function getImdbId(tmdbId: number, apiKey: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}`
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as TmdbMovieDetails;
    return data.imdb_id || null;
  } catch {
    return null;
  }
}

export function generateImdbUrl(imdbId: string): string {
  return `https://www.imdb.com/title/${imdbId}/`;
}

export { tmdbApiKey };
