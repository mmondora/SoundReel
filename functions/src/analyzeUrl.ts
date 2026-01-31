import { onRequest } from 'firebase-functions/v2/https';
import { extractContent, detectPlatform, setLogger as setContentExtractorLogger } from './services/contentExtractor';
import { recognizeAudio, auddApiKey } from './services/audioRecognition';
import { analyzeWithAi, geminiApiKey } from './services/aiAnalysis';
import { searchTrack, addToPlaylist, generateYoutubeSearchUrl, spotifyClientId, spotifyClientSecret } from './services/spotify';
import { searchFilm, generateImdbUrl, tmdbApiKey } from './services/filmSearch';
import { mergeResults } from './services/resultMerger';
import { findEntryByUrl, createEntry, updateEntry, appendActionLog, getFeaturesConfig } from './utils/firestore';
import { createActionLog } from './utils/logger';
import { Logger } from './services/debugLogger';
import type { Entry, Song, Film } from './types';

interface AnalyzeRequest {
  url: string;
  channel?: 'web' | 'telegram';
}

export const analyzeUrl = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 120,
    memory: '512MiB',
    secrets: [auddApiKey, geminiApiKey, spotifyClientId, spotifyClientSecret, tmdbApiKey],
    cors: true
  },
  async (req, res) => {
    // Create logger instance per request (not shared between requests)
    const log = new Logger('analyzeUrl');

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo non consentito' });
      return;
    }

    const { url, channel = 'web' } = req.body as AnalyzeRequest;

    if (!url) {
      res.status(400).json({ error: 'URL richiesto' });
      return;
    }

    try {
      log.startTimer();
      log.info('Inizio analisi URL', { url, channel });

      // Get features config early for idempotency check
      const featuresConfig = await getFeaturesConfig();
      log.info('Features config', {
        cobaltEnabled: featuresConfig.cobaltEnabled,
        allowDuplicateUrls: featuresConfig.allowDuplicateUrls
      });

      // Step 1: Idempotenza - verifica se già processato (skip if allowDuplicateUrls)
      if (!featuresConfig.allowDuplicateUrls) {
        const existingEntry = await findEntryByUrl(url);
        if (existingEntry) {
          log.info('URL già processato', { entryId: existingEntry.id });
          res.json({
            success: true,
            entryId: existingEntry.id,
            existing: true,
            entry: existingEntry
          });
          return;
        }
      } else {
        log.info('Idempotenza disabilitata, procedo con nuova analisi');
      }

      // Step 2: Crea entry iniziale
      const platform = detectPlatform(url);
      const initialEntry: Omit<Entry, 'id'> = {
        sourceUrl: url,
        sourcePlatform: platform,
        inputChannel: channel,
        caption: null,
        thumbnailUrl: null,
        status: 'processing',
        results: { songs: [], films: [] },
        actionLog: [createActionLog('url_received', { channel, platform })],
        createdAt: ''
      };

      const entryId = await createEntry(initialEntry);
      log.setEntryId(entryId);
      log.info('Entry creata', { entryId });

      // Share logger with contentExtractor for proper context
      setContentExtractorLogger(log);

      // Step 3: Estrai contenuto
      log.info('Inizio estrazione contenuto');
      let content;
      try {
        content = await extractContent(url, { cobaltEnabled: featuresConfig.cobaltEnabled });
        log.info('Estrazione contenuto completata', {
          hasCaption: content.hasCaption,
          hasAudio: content.hasAudio,
          hasThumbnail: !!content.thumbnailUrl
        });
      } catch (extractError) {
        log.error('ERRORE durante estrazione contenuto',
          extractError instanceof Error ? extractError : new Error(String(extractError)),
          { url, errorType: typeof extractError, errorString: String(extractError) }
        );
        throw extractError;
      }
      await appendActionLog(entryId, createActionLog('content_extracted', {
        hasAudio: content.hasAudio,
        hasCaption: content.hasCaption,
        hasThumbnail: !!content.thumbnailUrl
      }));

      await updateEntry(entryId, {
        caption: content.caption,
        thumbnailUrl: content.thumbnailUrl
      });

      // Step 4 & 5: Audio recognition e AI analysis in parallelo
      const [audioResult, aiResult] = await Promise.all([
        content.audioUrl ? recognizeAudio(content.audioUrl) : Promise.resolve(null),
        analyzeWithAi(content.caption, content.thumbnailUrl)
      ]);

      if (audioResult) {
        await appendActionLog(entryId, createActionLog('audio_analyzed', {
          provider: 'audd',
          found: true,
          title: audioResult.title,
          artist: audioResult.artist
        }));
      } else if (content.audioUrl) {
        await appendActionLog(entryId, createActionLog('audio_analyzed', {
          provider: 'audd',
          found: false
        }));
      }

      await appendActionLog(entryId, createActionLog('ai_analyzed', {
        provider: 'gemini',
        songs: aiResult.songs.length,
        films: aiResult.films.length
      }));

      // Step 6: Merge risultati
      const merged = mergeResults(audioResult, aiResult);

      // Step 7: Spotify - cerca e aggiungi a playlist
      const songs: Song[] = [];
      for (const songData of merged.songs) {
        const spotifyResult = await searchTrack(songData.title, songData.artist);
        let addedToPlaylist = false;

        if (spotifyResult) {
          addedToPlaylist = await addToPlaylist(spotifyResult.uri);
          if (addedToPlaylist) {
            await appendActionLog(entryId, createActionLog('spotify_added', {
              track: spotifyResult.name,
              artist: spotifyResult.artist
            }));
          }
        }

        songs.push({
          title: songData.title,
          artist: songData.artist,
          album: songData.album,
          source: songData.source,
          spotifyUri: spotifyResult?.uri || null,
          spotifyUrl: spotifyResult?.url || null,
          youtubeUrl: generateYoutubeSearchUrl(songData.title, songData.artist),
          addedToPlaylist
        });
      }

      // Step 8: TMDb - cerca film
      const films: Film[] = [];
      for (const filmData of merged.films) {
        const tmdbResult = await searchFilm(filmData.title, filmData.year);

        await appendActionLog(entryId, createActionLog('film_found', {
          title: filmData.title,
          provider: 'tmdb',
          found: !!tmdbResult
        }));

        films.push({
          title: filmData.title,
          director: filmData.director,
          year: filmData.year || tmdbResult?.releaseDate?.split('-')[0] || null,
          imdbUrl: tmdbResult?.imdbId ? generateImdbUrl(tmdbResult.imdbId) : null,
          posterUrl: tmdbResult?.posterPath || null
        });
      }

      // Step 9: Aggiorna entry con risultati finali
      await updateEntry(entryId, {
        status: 'completed',
        results: { songs, films }
      });

      await appendActionLog(entryId, createActionLog('completed', {
        totalSongs: songs.length,
        totalFilms: films.length,
        addedToPlaylist: songs.filter(s => s.addedToPlaylist).length
      }));

      log.info('Analisi completata', {
        entryId,
        songs: songs.length,
        films: films.length
      });

      res.json({
        success: true,
        entryId,
        entry: {
          id: entryId,
          sourceUrl: url,
          sourcePlatform: platform,
          inputChannel: channel,
          caption: content.caption,
          thumbnailUrl: content.thumbnailUrl,
          status: 'completed',
          results: { songs, films }
        }
      });
    } catch (error) {
      log.error('Errore durante analisi', error instanceof Error ? error : new Error(String(error)));
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Errore interno'
      });
    }
  }
);
