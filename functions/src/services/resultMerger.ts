import type { Song, Film, Note, ExtractedLink, AudioRecognitionResult, AiAnalysisResult } from '../types';
import { logInfo } from '../utils/logger';

interface MergedResults {
  songs: Array<{
    title: string;
    artist: string;
    album: string | null;
    source: 'audio_fingerprint' | 'ai_analysis' | 'both';
  }>;
  films: Array<{
    title: string;
    director: string | null;
    year: string | null;
  }>;
  notes: Note[];
  links: ExtractedLink[];
  tags: string[];
}

function normalizeSongKey(title: string, artist: string): string {
  return `${title.toLowerCase().trim()}|${artist.toLowerCase().trim()}`;
}

function normalizeFilmKey(title: string): string {
  return title.toLowerCase().trim();
}

export function mergeResults(
  audioResult: AudioRecognitionResult | null,
  aiResult: AiAnalysisResult
): MergedResults {
  const songsMap = new Map<string, MergedResults['songs'][0]>();
  const filmsMap = new Map<string, MergedResults['films'][0]>();

  if (audioResult) {
    const key = normalizeSongKey(audioResult.title, audioResult.artist);
    songsMap.set(key, {
      title: audioResult.title,
      artist: audioResult.artist,
      album: audioResult.album,
      source: 'audio_fingerprint'
    });
  }

  for (const song of aiResult.songs) {
    if (!song.title || !song.artist) continue;

    const key = normalizeSongKey(song.title, song.artist);
    const existing = songsMap.get(key);

    if (existing) {
      existing.source = 'both';
      if (!existing.album && song.album) {
        existing.album = song.album;
      }
    } else {
      songsMap.set(key, {
        title: song.title,
        artist: song.artist,
        album: song.album,
        source: 'ai_analysis'
      });
    }
  }

  for (const film of aiResult.films) {
    if (!film.title) continue;

    const key = normalizeFilmKey(film.title);
    if (!filmsMap.has(key)) {
      filmsMap.set(key, {
        title: film.title,
        director: film.director,
        year: film.year
      });
    }
  }

  const mergedSongs = Array.from(songsMap.values());
  const mergedFilms = Array.from(filmsMap.values());

  logInfo('Risultati merged', {
    totalSongs: mergedSongs.length,
    totalFilms: mergedFilms.length,
    audioOnly: mergedSongs.filter(s => s.source === 'audio_fingerprint').length,
    aiOnly: mergedSongs.filter(s => s.source === 'ai_analysis').length,
    both: mergedSongs.filter(s => s.source === 'both').length,
    notes: aiResult.notes.length,
    links: aiResult.links.length,
    tags: aiResult.tags.length
  });

  return {
    songs: mergedSongs,
    films: mergedFilms,
    notes: aiResult.notes,
    links: aiResult.links,
    tags: aiResult.tags
  };
}

export function createEmptySong(): Song {
  return {
    title: '',
    artist: '',
    album: null,
    source: 'ai_analysis',
    spotifyUri: null,
    spotifyUrl: null,
    youtubeUrl: null,
    addedToPlaylist: false
  };
}

export function createEmptyFilm(): Film {
  return {
    title: '',
    director: null,
    year: null,
    imdbUrl: null,
    posterUrl: null
  };
}
