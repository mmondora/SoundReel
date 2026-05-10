import type { FastifyInstance } from 'fastify';
import { extractContent, detectPlatform, setLogger as setContentExtractorLogger } from '../services/contentExtractor';
import { recognizeAudio } from '../services/_legacy/audioRecognition';
import { analyzeWithAi, AiAnalysisResponse } from '../services/aiAnalysis';
import { transcribeLocal } from '../services/whisperClient';
import { ocrImages } from '../services/ocrClient';
import { pickKeyFrames } from '../services/frameSelector';
import { describeFramesWithVision } from '../services/ollamaClient';
import { saveThumbnailLocal } from '../services/thumbnailSaver';
import {
  extractPage,
  PageFetchError,
  UnsupportedContentTypeError,
  setLogger as setPageExtractorLogger,
} from '../services/pageExtractor';
import { analyzeWebPage } from '../services/aiAnalysisWebPage';
import { normalizeUrl } from '../services/urlNormalize';
import { SsrfBlockedError } from '../services/ssrfGuard';
import { searchTrack, addToPlaylist, generateYoutubeSearchUrl, generateSoundcloudSearchUrl } from '../services/spotify';
import { searchFilm, generateImdbUrl, generateStreamingUrls } from '../services/filmSearch';
import { mergeResults } from '../services/resultMerger';
import { downloadMedia } from '../services/_legacy/mediaDownloader';
import { transcribeAudio as transcribeAudioLegacyStub } from '../services/_legacy/transcribeAudioStub';
import { enrichWithOpenAI } from '../services/openaiEnrich';
import {
  findEntryByUrl,
  createEntry,
  updateEntry,
  appendActionLog,
  getFeaturesConfig,
  getInstagramConfig,
  getOpenAIConfig,
  getEntry,
} from '../utils/db';
import { createActionLog } from '../utils/logger';
import { Logger } from '../services/debugLogger';
import type {
  Entry,
  Song,
  Film,
  Note,
  ExtractedLink,
  MediaAiAnalysisResult,
  AudioRecognitionResult,
} from '../types';

interface AnalyzeRequestBody {
  url?: string;
  channel?: 'web' | 'telegram';
}

const KEY_FRAMES_COUNT = Number(process.env.KEY_FRAMES_COUNT || 5);

