import type { FastifyInstance } from 'fastify';
import { extractContent, detectPlatform, setLogger as setContentExtractorLogger } from '../services/contentExtractor';
import { recognizeAudio } from '../services/_legacy/audioRecognition';
import { analyzeWithAi, extractFromSlides, AiAnalysisResponse } from '../services/aiAnalysis';
import type { SlideItem } from '../services/aiAnalysis';
import { ocrImages } from '../services/ocrClient';
import type { OcrResult } from '../services/ocrClient';
import { pickKeyFrames } from '../services/frameSelector';
import { describeFramesWithVision } from '../services/ollamaClient';
import { saveThumbnailLocal } from '../services/thumbnailSaver';
import {
  extractPage,
  PageFetchError,
  PageShellError,
  UnsupportedContentTypeError,
  setLogger as setPageExtractorLogger,
} from '../services/pageExtractor';
import { isAnalysisInFlight } from '../services/entryLock';
import { analyzeWebPage } from '../services/aiAnalysisWebPage';
import { normalizeUrl } from '../services/urlNormalize';
import { analyzeSlides } from '../services/slideAnalysis';
import { extractSongsFromMainText } from '../services/musicListExtractor';
import { resolveSongs } from '../services/songResolver';
import { SsrfBlockedError } from '../services/ssrfGuard';
import { searchTrack, addToPlaylist, generateYoutubeSearchUrl, generateSoundcloudSearchUrl } from '../services/spotify';
import { searchFilm, generateImdbUrl, generateStreamingUrls } from '../services/filmSearch';
import { filmKey, upsertFilmEnrichment, getFilmMeta } from '../services/filmMeta';
import { streamingConfigured } from '../services/streamingAvailability';
import { refreshStreamingForFilm, isStale } from '../services/streamingRefresher';
import { resolvedToSongs, appendSongsToEntry } from '../services/songPersistence';
import { enqueueSongEnrichment } from '../services/songEnrichmentHook';
import { enqueueNoteEnrichment } from '../services/noteEnrichmentHook';
import { noteKey } from '../services/noteMeta';
import { mergeResults } from '../services/resultMerger';
import { mergeEntryResults, songKey, filmTitleKey } from '../services/entryMerge';
import { rebuildLocalPaths } from '../services/localMedia';
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
import { createActionLog, logError } from '../utils/logger';
import { enqueueJob } from '../utils/jobQueue';
import { chooseTranscriptSource } from '../services/transcriptSource';
import { Logger } from '../services/debugLogger';
import { scanFullAudio, resolveYoutubeUrl } from '../services/shazamClient';
import type { ShazamTrack } from '../services/shazamClient';
import type {
  Entry,
  EntryResults,
  ExtractedContent,
  Song,
  Film,
  Note,
  ExtractedLink,
  MediaAiAnalysisResult,
  AudioRecognitionResult,
  EntrySlide,
} from '../types';

