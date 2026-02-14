import { onRequest } from 'firebase-functions/v2/https';
import { extractContent, detectPlatform, setLogger as setContentExtractorLogger } from './services/contentExtractor';
import { recognizeAudio, auddApiKey } from './services/audioRecognition';
import { analyzeWithAi, geminiApiKey, AiAnalysisResponse } from './services/aiAnalysis';
import { searchTrack, addToPlaylist, generateYoutubeSearchUrl, spotifyClientId, spotifyClientSecret } from './services/spotify';
import { searchFilm, generateImdbUrl, tmdbApiKey } from './services/filmSearch';
import { mergeResults } from './services/resultMerger';
import { downloadMedia } from './services/mediaDownloader';
import { transcribeAudio } from './services/transcribeAudio';
import { enrichWithOpenAI } from './services/openaiEnrich';
import { findEntryByUrl, createEntry, updateEntry, appendActionLog, getFeaturesConfig, getInstagramConfig, getOpenAIConfig } from './utils/firestore';
import { createActionLog } from './utils/logger';
import { Logger } from './services/debugLogger';
import type { Entry, Song, Film, Note, ExtractedLink, MediaAiAnalysisResult } from './types';

interface AnalyzeRequest {
  url: string;
  channel?: 'web' | 'telegram';
}