export function registerAnalyzeRoute(app: FastifyInstance): void {
  app.post<{ Body: AnalyzeRequestBody }>('/api/analyze', async (req, reply) => {
    const log = new Logger('analyzeUrl');

    const url = req.body?.url;
    const channel = req.body?.channel ?? 'web';

    if (!url) {
      reply.code(400).send({ error: 'URL richiesto' });
      return;
    }

    const normalizedUrl = normalizeUrl(url);

    try {
      log.startTimer();
      log.info('Inizio analisi URL', { url: normalizedUrl, channel });

      const featuresConfig = await getFeaturesConfig();
      log.info('Features config', {
        cobaltEnabled: featuresConfig.cobaltEnabled,
        allowDuplicateUrls: featuresConfig.allowDuplicateUrls,
        mediaAnalysisEnabled: featuresConfig.mediaAnalysisEnabled,
        transcriptionEnabled: featuresConfig.transcriptionEnabled,
        aiAnalysisEnabled: featuresConfig.aiAnalysisEnabled,
        pageExtractionEnabled: featuresConfig.pageExtractionEnabled,
      });

      if (!featuresConfig.allowDuplicateUrls) {
        const existingEntry = await findEntryByUrl(normalizedUrl);
        if (existingEntry) {
          log.info('URL già processato', { entryId: existingEntry.id });
          reply.send({ success: true, entryId: existingEntry.id, existing: true, entry: existingEntry });
          return;
        }
      }

      const platform = detectPlatform(normalizedUrl);
      const isInstagram = platform === 'instagram';
      const isPage =
        !isInstagram && platform === 'other' && featuresConfig.pageExtractionEnabled;

      const initialEntry: Omit<Entry, 'id' | 'createdAt'> = {
        sourceUrl: normalizedUrl,
        sourcePlatform: platform,
        inputChannel: channel,
        caption: null,
        thumbnailUrl: null,
        mediaUrl: null,
        status: 'processing',
        results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
        actionLog: [createActionLog('url_received', { channel, platform })],
      };

      const entryId = await createEntry(initialEntry);
      log.setEntryId(entryId);
      log.info('Entry creata', {
        entryId,
        path: isInstagram ? 'ig-local' : isPage ? 'page' : 'legacy',
      });
      setContentExtractorLogger(log);

      // ---------------------------------------------------------------------
      // Shared pipeline state (populated by one of: page / IG / legacy branch)
      // ---------------------------------------------------------------------
      let audioResult: AudioRecognitionResult | null = null;
      let aiResponse: AiAnalysisResponse;
      let transcript: string | null = null;
      let transcriptLanguage: string | null = null;
      // Caption used by auto-enrichment at the end.
      let captionForEnrich: string | null = null;

      if (isPage) {
        // ===================================================================
        // PAGE PIPELINE (no media download / no AudD / no Instaloader / no
        // Whisper / no OCR / no vision)
        // ===================================================================
        setPageExtractorLogger(log);
        log.info('Page pipeline');
        try {
          const page = await extractPage(normalizedUrl);
          await appendActionLog(entryId, createActionLog('page_fetched', {
            httpStatus: page.httpStatus,
            finalUrl: page.finalUrl,
            contentType: page.contentType,
          }));
          await appendActionLog(entryId, createActionLog('page_parsed', {
            hasMainText: !!page.mainText,
            mainTextChars: page.mainText?.length || 0,
            linksCount: page.rawLinks.length,
            hasImage: !!page.representativeImageUrl,
          }));

          let persistentThumb: string | null = null;
          if (page.representativeImageUrl) {
            const saved = await saveThumbnailLocal(page.representativeImageUrl, entryId);
            if (saved) {
              persistentThumb = saved.relativeUrl;
              await appendActionLog(entryId, createActionLog('thumbnail_saved', {
                source: 'page_image',
                relativeUrl: saved.relativeUrl,
                sizeBytes: saved.sizeBytes,
              }));
            } else {
              persistentThumb = page.representativeImageUrl;
              await appendActionLog(entryId, createActionLog('thumbnail_save_failed', {
                sourceUrl: page.representativeImageUrl,
              }));
            }
          }

          captionForEnrich = page.description || page.title || null;

          await updateEntry(entryId, {
            caption: captionForEnrich,
            thumbnailUrl: persistentThumb,
            mediaUrl: null,
          });

          if (featuresConfig.aiAnalysisEnabled) {
            aiResponse = await analyzeWebPage(page);
          } else {
            aiResponse = { result: emptyMedia(), usageMetadata: null };
          }
        } catch (e) {
          if (e instanceof SsrfBlockedError) {
            await appendActionLog(entryId, createActionLog('page_ssrf_blocked', {
              hostname: e.hostname,
              reason: e.reason,
            }));
          } else if (e instanceof UnsupportedContentTypeError) {
            await appendActionLog(entryId, createActionLog('page_unsupported_content_type', {
              contentType: e.contentType,
            }));
          } else if (e instanceof PageFetchError) {
            await appendActionLog(entryId, createActionLog('page_fetch_failed', {
              httpStatus: e.httpStatus,
              cause: e.cause,
            }));
          } else {
            await appendActionLog(entryId, createActionLog('page_fetch_failed', {
              cause: String(e),
            }));
          }
          await updateEntry(entryId, { status: 'error' });
          await appendActionLog(entryId, createActionLog('completed', {
            status: 'error',
            reason: 'page_pipeline_failed',
          }));
          const errEntry = await getEntry(entryId);
          reply.send({ success: false, entryId, entry: errEntry, error: String(e) });
          return;
        }
      } else {
        // ===================================================================
        // EXISTING IG + LEGACY PIPELINES
        // ===================================================================
        log.info('Inizio estrazione contenuto');
        const extractOptions: {
          cobaltEnabled: boolean;
          instagramCookies?: { sessionId: string; csrfToken: string; dsUserId: string };
          entryId?: string;
        } = { cobaltEnabled: featuresConfig.cobaltEnabled };

        if (isInstagram) {
          extractOptions.entryId = entryId;
        }

        const content = await extractContent(normalizedUrl, extractOptions);
        log.info('Estrazione contenuto completata', {
          hasCaption: content.hasCaption,
          hasAudio: content.hasAudio,
          hasThumbnail: !!content.thumbnailUrl || !!content.localPaths?.thumbnailPath,
          slides: content.localPaths?.slidePaths.length ?? content.carouselUrls.length,
          frames: content.localPaths?.framePaths.length ?? 0,
        });

        if (isInstagram) {
          const dlError = (content as { __downloadError?: string | null }).__downloadError;
          const downloadFailed = !!dlError;
          await appendActionLog(entryId, createActionLog('instaloader_download', {
            status: downloadFailed ? 'error' : 'ok',
            error: dlError || null,
            hasCaption: content.hasCaption,
            hasVideo: !!content.localPaths?.videoPath,
            hasAudio: !!content.localPaths?.audioPath,
            hasThumbnail: !!content.localPaths?.thumbnailPath,
            slides: content.localPaths?.slidePaths.length ?? 0,
            frames: content.localPaths?.framePaths.length ?? 0,
            hasMusicInfo: !!content.musicInfo,
          }));
          if (downloadFailed) {
            await updateEntry(entryId, { status: 'error' });
            await appendActionLog(entryId, createActionLog('completed', {
              status: 'error',
              reason: 'instaloader_download_failed',
              error: dlError,
            }));
            const entryErr = await getEntry(entryId);
            reply.send({ success: false, entryId, entry: entryErr, error: dlError });
            return;
          }
        } else {
          await appendActionLog(entryId, createActionLog('content_extracted', {
            hasAudio: content.hasAudio,
            hasCaption: content.hasCaption,
            hasThumbnail: !!content.thumbnailUrl,
          }));
        }

        // -------------------------------------------------------------------
        // Thumbnail persistence (both IG and legacy): download/copy to local
        // -------------------------------------------------------------------
        let persistentThumb: string | null = null;

        if (isInstagram && content.localPaths?.thumbnailPath) {
          // Already local — just resize in place via saveThumbnailLocal reading from disk
          const saved = await saveThumbnailLocal(content.localPaths.thumbnailPath, entryId);
          if (saved) {
            persistentThumb = saved.relativeUrl;
            await appendActionLog(entryId, createActionLog('thumbnail_saved', {
              source: 'local',
              relativeUrl: saved.relativeUrl,
              sizeBytes: saved.sizeBytes,
            }));
          }
        } else if (!isInstagram && content.thumbnailUrl) {
          const saved = await saveThumbnailLocal(content.thumbnailUrl, entryId);
          if (saved) {
            persistentThumb = saved.relativeUrl;
            await appendActionLog(entryId, createActionLog('thumbnail_saved', {
              source: 'remote',
              relativeUrl: saved.relativeUrl,
              sizeBytes: saved.sizeBytes,
            }));
          } else {
            // Fallback: keep original URL
            persistentThumb = content.thumbnailUrl;
            await appendActionLog(entryId, createActionLog('thumbnail_save_failed', {
              sourceUrl: content.thumbnailUrl,
            }));
          }
        }

        captionForEnrich = content.caption;

        await updateEntry(entryId, {
          caption: content.caption,
          thumbnailUrl: persistentThumb,
          mediaUrl: content.videoUrl || content.audioUrl || null,
        });

        if (isInstagram) {
        // ======= IG LOCAL PIPELINE =======
        const localPaths = content.localPaths;

        // Whisper ASR on local audio
        if (featuresConfig.transcriptionEnabled && localPaths?.audioPath) {
          const asr = await transcribeLocal(localPaths.audioPath);
          transcript = asr.text;
          transcriptLanguage = asr.language;
          await appendActionLog(entryId, createActionLog('whisper_asr', {
            status: asr.status,
            reason: asr.reason || null,
            language: asr.language,
            chars: asr.text?.length || 0,
            durationMs: asr.durationMs,
          }));
          if (transcript) await updateEntry(entryId, { 'results.transcript': transcript });
        } else {
          await appendActionLog(entryId, createActionLog('whisper_asr', {
            status: 'skipped',
            reason: !featuresConfig.transcriptionEnabled ? 'disabled in settings' : 'no audio path',
          }));
        }

        // OCR on frames + slides
        const ocrPaths = [
          ...(localPaths?.framePaths ?? []),
          ...(localPaths?.slidePaths ?? []),
        ];
        const ocr = await ocrImages(ocrPaths);
        await appendActionLog(entryId, createActionLog('ocr_extract', {
          status: ocr.status,
          reason: ocr.reason || null,
          imagesSent: ocrPaths.length,
          withText: ocr.perImage.filter((r) => r.text).length,
          mergedChars: ocr.merged.length,
        }));

        // Vision describe on key frames (only if mediaAnalysisEnabled + frames present)
        let visualContext: string | null = null;
        if (featuresConfig.mediaAnalysisEnabled && localPaths?.framePaths.length) {
          const keyFrames = pickKeyFrames(localPaths.framePaths, KEY_FRAMES_COUNT);
          visualContext = await describeFramesWithVision(keyFrames);
          await appendActionLog(entryId, createActionLog('vision_describe', {
            frames: keyFrames.length,
            chars: visualContext?.length || 0,
            provider: 'ollama-moondream',
          }));
        } else {
          await appendActionLog(entryId, createActionLog('vision_describe', {
            status: 'skipped',
            reason: !featuresConfig.mediaAnalysisEnabled ? 'disabled in settings' : 'no frames',
          }));
        }

        // Multimodal LLM analysis
        if (featuresConfig.aiAnalysisEnabled) {
          aiResponse = await analyzeWithAi({
            caption: content.caption,
            musicInfo: content.musicInfo,
            transcript,
            transcriptLanguage,
            ocrText: ocr.merged || null,
            visualContext,
            slidePaths: localPaths?.slidePaths ?? [],
            thumbnailPath: localPaths?.thumbnailPath ?? null,
          });
        } else {
          aiResponse = { result: emptyMedia(), usageMetadata: null };
        }

        // Music: musicInfo Instagram only (authoritative, no AudD)
        if (content.musicInfo) {
          audioResult = {
            title: content.musicInfo.title,
            artist: content.musicInfo.artist,
            album: null,
          };
          await appendActionLog(entryId, createActionLog('audio_analyzed', {
            provider: 'instagram_metadata',
            found: true,
            title: content.musicInfo.title,
            artist: content.musicInfo.artist,
          }));
        } else {
          await appendActionLog(entryId, createActionLog('audio_analyzed', {
            provider: 'instagram_metadata',
            found: false,
            reason: 'no music_info in IG metadata',
          }));
        }
      } else {
        // ======= LEGACY PIPELINE (non-IG) =======
        let media = null;
        if (featuresConfig.mediaAnalysisEnabled && content.audioUrl) {
          log.info('Download media remoto (legacy)');
          try {
            media = await downloadMedia(content.audioUrl);
            if (media) {
              await appendActionLog(entryId, createActionLog('media_downloaded', {
                mimeType: media.mimeType,
                sizeBytes: media.sizeBytes,
              }));
            } else {
              await appendActionLog(entryId, createActionLog('media_download_skipped', {
                reason: 'too_large_or_failed',
              }));
            }
          } catch (dlError) {
            log.warn('Errore download media', { error: String(dlError) });
            await appendActionLog(entryId, createActionLog('media_download_failed', { error: String(dlError) }));
          }
        }

        if (featuresConfig.transcriptionEnabled) {
          try {
            const tr = await transcribeAudioLegacyStub(media, content.audioUrl || content.videoUrl);
            transcript = tr.transcript;
            await appendActionLog(entryId, createActionLog('transcribe', {
              status: tr.status,
              reason: tr.reason || null,
              transcriptLength: transcript?.length || 0,
              durationMs: tr.durationMs,
            }));
            if (transcript) await updateEntry(entryId, { 'results.transcript': transcript });
          } catch (e) {
            await appendActionLog(entryId, createActionLog('transcribe', { status: 'error', error: String(e) }));
          }
        } else {
          await appendActionLog(entryId, createActionLog('transcribe', { status: 'skipped', reason: 'disabled in settings' }));
        }

        // Legacy: AudD cloud + AI multimodal (without local OCR/vision)
        const [auddResult, aiRes] = await Promise.all([
          content.audioUrl ? recognizeAudio(content.audioUrl) : Promise.resolve(null),
          featuresConfig.aiAnalysisEnabled
            ? analyzeWithAi({
                caption: content.caption,
                musicInfo: null,
                transcript,
                transcriptLanguage: null,
                ocrText: null,
                visualContext: null,
                slidePaths: [],
                thumbnailPath: null,
              })
            : Promise.resolve({ result: emptyMedia(), usageMetadata: null }),
        ]);

        aiResponse = aiRes;

        if (auddResult) {
          audioResult = auddResult;
          await appendActionLog(entryId, createActionLog('audio_analyzed', {
            provider: 'audd',
            found: true,
            title: auddResult.title,
            artist: auddResult.artist,
          }));
        } else if (content.audioUrl) {
          await appendActionLog(entryId, createActionLog('audio_analyzed', { provider: 'audd', found: false }));
        }
        }
      }

      // ---------------------------------------------------------------------
      // AI log + result merge (shared)
      // ---------------------------------------------------------------------
      const aiResult = aiResponse.result;
      const aiAnalyzedDetails: Record<string, unknown> = featuresConfig.aiAnalysisEnabled
        ? {
            provider: 'ollama',
            songs: aiResult.songs.length,
            films: aiResult.films.length,
            notes: aiResult.notes.length,
            links: aiResult.links.length,
            tags: aiResult.tags.length,
          }
        : { status: 'skipped', reason: 'disabled in settings' };
      if (aiResponse.usageMetadata) aiAnalyzedDetails.tokenUsage = aiResponse.usageMetadata;
      await appendActionLog(entryId, createActionLog('ai_analyzed', aiAnalyzedDetails));

      const merged = mergeResults(audioResult, aiResult);

      const songs: Song[] = [];
      for (const songData of merged.songs) {
        const spotifyResult = await searchTrack(songData.title, songData.artist);
        let addedToPlaylist = false;
        if (spotifyResult) {
          addedToPlaylist = await addToPlaylist(spotifyResult.uri);
          if (addedToPlaylist) {
            await appendActionLog(entryId, createActionLog('spotify_added', {
              track: spotifyResult.name,
              artist: spotifyResult.artist,
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
          soundcloudUrl: generateSoundcloudSearchUrl(songData.title, songData.artist),
          addedToPlaylist,
        });
      }

      const films: Film[] = [];
      for (const filmData of merged.films) {
        const tmdbResult = await searchFilm(filmData.title, filmData.year);
        await appendActionLog(entryId, createActionLog('film_found', {
          title: filmData.title,
          provider: 'tmdb',
          found: !!tmdbResult,
        }));
        films.push({
          title: filmData.title,
          director: filmData.director,
          year: filmData.year || tmdbResult?.releaseDate?.split('-')[0] || null,
          imdbUrl: tmdbResult?.imdbId ? generateImdbUrl(tmdbResult.imdbId) : null,
          posterUrl: tmdbResult?.posterPath || null,
          streamingUrls: generateStreamingUrls(filmData.title),
        });
      }

      const notes: Note[] = merged.notes;
      const links: ExtractedLink[] = merged.links.map((l) => {
        let domain: string | null = null;
        try {
          domain = new URL(l.url).hostname.replace(/^www\./, '');
        } catch {
          domain = null;
        }
        return {
          ...l,
          domain,
          faviconUrl: domain
            ? `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`
            : null,
        };
      });
      const tags: string[] = merged.tags;
      const summary: string | null = merged.summary;

      const mediaAiResult = aiResult as MediaAiAnalysisResult;
      const transcription = mediaAiResult.transcription || null;
      const visualContextOut = mediaAiResult.visualContext || null;
      const overlayText = mediaAiResult.overlayText || null;

      if (transcription || visualContextOut || overlayText) {
        await appendActionLog(entryId, createActionLog('media_analysis_complete', {
          hasTranscription: !!transcription,
          hasVisualContext: !!visualContextOut,
          hasOverlayText: !!overlayText,
        }));
      }

      const results: Record<string, unknown> = { songs, films, notes, links, tags, summary };
      if (transcript) results.transcript = transcript;
      if (transcription) results.transcription = transcription;
      if (visualContextOut) results.visualContext = visualContextOut;
      if (overlayText) results.overlayText = overlayText;

      await updateEntry(entryId, {
        status: 'completed',
        results: results as unknown as Entry['results'],
      });

      await appendActionLog(entryId, createActionLog('completed', {
        totalSongs: songs.length,
        totalFilms: films.length,
        totalNotes: notes.length,
        totalLinks: links.length,
        totalTags: tags.length,
        addedToPlaylist: songs.filter((s) => s.addedToPlaylist).length,
      }));

      if (featuresConfig.autoEnrichEnabled) {
        try {
          const openaiConfig = await getOpenAIConfig();
          if (openaiConfig.enabled && openaiConfig.apiKey) {
            const entryResults = { songs, films, notes, links, tags, summary: summary ?? null };
            const enrichments = await enrichWithOpenAI(entryResults, captionForEnrich);
            if (enrichments.length > 0) {
              await updateEntry(entryId, { 'results.enrichments': enrichments });
              await appendActionLog(entryId, createActionLog('auto_enriched', {
                provider: 'openai',
                items: enrichments.length,
                links: enrichments.reduce((sum, i) => sum + i.links.length, 0),
              }));
              results.enrichments = enrichments;
            }
          }
        } catch (enrichError) {
          log.warn('Auto-enrichment fallito', { error: String(enrichError) });
          await appendActionLog(entryId, createActionLog('auto_enrich_failed', { error: String(enrichError) }));
        }
      }

      const entry = await getEntry(entryId);
      reply.send({ success: true, entryId, entry });
    } catch (error) {
      log.error('Errore durante analisi', error instanceof Error ? error : new Error(String(error)));
      reply.code(500).send({ success: false, error: error instanceof Error ? error.message : 'Errore interno' });
    }
  });
}

function emptyMedia(): MediaAiAnalysisResult {
  return {
    songs: [],
    films: [],
    notes: [],
    links: [],
    tags: [],
    summary: null,
    transcription: null,
    visualContext: null,
    overlayText: null,
  };
}

// Suppress unused-import warning; getInstagramConfig was used for cookie fallback (legacy only)
void getInstagramConfig;