interface AnalyzeRequestBody {
  url?: string;
  channel?: 'web' | 'telegram' | 'ios';
  user?: string | null;
  /**
   * Second analysis pass over an entry that already has results — typically
   * fired once a deferred transcription has landed.
   *
   * It changes three things: the idempotency short-circuit below is skipped
   * (otherwise the pass would be a silent no-op on a `completed` entry), the
   * media is rebuilt from disk instead of downloaded again, and the results
   * are merged into what is already there instead of replacing it.
   */
  reanalyze?: boolean;
  /**
   * Download and extract, but make no ollama call: no vision pass, no AI
   * analysis. A later batched pass does that work with the model already warm.
   *
   * A repair run is spaced by tens of minutes so Instagram does not challenge
   * the account, while ollama keeps a single model resident for 90 seconds.
   * Analysing inline therefore means one GPU wake-up and two model swaps per
   * job — the queue teardown that hangs this APU (see the 2026-09-01
   * MES investigation). Subtractive only: OCR, Shazam and the transcription
   * queue are untouched, since none of them reach ollama.
   */
  skipAi?: boolean;
  /**
   * Which entry the second pass belongs to. Only read when `reanalyze` is set.
   *
   * A re-analysis is always fired *about a row we already have* — the job that
   * fires it carries that row's id — so resolving it by URL was an unnecessary
   * round trip through `normalizeUrl`, and the round trip does not always come
   * back: 183 of the 882 stored `source_url` values predate the current
   * normaliser and do not re-normalise to themselves (a path that kept its
   * trailing slash before the query string, an `igsh` value whose `==` is now
   * re-encoded to `%3D%3D`). For those the lookup missed, the route answered
   * 404, and a transcript that had already been written was never analysed.
   *
   * Resolving by id also removes a second, latent hazard: `findEntryByUrl`
   * ends in `ORDER BY created_at DESC LIMIT 1`, so if duplicate URLs were ever
   * allowed the pass could land on a different row than the one transcribed.
   *
   * Optional, and the URL lookup stays as the fallback, because jobs enqueued
   * before this field existed are still sitting in `job_queue` and must keep
   * working.
   */
  entryId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY_FRAMES_COUNT = Number(process.env.KEY_FRAMES_COUNT || 5);

/**
 * A single-image post is analysed as a one-page carousel only when its image
 * carried at least this much text — enough to be an infographic rather than a
 * photo with an incidental watermark.
 */
const SINGLE_IMAGE_OCR_MIN_CHARS = 120;

/** TTL (days) before a film's cached streaming availability is refetched by the pipeline hook. */
const STREAMING_TTL_DAYS = Number(process.env.STREAMING_TTL_DAYS || 30);

/**
 * Resolves the year to persist on a Film (and to key its film_meta enrichment
 * row with) once, from the same inputs used to call searchFilm: the extractor's
 * own year if present, otherwise the year TMDb resolved. Both the persisted
 * `Film.year` and the `filmKey(...)` used for `upsertFilmEnrichment` MUST use
 * this same value — otherwise the enrichment row is keyed under a different
 * year than the one GET /api/films looks it up with, and the join silently
 * never matches.
 */
export function resolveFilmYear(
  extractedYear: string | number | null | undefined,
  tmdbReleaseDate: string | null | undefined
): string | null {
  // extractedYear is typed as string at every call site, but films are
  // parsed from AI-model JSON (not schema-validated) and can carry a
  // numeric year at runtime — coerce so downstream filmKey() computation
  // doesn't diverge based on JS type coercion quirks.
  const normalizedYear =
    typeof extractedYear === 'number' ? String(extractedYear) : extractedYear;
  return normalizedYear || tmdbReleaseDate?.split('-')[0] || null;
}

/**
 * True when a TMDb details lookup returned actual enrichment data (genres
 * and/or an overview). searchFilm() falls back to EMPTY_DETAILS (empty
 * genres, null overview) when the TMDb details call fails but the search
 * itself succeeded — in that case tmdbResult is truthy but carries nothing
 * worth persisting. Upserting it anyway would overwrite any enrichment a
 * previous, successful run already stored for this film. Mirrors the same
 * guard used by the backfill script (backfillFilmMeta.ts).
 */
export function hasEnrichmentData<T extends { genres: string[]; overview: string | null }>(
  tmdb: T | null | undefined
): tmdb is T {
  return !!tmdb && (tmdb.genres.length > 0 || !!tmdb.overview);
}

export function registerAnalyzeRoute(app: FastifyInstance): void {
  app.post<{ Body: AnalyzeRequestBody }>('/api/analyze', async (req, reply) => {
    const log = new Logger('analyzeUrl');

    const url = req.body?.url;
    const channel = req.body?.channel ?? 'web';
    const user = req.body?.user ?? null;
    const reanalyze = req.body?.reanalyze === true;
    // Download only: leave every ollama call to a later batched pass.
    //
    // A repair batch is spaced by tens of minutes so Instagram does not
    // challenge the account again, and ollama keeps one model resident for 90
    // seconds with MAX_LOADED_MODELS=1. Analysing inline therefore wakes the
    // GPU once per job and switches models twice — the queue teardown that
    // hangs this APU. The deferred pass runs them back to back, hot.
    const skipAi = req.body?.skipAi === true;
    // Read on every pass, not just a re-analysis. A queued job always knows
    // which row it is about; deriving that row from the URL instead is how a
    // repair job came to fix a *different* one — see the branch below.
    const requestedEntryId = req.body?.entryId;

    if (!url) {
      reply.code(400).send({ error: 'URL richiesto' });
      return;
    }

    // `getEntry` parameterises the id straight into a `uuid` column, so a
    // malformed one is a Postgres type error (a 500) rather than a miss.
    // Reject it here, where it is a client mistake with a name.
    if (requestedEntryId !== undefined && !UUID_RE.test(requestedEntryId)) {
      reply.code(400).send({ success: false, error: 'entryId non valido' });
      return;
    }

    const normalizedUrl = normalizeUrl(url);

    let entryId: string | null = null;
    // The entry as it stood before this pass. Only a re-analysis reads it: it
    // supplies the caption and the transcript the pass must work from, and the
    // status to put back if the pass is abandoned or throws. Declared out here
    // so the catch at the bottom can reach it.
    let priorEntry: Entry | null = null;
    try {
      log.startTimer();
      log.info('Inizio analisi URL', { url: normalizedUrl, channel });

      const storedFeatures = await getFeaturesConfig();
      // `skipAi` only ever subtracts. Audio recognition and OCR stay on: they
      // reach Shazam and the OCR sidecar, not ollama.
      const featuresConfig = skipAi
        ? { ...storedFeatures, aiAnalysisEnabled: false }
        : storedFeatures;
      log.info('Features config', {
        cobaltEnabled: featuresConfig.cobaltEnabled,
        allowDuplicateUrls: featuresConfig.allowDuplicateUrls,
        mediaAnalysisEnabled: featuresConfig.mediaAnalysisEnabled,
        transcriptionEnabled: featuresConfig.transcriptionEnabled,
        aiAnalysisEnabled: featuresConfig.aiAnalysisEnabled,
        pageExtractionEnabled: featuresConfig.pageExtractionEnabled,
      });

      if (reanalyze) {
        // A re-analysis never creates an entry and never returns early on a
        // `completed` one — that short-circuit is exactly what it exists to
        // bypass.
        //
        // By id when the caller supplied one (every job does since the field
        // was added), by URL only for jobs enqueued before that. See the
        // `entryId` field's doc for why the URL route is not reliable.
        priorEntry = requestedEntryId !== undefined
          ? await getEntry(requestedEntryId)
          : await findEntryByUrl(normalizedUrl);
        if (!priorEntry) {
          // Both keys are logged: which one was used is the first thing worth
          // knowing when a second pass 404s.
          log.warn('reanalyze su entry sconosciuta', {
            entryId: requestedEntryId ?? null,
            url: normalizedUrl,
          });
          reply.code(404).send({ success: false, error: 'reanalyze: entry non trovata' });
          return;
        }
        entryId = priorEntry.id;
      } else {
        // By id when the caller has one, by URL only when it does not.
        //
        // Two rows can hold the same post — the stored URLs differ by a
        // trailing slash or an `igsh` whose `==` is now re-encoded — and
        // `findEntryByUrl` hands back whichever one normalises to the request.
        // A repair job then downloaded onto the twin, reported success, and
        // left the row it was queued for sitting in `error` with its job
        // marked done: 8 of the 108 entries in the 2026-09 repair batch, none
        // of which any later run would have picked up, since the job was gone.
        //
        // The URL lookup stays for the callers that genuinely have no id: the
        // web form, the Telegram webhook, and jobs enqueued before the field
        // existed.
        const existingEntry = requestedEntryId !== undefined
          ? await getEntry(requestedEntryId)
          : !featuresConfig.allowDuplicateUrls
            ? await findEntryByUrl(normalizedUrl)
            : null;
        if (existingEntry) {
          // Una passata viva su questa riga vince su chi arriva dopo.
          //
          // La route non aveva nessuna mutua esclusione: due analisi sullo
          // stesso entry si sovrascrivevano e vinceva l'ultima che scriveva,
          // non la migliore. Il 2026-09-12 su un link Reddit due retry partiti
          // nello stesso minuto hanno fatto esattamente questo — una passata
          // aveva estratto il post via RSS, l'altra ha ripiegato sull'HTML e
          // ci ha scritto sopra "Reddit" e "...".
          //
          // 409 e non 200: il worker legge lo status e rimette il job in coda
          // con il suo backoff, invece di chiuderlo come riuscito.
          if (isAnalysisInFlight(existingEntry)) {
            log.info('Analisi già in corso, rifiuto la seconda', { entryId: existingEntry.id });
            reply.code(409).send({
              success: false,
              entryId: existingEntry.id,
              error: 'analisi già in corso su questa entry',
            });
            return;
          }
          if (existingEntry.status === 'completed') {
            log.info('URL già processato', { entryId: existingEntry.id });
            reply.send({ success: true, entryId: existingEntry.id, existing: true, entry: existingEntry });
            return;
          }
          // Not completed (processing/error) — reuse entryId and re-process
          log.info('URL presente, riprocesso', { entryId: existingEntry.id, status: existingEntry.status });
          entryId = existingEntry.id;
        } else if (requestedEntryId !== undefined) {
          // The row was deleted between enqueue and dispatch. Creating a fresh
          // one is the honest outcome — the URL is still worth analysing — but
          // it is worth saying so out loud.
          log.warn('entryId richiesto ma riga assente, ne creo una nuova', { entryId: requestedEntryId });
        }
      }

      const platform = detectPlatform(normalizedUrl);
      const isInstagram = platform === 'instagram';
      // Page pipeline for all non-IG, non-media-streaming platforms when enabled.
      // Media platforms (youtube/tiktok/vimeo/soundcloud/twitch) keep the legacy
      // pipeline so oEmbed + audio extraction still run.
      const MEDIA_PLATFORMS = new Set(['youtube', 'tiktok', 'vimeo', 'soundcloud', 'twitch']);
      const isPage = !isInstagram && !MEDIA_PLATFORMS.has(platform) && featuresConfig.pageExtractionEnabled;

      const initialEntry: Omit<Entry, 'id' | 'createdAt'> = {
        sourceUrl: normalizedUrl,
        sourcePlatform: platform,
        inputChannel: channel,
        inputUser: user,
        caption: null,
        thumbnailUrl: null,
        mediaUrl: null,
        status: 'processing',
        results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
        actionLog: [createActionLog('url_received', { channel, user, platform })],
      };

      if (!entryId) {
        entryId = await createEntry(initialEntry);
      } else if (reanalyze) {
        // Deliberately does not write inputUser: a backfill job carries
        // inputUser = null, which would blank whoever originally sent the URL.
        await updateEntry(entryId, { status: 'processing' });
        await appendActionLog(entryId, createActionLog('reanalyze_started', {
          channel,
          platform,
          hasTranscript: !!priorEntry?.results?.transcript,
        }));
      } else {
        await updateEntry(entryId, { status: 'processing', inputUser: user });
        await appendActionLog(entryId, createActionLog('url_received', { channel, user, platform, retry: true }));
      }
      log.setEntryId(entryId);
      log.info('Entry creata', {
        entryId,
        path: isInstagram ? 'ig-local' : isPage ? 'page' : 'legacy',
        reanalyze,
      });
      setContentExtractorLogger(log);

      // ---------------------------------------------------------------------
      // Shared pipeline state (populated by one of: page / IG / legacy branch)
      // ---------------------------------------------------------------------
      let audioResult: AudioRecognitionResult | null = null;
      let shazamTracks: ShazamTrack[] = [];
      let aiResponse: AiAnalysisResponse;
      let transcript: string | null = null;
      let transcriptLanguage: string | null = null;
      // Caption used by auto-enrichment at the end.
      let captionForEnrich: string | null = null;
      let slideItems: SlideItem[] = [];
      let entrySlides: EntrySlide[] = [];
      // Hoisted so the fire-and-forget below can reuse mainText without re-fetching
      let pageMainText: string | null = null;
      // Hoisted because the transcribe job is enqueued after this pass's
      // results are persisted (see below), by which point `localPaths` — set
      // inside the IG/local-media branch — has gone out of scope. Carries
      // only what that decision needs: whether a local .wav exists.
      let transcribeAudioPath: string | null = null;
      // Una traccia scritta che la sorgente portava gia' con se'. Catturata
      // qui per la stessa ragione di `transcribeAudioPath`: `content` esce
      // di scope prima che la decisione venga presa.
      let sourceSubtitle: { text: string; lang: string | null; kind: string | null } | null = null;
      // Whether this pass ran the IG/local-media branch at all — the legacy
      // and page pipelines never had a `whisper_asr` action (the legacy path
      // logs its own `transcribe` action instead), and that must stay true
      // regardless of where the enqueue decision itself is made.
      let ranLocalMediaPipeline = false;

      if (priorEntry) {
        // The whole point of the second pass: feed the model the transcript the
        // deferred job stored on the entry. Without this the pass would re-run
        // the analysis with exactly the inputs the first one had.
        transcript = priorEntry.results?.transcript ?? null;
        transcriptLanguage = priorEntry.results?.transcriptLanguage ?? null;
      }

      if (isPage) {
        // ===================================================================
        // PAGE PIPELINE (no media download / no AudD / no Instaloader / no
        // Whisper / no OCR / no vision)
        // ===================================================================
        setPageExtractorLogger(log);
        log.info('Page pipeline');

        // A second pass never fetches, on this branch either. Unreachable today
        // — only dispatchTranscribe sets the flag, and a page entry has no audio
        // so never gets a transcribe job — but "never fetch on a reanalyse" must
        // not be a guarantee that holds by accident of who happens to set the
        // flag. Document ingestion is specced and will create entries from URLs.
        //
        // There is nothing to re-analyse from: unlike the media path, the page
        // pipeline persists no local copy of what it fetched, so it abandons the
        // way an Instagram pass with an empty media directory does — and never
        // reaches the caption and thumbnail overwrite below.
        if (reanalyze) {
          await appendActionLog(entryId, createActionLog('reanalyze', {
            status: 'skipped',
            reason: 'page pipeline: nothing on disk to re-analyse',
          }));
          await updateEntry(entryId, { status: priorEntry?.status ?? 'error' });
          const skipped = await getEntry(entryId);
          reply.send({ success: false, entryId, entry: skipped, error: 'no local media' });
          return;
        }

        try {
          const page = await extractPage(normalizedUrl);
          pageMainText = page.mainText;
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
            persistentThumb = await persistThumbnail({
              source: 'page_image',
              entryId,
              pathOrUrl: page.representativeImageUrl,
              fallbackToSource: true,
            });
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
            aiResponse = { result: emptyMedia(), usageMetadata: null, fallback: null };
          }
        } catch (e) {
          if (e instanceof SsrfBlockedError) {
            await appendActionLog(entryId, createActionLog('page_ssrf_blocked', {
              hostname: e.hostname,
              reason: e.reason,
            }));
          } else if (e instanceof PageShellError) {
            // Non un errore di rete: la pagina è arrivata, ma senza contenuto
            // perché il sito lo nega a chi non è loggato. Loggato con il suo
            // nome perché la cura è diversa — una sessione, non un retry.
            await appendActionLog(entryId, createActionLog('page_shell_detected', {
              site: e.site,
              title: e.title,
              reason: 'login wall o anti-bot: nessun contenuto da analizzare',
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
          // 502, non 200: il worker decide "riprovare o chiudere" dallo status
          // HTTP, e un 200 con `success: false` chiudeva il job come riuscito.
          // Stessa classe di bug gia' corretta sul ramo Instagram.
          reply.code(502).send({ success: false, entryId, entry: errEntry, error: 'page_pipeline_failed' });
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

        // entryId enables the local-download paths (IG via instaloader,
        // YouTube/TikTok via yt-dlp); other platforms just ignore it.
        extractOptions.entryId = entryId;

        let content: ExtractedContent;
        if (reanalyze) {
          // Never re-download. extractContent() calls downloadWithInstaloader
          // unconditionally — it has no "already have it" branch — so routing
          // a second pass through it would re-fetch the post from Instagram,
          // which CLAUDE.md forbids precisely because it gets accounts banned.
          // Everything the pass needs the first one already left on disk.
          const local = await rebuildLocalPaths(entryId);
          if (!local) {
            // Abandon rather than fall back to downloading: better an entry
            // without a second pass than an unrequested fetch.
            await appendActionLog(entryId, createActionLog('reanalyze', {
              status: 'skipped',
              reason: 'no local media to re-analyse',
            }));
            await updateEntry(entryId, { status: priorEntry?.status ?? 'error' });
            const skipped = await getEntry(entryId);
            reply.send({ success: false, entryId, entry: skipped, error: 'no local media' });
            return;
          }
          content = {
            caption: priorEntry?.caption ?? null,
            thumbnailUrl: null,
            audioUrl: null,
            videoUrl: null,
            hasAudio: !!local.audioPath,
            hasCaption: !!priorEntry?.caption,
            musicInfo: null,
            carouselUrls: [],
            localPaths: local,
          };
        } else {
          content = await extractContent(normalizedUrl, extractOptions);
        }
        // Catturato qui, prima che i rami si separino: una traccia scritta puo'
        // arrivare anche sul percorso legacy — un video troppo lungo da
        // scaricare ne ha comunque una — e legarla al ramo media significava
        // perderla proprio nei casi dove Whisper costerebbe di piu'.
        sourceSubtitle = content.subtitleText
          ? {
              text: content.subtitleText,
              lang: content.subtitleLang ?? null,
              kind: content.subtitleKind ?? null,
            }
          : null;

        log.info('Estrazione contenuto completata', {
          hasCaption: content.hasCaption,
          hasAudio: content.hasAudio,
          hasThumbnail: !!content.thumbnailUrl || !!content.localPaths?.thumbnailPath,
          slides: content.localPaths?.slidePaths.length ?? content.carouselUrls.length,
          frames: content.localPaths?.framePaths.length ?? 0,
        });

        if (reanalyze) {
          // Not an `instaloader_download` entry: nothing was downloaded, and
          // the journal must not claim otherwise.
          await appendActionLog(entryId, createActionLog('reanalyze_local_media', {
            hasCaption: content.hasCaption,
            hasVideo: !!content.localPaths?.videoPath,
            hasAudio: !!content.localPaths?.audioPath,
            hasThumbnail: !!content.localPaths?.thumbnailPath,
            slides: content.localPaths?.slidePaths.length ?? 0,
            frames: content.localPaths?.framePaths.length ?? 0,
          }));
        } else if (isInstagram) {
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
            // 502, not 200. The queue worker decides "retry or done" from the
            // HTTP status: a 200 with `success: false` made every failed
            // Instagram download a *completed* job, so an expired session
            // produced one warning message and then permanent silence — no
            // retry, ever, not even after the session was renewed. The body is
            // unchanged: the worker reads `error` off it to tell an auth
            // failure (long backoff) from an ordinary one.
            reply.code(502).send({ success: false, entryId, entry: entryErr, error: dlError });
            return;
          }
        } else {
          await appendActionLog(entryId, createActionLog('content_extracted', {
            hasAudio: content.hasAudio,
            hasCaption: content.hasCaption,
            hasThumbnail: !!content.thumbnailUrl || !!content.localPaths?.thumbnailPath,
            localMedia: !!(content.localPaths?.videoPath || content.localPaths?.audioPath),
            frames: content.localPaths?.framePaths.length ?? 0,
          }));
        }

        // yt-dlp gave YouTube/TikTok the same local layout as IG; when the
        // download succeeded, run the full local pipeline instead of legacy.
        const hasLocalMedia = !!(
          content.localPaths &&
          (content.localPaths.videoPath || content.localPaths.audioPath)
        );

        captionForEnrich = content.caption;

        // A re-analysis skips this block entirely. It has nothing new to write:
        // the caption came from the entry itself, re-persisting the thumbnail
        // would re-encode thumbnail.jpg from thumbnail.jpg for no gain, and
        // mediaUrl would be blanked — content.videoUrl and content.audioUrl are
        // null by construction on that path.
        if (!reanalyze) {
          // -----------------------------------------------------------------
          // Thumbnail persistence (both IG and legacy): download/copy to local
          // -----------------------------------------------------------------
          let persistentThumb: string | null = null;

          if (content.localPaths?.thumbnailPath) {
            // Already local (IG or yt-dlp) — just resize in place via
            // saveThumbnailLocal reading from disk
            persistentThumb = await persistThumbnail({
              source: 'local',
              entryId,
              pathOrUrl: content.localPaths.thumbnailPath,
              fallbackToSource: false,
            });
          } else if (!isInstagram && content.thumbnailUrl) {
            persistentThumb = await persistThumbnail({
              source: 'remote',
              entryId,
              pathOrUrl: content.thumbnailUrl,
              fallbackToSource: true,
            });
          }

          await updateEntry(entryId, {
            caption: content.caption,
            thumbnailUrl: persistentThumb,
            mediaUrl: content.videoUrl || content.audioUrl || null,
          });
        }

        if (isInstagram || hasLocalMedia) {
          // ======= LOCAL PIPELINE (IG + yt-dlp platforms) =======
          const localPaths = content.localPaths;
          const metadataProvider = isInstagram ? 'instagram_metadata' : 'source_metadata';

          // Transcription no longer blocks the pipeline. Whisper runs on a
          // machine that is powered off most of the time, so waiting bought
          // nothing; the entry completes now and the transcript arrives later
          // through a job, which then triggers a second analysis pass.
          //
          // The job itself is enqueued after this pass's results are written
          // (see the completion write below) — enqueueing it here, while this
          // pass is still running, let the transcribe job finish and fire a
          // reanalyse before this pass had persisted anything for it to merge
          // against. `localPaths` is captured now because it goes out of scope
          // once this branch ends.
          ranLocalMediaPipeline = true;
          transcribeAudioPath = localPaths?.audioPath ?? null;

          // OCR on frames + slides
          const frames = localPaths?.framePaths ?? [];
          const slides = localPaths?.slidePaths ?? [];
          // Single-image posts have neither frames nor slides, so they used to
          // reach OCR with an empty list and skip it entirely — losing every
          // word rendered into the image, which for infographic-style posts is
          // the whole content. Fall back to the thumbnail in that case.
          const ocrPaths = frames.length || slides.length
            ? [...frames, ...slides]
            : (localPaths?.thumbnailPath ? [localPaths.thumbnailPath] : []);

          // -----------------------------------------------------------------
          // A second pass re-runs the model, not the pipeline.
          //
          // OCR, vision and slide analysis read the same local files the first
          // pass read, so they cannot reach a different answer: whatever the
          // entry already carries is reused. Where a derivation is missing and
          // its inputs are on disk it is computed — an entry archived before
          // OCR existed gains OCR — because those reach only our own
          // containers, soundreel-ocr and Ollama through the router.
          //
          // External services are never called on a second pass, missing result
          // or not: absence is not evidence the service was ever asked. An
          // entry with no songs may simply be one where Shazam found nothing,
          // and re-learning that silence would cost one scan of an unofficial
          // endpoint per entry. See the Shazam and YouTube guards below.
          // -----------------------------------------------------------------
          const priorResults = reanalyze ? priorEntry?.results : undefined;
          const reusedOverlayText = priorResults?.overlayText ?? null;
          const reusedVisualContext = priorResults?.visualContext ?? null;
          // An empty array counts as absent, exactly as in mergeEntryResults:
          // an entry stored with `slides: []` must still be fillable.
          const reusedSlides = priorResults?.slides?.length ? priorResults.slides : null;

          // The merged OCR text is reusable; the per-image split is not, and a
          // carousel whose slides still have to be analysed needs that split.
          // A single page is reconstructible from the merge, so only a real
          // carousel forces OCR to run again.
          const carouselSlidesPending = !reusedSlides && slides.length > 0;
          let ocr: OcrResult;
          if (reusedOverlayText !== null && !carouselSlidesPending) {
            ocr = {
              perImage: [{ path: localPaths?.thumbnailPath ?? '', text: reusedOverlayText }],
              merged: reusedOverlayText,
              status: 'ok',
              reason: 'reused from entry',
            };
            await appendActionLog(entryId, createActionLog('ocr_extract', {
              status: 'reused',
              reason: 'second pass: overlayText already on the entry',
              mergedChars: ocr.merged.length,
            }));
          } else {
            ocr = await ocrImages(ocrPaths);
            await appendActionLog(entryId, createActionLog('ocr_extract', {
              status: ocr.status,
              reason: ocr.reason || null,
              imagesSent: ocrPaths.length,
              withText: ocr.perImage.filter((r) => r.text).length,
              mergedChars: ocr.merged.length,
            }));
          }

          // Per-slide structured extraction for carousels
          //
          // Skipped on a second pass: it reads the same slide OCR, so it yields
          // the same items — and those are already folded into the entry's
          // songs and films, which the merge preserves. Re-deriving them would
          // only spend a Spotify and a TMDb lookup each to be thrown away.
          if (!reanalyze && featuresConfig.carouselStructuredExtraction && (localPaths?.slidePaths?.length ?? 0) > 0) {
            const frameCount = localPaths?.framePaths?.length ?? 0;
            const slideOcrTexts = ocr.perImage
              .slice(frameCount)
              .map((r, i) => ({ slideIndex: i, text: r.text ?? '' }))
              .filter((s) => s.text.trim().length > 0);

            const extracted = await extractFromSlides(slideOcrTexts);
            slideItems.push(...extracted);

            await appendActionLog(entryId, createActionLog('carousel_extraction', {
              slides: localPaths?.slidePaths?.length ?? 0,
              itemsFound: extracted.length,
            }));
          }

          // Per-page narrative: each page keeps its own OCR text, description
          // and links instead of being melted into one merged blob.
          //
          // An infographic posted as a single image is one page of exactly this
          // kind — it names tools and products the reader wants to reach, and
          // those destinations can only come from the suggested-links path
          // (extraction requires the URL to be present in the text, and an
          // image lists names, not addresses). It is included whenever the
          // image actually carried text.
          const pagePaths = slides.length
            ? slides
            : (ocr.merged.trim().length >= SINGLE_IMAGE_OCR_MIN_CHARS && localPaths?.thumbnailPath
                ? [localPaths.thumbnailPath]
                : []);
          // Vision describe on key frames (only if mediaAnalysisEnabled + frames present)
          //
          // Deliberately run *before* analyzeSlides: both this call and the
          // per-slide loop inside analyzeSlides hit the moondream vision
          // model, and analyzeSlides finishes with one qwen call. Keeping
          // every moondream call contiguous means the local Ollama backend
          // (OLLAMA_MAX_LOADED_MODELS=1) loads moondream once instead of
          // bouncing between moondream and qwen on every call — see
          // geekom-hub's 2026-08-29 remeasurement: the GPU Hang came from
          // that reload churn, not from vision inference itself. Reordering
          // these two calls is the whole point; do not let them drift apart
          // again (see the ordering test in analyze.reanalyze.test.ts).
          let visualContext: string | null = reusedVisualContext;
          if (visualContext) {
            await appendActionLog(entryId, createActionLog('vision_describe', {
              status: 'reused',
              reason: 'second pass: visualContext already on the entry',
              chars: visualContext.length,
            }));
          } else if (featuresConfig.mediaAnalysisEnabled && !skipAi && localPaths?.framePaths.length) {
            const keyFrames = pickKeyFrames(localPaths.framePaths, KEY_FRAMES_COUNT);
            visualContext = await describeFramesWithVision(keyFrames);
            await appendActionLog(entryId, createActionLog('vision_describe', {
              status: visualContext ? 'ok' : 'skipped',
              frames: keyFrames.length,
              chars: visualContext?.length || 0,
              provider: 'ollama-moondream',
            }));
          } else {
            await appendActionLog(entryId, createActionLog('vision_describe', {
              status: 'skipped',
              reason: skipAi
                ? 'deferred to the batched AI pass'
                : !featuresConfig.mediaAnalysisEnabled ? 'disabled in settings' : 'no frames',
            }));
          }

          if (reusedSlides) {
            entrySlides = reusedSlides;
            await appendActionLog(entryId, createActionLog('slides_analyzed', {
              status: 'reused',
              reason: 'second pass: slides already on the entry',
              slides: entrySlides.length,
            }));
          } else if (pagePaths.length > 0) {
            try {
              const frameCount = slides.length ? (localPaths?.framePaths?.length ?? 0) : 0;
              entrySlides = await analyzeSlides({
                entryId,
                slidePaths: pagePaths,
                ocrPerSlide: ocr.perImage.slice(frameCount).map((r) => r.text ?? null),
                caption: captionForEnrich,
              }, { reanalyze });
              await appendActionLog(entryId, createActionLog('slides_analyzed', {
                slides: entrySlides.length,
                withOcr: entrySlides.filter((s) => s.ocrText).length,
                withVision: entrySlides.filter((s) => s.visualDescription).length,
                withSummary: entrySlides.filter((s) => s.summary).length,
                totalLinks: entrySlides.reduce((n, s) => n + s.links.length, 0),
              }));
            } catch (e) {
              log.warn('Analisi per slide fallita', { error: String(e) });
              await appendActionLog(entryId, createActionLog('slides_analyzed', {
                status: 'error', error: String(e),
              }));
            }
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
            }, { reanalyze });
          } else {
            aiResponse = { result: emptyMedia(), usageMetadata: null, fallback: null };
          }

          // Music: source metadata is authoritative (IG music sticker, or
          // yt-dlp track/artist fields) — no AudD on the local path
          if (content.musicInfo) {
            audioResult = {
              title: content.musicInfo.title,
              artist: content.musicInfo.artist,
              album: null,
            };
            await appendActionLog(entryId, createActionLog('audio_analyzed', {
              provider: metadataProvider,
              found: true,
              title: content.musicInfo.title,
              artist: content.musicInfo.artist,
            }));
          } else {
            await appendActionLog(entryId, createActionLog('audio_analyzed', {
              provider: metadataProvider,
              found: false,
              reason: 'no music info in source metadata',
            }));
          }
          // Shazam multi-song scan on local audio
          // Skip when musicInfo already present and multi-song scan not enabled
          // (Shazam on actual audio would find a different song than the IG music sticker)
          //
          // `!reanalyze` because the audio has not changed since the first pass
          // scanned it, and /shazam/scan-full segments the file and calls an
          // unofficial endpoint once per segment. Re-running it on every second
          // pass — and hundreds of times over a backfill — is the same risk
          // class as re-downloading from Instagram, for nothing: the merge is
          // additive, so pass 1's tracks are still there.
          const shazamNeeded = !reanalyze && featuresConfig.shazamEnabled && localPaths?.audioPath &&
            (!content.musicInfo || featuresConfig.multiSongScanEnabled);
          if (shazamNeeded) {
            try {
              shazamTracks = await scanFullAudio(localPaths.audioPath!);
              await appendActionLog(entryId, createActionLog('shazam_scan', {
                status: 'ok',
                found: shazamTracks.length,
                tracks: shazamTracks.map((t) => ({
                  title: t.title,
                  artist: t.artist,
                  spotifyUrl: t.spotifyUrl,
                  youtubeUrl: t.youtubeUrl,
                  timestampMs: t.timestampMs,
                })),
              }));
              // If no musicInfo, use first Shazam track as primary audioResult
              if (!audioResult && shazamTracks[0]) {
                audioResult = {
                  title: shazamTracks[0].title,
                  artist: shazamTracks[0].artist,
                  album: null,
                };
              }
            } catch (e) {
              await appendActionLog(entryId, createActionLog('shazam_scan', {
                status: 'error', error: String(e),
              }));
            }
          } else {
            await appendActionLog(entryId, createActionLog('shazam_scan', {
              status: 'skipped',
              reason: reanalyze
                ? 'second pass: audio unchanged, already scanned'
                : !featuresConfig.shazamEnabled ? 'disabled' : 'no audioPath',
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

          // `!reanalyze` for two reasons: the transcript is already in hand
          // (hydrated from the entry above), and this stub assigns to the same
          // variable unconditionally — running it here would blank it before
          // the model ever sees it.
          if (!reanalyze && featuresConfig.transcriptionEnabled) {
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
            await appendActionLog(entryId, createActionLog('transcribe', {
              status: 'skipped',
              reason: reanalyze ? 'second pass: transcript already in hand' : 'disabled in settings',
            }));
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
                }, { reanalyze })
              : Promise.resolve({ result: emptyMedia(), usageMetadata: null, fallback: null }),
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
        : { status: 'skipped', reason: skipAi ? 'deferred to the batched AI pass' : 'disabled in settings' };
      if (aiResponse.usageMetadata) aiAnalyzedDetails.tokenUsage = aiResponse.usageMetadata;
      await appendActionLog(entryId, createActionLog('ai_analyzed', aiAnalyzedDetails));

      if (aiResponse.fallback) {
        const fb = aiResponse.fallback;
        await appendActionLog(entryId, createActionLog('claude_fallback', {
          status: fb.status,
          reason: fb.reason,
          model: fb.model,
          durationMs: fb.durationMs,
          recovered: {
            songs: aiResult.songs.length,
            films: aiResult.films.length,
            notes: aiResult.notes.length,
            hasSummary: !!aiResult.summary,
          },
        }));
      }

      const merged = mergeResults(audioResult, aiResult);

      // Merge carousel slide songs into the result set
      const slideSongs = slideItems.filter((i) => i.type === 'song' || i.type === 'album');
      const slideFilms = slideItems.filter((i) => i.type === 'film');

      // What the entry already carried before this pass.
      //
      // The merge below keeps the existing copy of anything already here, so
      // every external lookup spent on one of these items is spent on a result
      // that is then discarded — and on a second pass most items are already
      // here. Skipping them is what keeps a backfill from firing hundreds of
      // Spotify, TMDb, Watchmode, OpenLibrary and Nominatim calls to re-derive
      // enrichment the entry already has. Anything genuinely new that the
      // transcript revealed is still enriched: that is the point of the pass.
      const priorSongKeys = new Set(
        (priorEntry?.results?.songs ?? []).map((s) => songKey(s.title, s.artist))
      );
      const priorFilmKeys = new Set(
        (priorEntry?.results?.films ?? []).map((f) => filmTitleKey(f.title))
      );
      const priorNoteKeys = new Set(
        (priorEntry?.results?.notes ?? []).map((n) => noteKey(n.category, n.text))
      );

      const songs: Song[] = [];
      for (const songData of merged.songs) {
        // The merge keeps the copy already on the entry, links and all, so
        // both the lookup and the playlist add would be thrown away.
        const alreadyOnEntry = priorSongKeys.has(songKey(songData.title, songData.artist));
        const spotifyResult = alreadyOnEntry ? null : await searchTrack(songData.title, songData.artist);
        let addedToPlaylist = false;
        if (alreadyOnEntry) {
          await appendActionLog(entryId, createActionLog('spotify_search', {
            query: `${songData.title} — ${songData.artist}`,
            status: 'skipped',
            reason: 'second pass: song already on the entry',
          }));
        } else if (spotifyResult) {
          addedToPlaylist = await addToPlaylist(spotifyResult.uri);
          await appendActionLog(entryId, createActionLog('spotify_search', {
            query: `${songData.title} — ${songData.artist}`,
            found: true,
            track: spotifyResult.name,
            artist: spotifyResult.artist,
            uri: spotifyResult.uri,
            url: spotifyResult.url,
            addedToPlaylist,
          }));
        } else {
          await appendActionLog(entryId, createActionLog('spotify_search', {
            query: `${songData.title} — ${songData.artist}`,
            found: false,
          }));
        }
        songs.push({
          title: songData.title,
          artist: songData.artist,
          album: songData.album,
          source: songData.source,
          spotifyUri: spotifyResult?.uri || null,
          spotifyUrl: spotifyResult?.url || null,
          youtubeUrl: (() => {
            const shazam = shazamTracks.find(
              (t) => t.title.toLowerCase() === songData.title.toLowerCase() &&
                     t.artist.toLowerCase() === songData.artist.toLowerCase()
            );
            return shazam?.youtubeUrl ?? null;
          })(),
          soundcloudUrl: generateSoundcloudSearchUrl(songData.title, songData.artist),
          addedToPlaylist,
        });
      }

      for (const slideSong of slideSongs) {
        const slideAlreadyOnEntry = priorSongKeys.has(songKey(slideSong.title, slideSong.artist ?? ''));
        const spotifyResult = slideAlreadyOnEntry
          ? null
          : await searchTrack(slideSong.title, slideSong.artist ?? '');
        let addedToPlaylist = false;
        if (spotifyResult) {
          addedToPlaylist = await addToPlaylist(spotifyResult.uri);
          await appendActionLog(entryId, createActionLog('spotify_search', {
            query: `${slideSong.title} — ${slideSong.artist ?? ''}`,
            source: 'carousel_slide',
            sourceSlide: slideSong.sourceSlide,
            found: true,
            track: spotifyResult.name,
            uri: spotifyResult.uri,
            url: spotifyResult.url,
            addedToPlaylist,
          }));
        } else {
          await appendActionLog(entryId, createActionLog('spotify_search', {
            query: `${slideSong.title} — ${slideSong.artist ?? ''}`,
            source: 'carousel_slide',
            sourceSlide: slideSong.sourceSlide,
            found: false,
          }));
        }
        const ytUrl = !reanalyze && featuresConfig.youtubeDirect
          ? await resolveYoutubeUrl(slideSong.artist ?? '', slideSong.title)
          : generateYoutubeSearchUrl(slideSong.title, slideSong.artist ?? '');
        songs.push({
          title: slideSong.title,
          artist: slideSong.artist ?? '',
          album: null,
          source: 'ai_analysis',
          spotifyUri: spotifyResult?.uri ?? null,
          spotifyUrl: spotifyResult?.url ?? null,
          youtubeUrl: ytUrl,
          soundcloudUrl: generateSoundcloudSearchUrl(slideSong.title, slideSong.artist ?? ''),
          addedToPlaylist,
          sourceSlide: slideSong.sourceSlide,
        });
      }

      // Resolve direct YouTube URLs for songs missing one.
      //
      // `!reanalyze` because this is yt-dlp against YouTube — an external
      // service, and the rule holds even though the URL is missing: a song
      // without one may simply be a song yt-dlp could not resolve, so a
      // backfill would re-learn hundreds of the same failures. The fallback
      // below builds a search URL locally, which is what CLAUDE.md prescribes
      // anyway, so a genuinely new song still gets a working link.
      if (!reanalyze && featuresConfig.youtubeDirect) {
        await Promise.allSettled(
          songs.map(async (song, i) => {
            if (!song.youtubeUrl) {
              const url = await resolveYoutubeUrl(song.artist, song.title);
              await appendActionLog(entryId!, createActionLog('youtube_resolve', {
                query: `${song.artist} ${song.title}`,
                found: !!url,
                url: url ?? null,
              }));
              if (url) songs[i] = { ...song, youtubeUrl: url };
            }
          })
        );
      } else {
        // Fallback to search URL when youtubeDirect is disabled, or when this
        // is a second pass and the direct resolver is off limits.
        songs.forEach((song, i) => {
          if (!song.youtubeUrl) {
            songs[i] = { ...song, youtubeUrl: generateYoutubeSearchUrl(song.title, song.artist) };
          }
        });
        if (reanalyze && featuresConfig.youtubeDirect) {
          await appendActionLog(entryId, createActionLog('youtube_resolve', {
            status: 'skipped',
            reason: 'second pass: external resolver never runs, using search URLs',
            songs: songs.length,
          }));
        }
      }

      // Fire-and-forget: enrich every song with title in the merged result set
      // (Deezer/iTunes cover, genres, direct links) skipping ones enriched
      // within the TTL. Never delays the pipeline.
      //
      // Songs already on the entry are left out on a second pass: their meta
      // row exists, and for an archived entry the TTL has long expired, so
      // including them would mean a Deezer and an iTunes call each to rebuild
      // what is already there.
      enqueueSongEnrichment(
        songs
          .filter((s) => !priorSongKeys.has(songKey(s.title, s.artist)))
          .map((s) => ({ artist: s.artist, title: s.title }))
      );

      const films: Film[] = [];
      for (const filmData of merged.films) {
        // As with songs: the merge keeps the copy already on the entry, so the
        // TMDb lookup would be spent on a result that is discarded. A null
        // tmdbResult also carries the rest of the loop — the film_meta upsert
        // and the Watchmode refresh both already require one — so the entry's
        // existing enrichment is left alone rather than refetched.
        const filmAlreadyOnEntry = priorFilmKeys.has(filmTitleKey(filmData.title));
        const tmdbResult = filmAlreadyOnEntry ? null : await searchFilm(filmData.title, filmData.year);
        await appendActionLog(entryId, createActionLog('film_found', {
          title: filmData.title,
          provider: 'tmdb',
          ...(filmAlreadyOnEntry
            ? { status: 'skipped', reason: 'second pass: film already on the entry' }
            : { found: !!tmdbResult }),
        }));
        const filmYear = resolveFilmYear(filmData.year, tmdbResult?.releaseDate);
        const filmMetaKey = filmKey(filmData.title, filmYear);
        if (hasEnrichmentData(tmdbResult)) {
          void upsertFilmEnrichment({
            filmKey: filmMetaKey,
            tmdbId: tmdbResult.id,
            genres: tmdbResult.genres,
            overview: tmdbResult.overview,
            cast: tmdbResult.cast,
            tmdbScore: tmdbResult.voteAverage,
          }).catch((err) => logError('film_meta upsert failed', { err: String(err) }));
        }
        const filmImdbId = tmdbResult?.imdbId ?? null;
        if (filmImdbId && streamingConfigured()) {
          // Meta read happens inside the fire-and-forget IIFE, not before it,
          // so the extra DB round-trip never delays the analyze response.
          void (async () => {
            const existingMeta = await getFilmMeta(filmMetaKey);
            if (!isStale(existingMeta?.streamingCheckedAt ?? null, STREAMING_TTL_DAYS)) return;
            await refreshStreamingForFilm({
              filmKey: filmMetaKey,
              imdbId: filmImdbId,
              cachedTitleId: existingMeta?.watchmodeTitleId ?? null,
            });
          })().catch((err) => logError('streaming refresh failed', { err: String(err) }));
        }
        films.push({
          title: filmData.title,
          director: filmData.director,
          year: filmYear,
          imdbUrl: tmdbResult?.imdbId ? generateImdbUrl(tmdbResult.imdbId) : null,
          posterUrl: tmdbResult?.posterPath || null,
          streamingUrls: generateStreamingUrls(filmData.title),
        });
      }

      for (const slideFilm of slideFilms) {
        const slideFilmAlreadyOnEntry = priorFilmKeys.has(filmTitleKey(slideFilm.title));
        const tmdbResult = slideFilmAlreadyOnEntry
          ? null
          : await searchFilm(slideFilm.title, slideFilm.year?.toString() ?? null);
        const slideFilmYear = resolveFilmYear(slideFilm.year?.toString() ?? null, tmdbResult?.releaseDate);
        const slideFilmMetaKey = filmKey(slideFilm.title, slideFilmYear);
        if (hasEnrichmentData(tmdbResult)) {
          void upsertFilmEnrichment({
            filmKey: slideFilmMetaKey,
            tmdbId: tmdbResult.id,
            genres: tmdbResult.genres,
            overview: tmdbResult.overview,
            cast: tmdbResult.cast,
            tmdbScore: tmdbResult.voteAverage,
          }).catch((err) => logError('film_meta upsert failed', { err: String(err) }));
        }
        const slideFilmImdbId = tmdbResult?.imdbId ?? null;
        if (slideFilmImdbId && streamingConfigured()) {
          // Meta read happens inside the fire-and-forget IIFE, not before it,
          // so the extra DB round-trip never delays the analyze response.
          void (async () => {
            const existingMeta = await getFilmMeta(slideFilmMetaKey);
            if (!isStale(existingMeta?.streamingCheckedAt ?? null, STREAMING_TTL_DAYS)) return;
            await refreshStreamingForFilm({
              filmKey: slideFilmMetaKey,
              imdbId: slideFilmImdbId,
              cachedTitleId: existingMeta?.watchmodeTitleId ?? null,
            });
          })().catch((err) => logError('streaming refresh failed', { err: String(err) }));
        }
        films.push({
          title: slideFilm.title,
          director: slideFilm.director ?? null,
          year: slideFilmYear,
          imdbUrl: tmdbResult?.imdbId ? generateImdbUrl(tmdbResult.imdbId) : null,
          posterUrl: tmdbResult?.posterPath ?? null,
          streamingUrls: generateStreamingUrls(slideFilm.title),
          sourceSlide: slideFilm.sourceSlide,
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
      if (entrySlides.length) results.slides = entrySlides;
      if (transcript) results.transcript = transcript;
      if (transcription) results.transcription = transcription;
      if (visualContextOut) results.visualContext = visualContextOut;
      if (overlayText) results.overlayText = overlayText;

      // Additive, never subtractive — and unconditional. Hundreds of archived
      // entries carry enrichment (Spotify links, TMDb metadata, book and place
      // lookups) keyed off their original text; writing `results` straight over
      // them would drop everything this pass happened not to find again, and
      // none of it can be recovered.
      //
      // Not gated on `reanalyze`: on a first pass the existing results are
      // empty, so the merge is a no-op, and on a repair of a half-finished
      // entry keeping what is already there is the safer default. Making it
      // unconditional is what lets `reanalyze` mean one single thing — the
      // media is on disk, fetch nothing — instead of two.
      //
      // Re-read the entry rather than trusting priorEntry: the pipeline above
      // has been writing to it for minutes.
      let finalResults = results as unknown as EntryResults;
      const before = await getEntry(entryId);
      if (before) finalResults = mergeEntryResults(before.results, finalResults);

      await updateEntry(entryId, {
        status: 'completed',
        results: finalResults,
      });

      // Transcribe job for entries with audio, enqueued only now that the
      // entry above carries this pass's results. The job saves the transcript
      // and fires a second pass that merges into what is already there — if
      // that pass started before this write landed, it would find nothing to
      // merge against and would redo, concurrently, everything this pass just
      // did (OCR, slide analysis, the AI call).
      //
      // Gated on `ranLocalMediaPipeline`: the legacy and page pipelines never
      // had a `whisper_asr` action (legacy logs its own `transcribe` action,
      // synchronously, a few lines above in that branch), and moving the
      // enqueue down here must not hand them one.
      const transcriptSource = chooseTranscriptSource({
        subtitleText: sourceSubtitle?.text ?? null,
        subtitleLang: sourceSubtitle?.lang ?? null,
        subtitleKind: sourceSubtitle?.kind ?? null,
        audioPath: transcribeAudioPath,
        transcriptionEnabled: featuresConfig.transcriptionEnabled,
        reanalyze,
      });

      // Deliberately outside the `ranLocalMediaPipeline` guard below. A written
      // track can arrive on the legacy path too — a video past the download
      // duration cap still has one, and those are exactly the long talks where
      // Whisper would cost the most. Gating this on the media branch would have
      // dropped the transcript in the very cases the feature exists for.
      //
      // It logs its own action rather than a `whisper_asr` one: legacy and page
      // entries have never carried that action, and handing them one now would
      // rewrite what the journal means for every entry that came before.
      if (transcriptSource.kind === 'subtitles') {
        // Two updateEntry calls rather than one with both dotted keys:
        // updateEntry rewrites each 'results.*' key into its own
        // `results = jsonb_set(...)` SET clause, and Postgres rejects an
        // UPDATE that assigns the same column twice.
        await updateEntry(entryId, { 'results.transcript': transcriptSource.text });
        await updateEntry(entryId, { 'results.transcriptLanguage': transcriptSource.lang });
        await appendActionLog(entryId, createActionLog('subtitles', {
          status: 'ok',
          kind: transcriptSource.subtitleKind,
          language: transcriptSource.lang,
          chars: transcriptSource.text.length,
        }));
        // The analysis above has already run, and it ran without this text.
        // A transcript that arrives after the models have spoken has to be fed
        // back the same way a late Whisper result is — through a second pass —
        // or the words would sit in the entry without ever reaching the songs,
        // notes and summary they were fetched for.
        await enqueueJob({
          entryId,
          sourceUrl: normalizedUrl,
          platform: 'other',
          chatId: 0,
          inputUser: user ?? null,
          notify: false,
          kind: 'analyze',
          reanalyze: true,
        });
      }

      if (ranLocalMediaPipeline) {
        // `!reanalyze` closes the loop: a second pass runs on an entry that
        // already has its transcript, and audio.wav is still on disk. Without
        // that guard — now inside chooseTranscriptSource — it would queue
        // another transcribe, which would queue another second pass, forever.
        if (transcriptSource.kind === 'whisper') {
          // Always 'other', never isInstagram ? 'instagram' : 'other'.
          // Not for the reason one might assume: `platform` does not decide
          // which claim function picks the job up. claimNextInstagramJob
          // filters on `kind = 'analyze'`, and claimNextTranscribeJob on
          // `kind = 'transcribe'`, so this job never lands in the serialised,
          // jittered Instagram lane whatever platform it carries.
          // What `platform` does select is the retry table in
          // computeBackoffMs: 'instagram' means three escalating retries up
          // to seven minutes, tuned for a remote download that IG may be
          // throttling. This job only reads a .wav already on local disk, so
          // a failure here is local and the single 'other' retry is right.
          await enqueueJob({
            entryId,
            sourceUrl: normalizedUrl,
            platform: 'other',
            chatId: 0,
            inputUser: user ?? null,
            notify: false,
            kind: 'transcribe',
          });
          await appendActionLog(entryId, createActionLog('whisper_asr', {
            status: 'queued',
            reason: null,
          }));
        } else {
          await appendActionLog(entryId, createActionLog('whisper_asr', {
            status: 'skipped',
            reason: transcriptSource.kind === 'subtitles'
              ? `subtitles: ${transcriptSource.subtitleKind}`
              : transcriptSource.reason,
          }));
        }
      }

      // Fire-and-forget: enrich every book- and place-category note
      // (OpenLibrary title/author/year/cover for books; Nominatim/OSM
      // name/coordinates for places) skipping ones enriched within the TTL.
      // Never delays the pipeline. Fired after results are persisted since,
      // unlike songs, notes have no separate downstream step depending on
      // this write completing first.
      // Same rule as the songs above: a note already on the entry keeps its
      // existing OpenLibrary / Nominatim enrichment through the merge.
      enqueueNoteEnrichment(notes.filter((n) => !priorNoteKeys.has(noteKey(n.category, n.text))));

      // Counted off what was actually persisted, not off this pass alone: on a
      // second pass the two differ by everything the merge preserved.
      await appendActionLog(entryId, createActionLog('completed', {
        totalSongs: finalResults.songs.length,
        totalFilms: finalResults.films.length,
        totalNotes: finalResults.notes.length,
        totalLinks: finalResults.links.length,
        totalTags: finalResults.tags.length,
        addedToPlaylist: finalResults.songs.filter((s) => s.addedToPlaylist).length,
        ...(reanalyze ? { reanalyze: true, foundThisPass: songs.length } : {}),
      }));

      try {
        const openaiConfig = await getOpenAIConfig();
        // Never on a second pass. Same rule as Shazam and the YouTube resolver:
        // an external paid service, where a missing `results.enrichments` is not
        // evidence enrichment never ran — it may have run and found nothing, or
        // been disabled at the time. Firing once per entry regardless of whether
        // the pass found anything is exactly the pattern removed everywhere
        // else. It would also be a whole-object overwrite rather than a merge.
        if (openaiConfig.apiKey && !reanalyze) {
          const enrichment = await enrichWithOpenAI(finalResults, captionForEnrich);
          if (enrichment.items.length > 0 || enrichment.verdict) {
            await updateEntry(entryId, { 'results.enrichments': enrichment });
            await appendActionLog(entryId, createActionLog('auto_enriched', {
              provider: 'openai',
              category: enrichment.category,
              items: enrichment.items.length,
              links: enrichment.items.reduce((sum, i) => sum + i.links.length, 0),
              hasVerdict: !!enrichment.verdict,
            }));
            results.enrichments = enrichment;
          }
        }
      } catch (enrichError) {
        log.warn('Auto-enrichment fallito', { error: String(enrichError) });
        await appendActionLog(entryId, createActionLog('auto_enrich_failed', { error: String(enrichError) }));
      }

      // Fire-and-forget: detect and resolve music list in background.
      // Only runs for the page pipeline (isPage=true) when mainText was successfully fetched,
      // reusing the already-fetched page content to avoid a double extractPage call.
      if (isPage && pageMainText) {
        const _mainTextSnapshot = pageMainText;
        void (async () => {
          try {
            const extracted = await extractSongsFromMainText(_mainTextSnapshot);
            if (extracted.length) {
              const resolved = await resolveSongs(extracted);
              const spooty = resolved.filter((s) => s.sentToSpooty).length;

              let songsPersisted = 0;
              try {
                songsPersisted = await appendSongsToEntry(entryId!, resolvedToSongs(resolved));
              } catch (err) {
                logError('music_list_auto persist failed', { entryId, err: String(err) });
              }
              enqueueSongEnrichment(resolved.map((s) => ({ artist: s.artist, title: s.title })));

              await appendActionLog(entryId!, createActionLog('music_list_auto', {
                songsFound: extracted.length, sentToSpooty: spooty, songsPersisted,
              }));
            }
          } catch (_err) {
            // non-blocking: inner functions log their own errors
          }
        })();
      }

      const entry = await getEntry(entryId);
      reply.send({ success: true, entryId, entry });
    } catch (error) {
      log.error('Errore durante analisi', error instanceof Error ? error : new Error(String(error)));
      if (entryId) {
        try {
          // A second pass that throws — an Ollama flake, an OCR error — must
          // leave the entry exactly as it found it. Flipping an archived
          // `completed` entry to `error` degrades the archive on sight and
          // feeds it straight back to requeueErrors, which would then try to
          // repair an entry that was never broken.
          const restoredStatus: Entry['status'] =
            reanalyze ? (priorEntry?.status ?? 'error') : 'error';
          await updateEntry(entryId, { status: restoredStatus });
          await appendActionLog(entryId, createActionLog('completed', {
            status: restoredStatus,
            reason: reanalyze ? 'reanalyze_failed_status_restored' : 'unhandled_pipeline_error',
            error: error instanceof Error ? error.message : String(error),
          }));
        } catch { /* ignore cleanup errors */ }
      }
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

async function persistThumbnail(opts: {
  source: 'local' | 'remote' | 'page_image';
  entryId: string;
  pathOrUrl: string;
  fallbackToSource: boolean;
}): Promise<string | null> {
  const saved = await saveThumbnailLocal(opts.pathOrUrl, opts.entryId);
  if (saved) {
    await appendActionLog(opts.entryId, createActionLog('thumbnail_saved', {
      source: opts.source,
      relativeUrl: saved.relativeUrl,
      sizeBytes: saved.sizeBytes,
    }));
    return saved.relativeUrl;
  }
  if (opts.fallbackToSource) {
    await appendActionLog(opts.entryId, createActionLog('thumbnail_save_failed', {
      sourceUrl: opts.pathOrUrl,
    }));
    return opts.pathOrUrl;
  }
  return null;
}

// Suppress unused-import warning; getInstagramConfig was used for cookie fallback (legacy only)
void getInstagramConfig;