export const analyzeUrl = onRequest(
  {
    region: 'europe-west1',
    timeoutSeconds: 300,
    memory: '1GiB',
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
        mediaUrl: null,
        status: 'processing',
        results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
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
        // Load Instagram cookies if platform is Instagram
        const extractOptions: { cobaltEnabled: boolean; instagramCookies?: { sessionId: string; csrfToken: string; dsUserId: string } } = {
          cobaltEnabled: featuresConfig.cobaltEnabled
        };
        if (platform === 'instagram') {
          const igConfig = await getInstagramConfig();
          if (igConfig.enabled && igConfig.sessionId && igConfig.csrfToken && igConfig.dsUserId) {
            extractOptions.instagramCookies = {
              sessionId: igConfig.sessionId,
              csrfToken: igConfig.csrfToken,
              dsUserId: igConfig.dsUserId
            };
            log.info('Cookie Instagram abilitati');
          } else {
            log.debug('Cookie Instagram non configurati o disabilitati');
          }
        }
        content = await extractContent(url, extractOptions);
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
        thumbnailUrl: content.thumbnailUrl,
        mediaUrl: content.videoUrl || content.audioUrl || null
      });

      // Step 3.5: Download media for deep analysis if enabled
      let media = null;
      if (featuresConfig.mediaAnalysisEnabled && content.audioUrl) {
        log.info('Download media per analisi approfondita');
        try {
          media = await downloadMedia(content.audioUrl);
          if (media) {
            await appendActionLog(entryId, createActionLog('media_downloaded', {
              mimeType: media.mimeType,
              sizeBytes: media.sizeBytes
            }));
          } else {
            await appendActionLog(entryId, createActionLog('media_download_skipped', {
              reason: 'too_large_or_failed'
            }));
          }
        } catch (dlError) {
          log.warn('Errore download media, continuo senza', {
            error: dlError instanceof Error ? dlError.message : String(dlError)
          });
          await appendActionLog(entryId, createActionLog('media_download_failed', {
            error: dlError instanceof Error ? dlError.message : String(dlError)
          }));
        }
      }

      // Step 3.7: Trascrizione audio dedicata (Gemini STT)
      let transcript: string | null = null;
      if (featuresConfig.transcriptionEnabled) {
        try {
          log.info('Inizio trascrizione audio');
          const transcriptionResult = await transcribeAudio(
            media,
            content.audioUrl || content.videoUrl,
            undefined,
            featuresConfig.useVertexAi
          );
          transcript = transcriptionResult.transcript;

          const transcribeDetails: Record<string, unknown> = {
            status: transcriptionResult.status,
            reason: transcriptionResult.reason || null,
            transcriptLength: transcript?.length || 0,
            durationMs: transcriptionResult.durationMs
          };
          if (transcriptionResult.usageMetadata) {
            transcribeDetails.tokenUsage = transcriptionResult.usageMetadata;
          }
          await appendActionLog(entryId, createActionLog('transcribe', transcribeDetails));

          if (transcript) {
            await updateEntry(entryId, { 'results.transcript': transcript });
            log.info('Trascrizione completata', { length: transcript.length });
          } else {
            log.info('Trascrizione: nessun parlato trovato o step skippato', {
              status: transcriptionResult.status,
              reason: transcriptionResult.reason
            });
          }
        } catch (transcribeError) {
          log.warn('Errore trascrizione, continuo senza', {
            error: transcribeError instanceof Error ? transcribeError.message : String(transcribeError)
          });
          await appendActionLog(entryId, createActionLog('transcribe', {
            status: 'error',
            error: transcribeError instanceof Error ? transcribeError.message : String(transcribeError)
          }));
        }
      } else {
        log.info('Trascrizione disabilitata nelle impostazioni');
        await appendActionLog(entryId, createActionLog('transcribe', {
          status: 'skipped',
          reason: 'disabled in settings'
        }));
      }

      // Step 4 & 5: Audio recognition e AI analysis in parallelo
      const emptyAiResponse: AiAnalysisResponse = {
        result: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
        usageMetadata: null
      };

      const [auddResult, aiResponse] = await Promise.all([
        content.audioUrl ? recognizeAudio(content.audioUrl) : Promise.resolve(null),
        featuresConfig.aiAnalysisEnabled
          ? analyzeWithAi(content.caption, content.thumbnailUrl, media, transcript, featuresConfig.useVertexAi)
          : Promise.resolve(emptyAiResponse)
      ]);
      const aiResult = aiResponse.result;

      // Use AudD result, or fall back to Instagram music metadata
      let audioResult = auddResult;
      if (auddResult) {
        await appendActionLog(entryId, createActionLog('audio_analyzed', {
          provider: 'audd',
          found: true,
          title: auddResult.title,
          artist: auddResult.artist
        }));
      } else if (content.musicInfo) {
        audioResult = {
          title: content.musicInfo.title,
          artist: content.musicInfo.artist,
          album: null
        };
        await appendActionLog(entryId, createActionLog('audio_analyzed', {
          provider: 'instagram_metadata',
          found: true,
          title: content.musicInfo.title,
          artist: content.musicInfo.artist
        }));
      } else if (content.audioUrl) {
        await appendActionLog(entryId, createActionLog('audio_analyzed', {
          provider: 'audd',
          found: false
        }));
      }

      const aiAnalyzedDetails: Record<string, unknown> = featuresConfig.aiAnalysisEnabled
        ? {
            provider: featuresConfig.useVertexAi ? 'vertex_ai' : 'google_ai_studio',
            songs: aiResult.songs.length,
            films: aiResult.films.length,
            notes: aiResult.notes.length,
            links: aiResult.links.length,
            tags: aiResult.tags.length
          }
        : {
            status: 'skipped',
            reason: 'disabled in settings'
          };
      if (aiResponse.usageMetadata) {
        aiAnalyzedDetails.tokenUsage = aiResponse.usageMetadata;
      }
      await appendActionLog(entryId, createActionLog('ai_analyzed', aiAnalyzedDetails));

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

      // Step 9: Prepara notes, links, tags, summary + media analysis fields
      const notes: Note[] = merged.notes;
      const links: ExtractedLink[] = merged.links;
      const tags: string[] = merged.tags;
      const summary: string | null = merged.summary;

      // Extract media analysis fields if present
      const mediaAiResult = aiResult as MediaAiAnalysisResult;
      const transcription = mediaAiResult.transcription || null;
      const visualContext = mediaAiResult.visualContext || null;
      const overlayText = mediaAiResult.overlayText || null;

      if (transcription || visualContext || overlayText) {
        await appendActionLog(entryId, createActionLog('media_analysis_complete', {
          hasTranscription: !!transcription,
          hasVisualContext: !!visualContext,
          hasOverlayText: !!overlayText
        }));
      }

      // Step 10: Aggiorna entry con risultati finali
      const results: Record<string, unknown> = { songs, films, notes, links, tags, summary };
      if (transcript) results.transcript = transcript;
      if (transcription) results.transcription = transcription;
      if (visualContext) results.visualContext = visualContext;
      if (overlayText) results.overlayText = overlayText;

      await updateEntry(entryId, {
        status: 'completed',
        results
      });

      await appendActionLog(entryId, createActionLog('completed', {
        totalSongs: songs.length,
        totalFilms: films.length,
        totalNotes: notes.length,
        totalLinks: links.length,
        totalTags: tags.length,
        addedToPlaylist: songs.filter(s => s.addedToPlaylist).length
      }));

      // Step 11: Auto-enrichment (if enabled)
      if (featuresConfig.autoEnrichEnabled) {
        try {
          const openaiConfig = await getOpenAIConfig();
          if (openaiConfig.enabled && openaiConfig.apiKey) {
            log.info('Auto-enrichment iniziato');
            const entryResults = { songs, films, notes, links, tags, summary: summary ?? null };
            const enrichments = await enrichWithOpenAI(entryResults, content.caption);

            if (enrichments.length > 0) {
              await updateEntry(entryId, {
                'results.enrichments': enrichments
              });
              await appendActionLog(entryId, createActionLog('auto_enriched', {
                provider: 'openai',
                items: enrichments.length,
                links: enrichments.reduce((sum, item) => sum + item.links.length, 0)
              }));
              results.enrichments = enrichments;
              log.info('Auto-enrichment completato', { items: enrichments.length });
            }
          } else {
            log.info('Auto-enrichment saltato: OpenAI non configurato');
          }
        } catch (enrichError) {
          log.warn('Auto-enrichment fallito, non bloccante', {
            error: enrichError instanceof Error ? enrichError.message : String(enrichError)
          });
          await appendActionLog(entryId, createActionLog('auto_enrich_failed', {
            error: enrichError instanceof Error ? enrichError.message : String(enrichError)
          }));
        }
      }

      log.info('Analisi completata', {
        entryId,
        songs: songs.length,
        films: films.length,
        notes: notes.length,
        links: links.length,
        tags: tags.length
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
          mediaUrl: content.videoUrl || content.audioUrl || null,
          status: 'completed',
          results
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
