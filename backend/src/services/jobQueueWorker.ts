import { promises as fs } from 'fs';
import path from 'path';
import {
  claimNextInstagramJob,
  claimNextOtherJob,
  claimNextReanalyzeJob,
  claimNextTranscribeJob,
  enqueueJob,
  markJobDone,
  markJobFailed,
  scheduleJobRetry,
  type JobQueueRow,
  type JobPlatform,
} from '../utils/jobQueue';
import { sendTelegramMessage, formatAnalysisError, formatTelegramResponse, type AnalyzeResult } from '../routes/telegram';
import { Logger } from './debugLogger';
import { isWhisperReachable, transcribeLocal } from './whisperClient';
import { updateEntry, appendActionLog } from '../utils/db';
import { createActionLog } from '../utils/logger';

const OTHER_CONCURRENCY_CAP = 3;
const IG_BACKOFF_MS = [60_000, 180_000, 420_000];
const OTHER_BACKOFF_MS = [60_000];

/**
 * Instagram has stopped trusting the *session*, not this URL.
 *
 * That state ends when a human re-seeds the cookie in the Instaloader
 * container — hours, sometimes days later. The ordinary Instagram table burns
 * all three attempts inside eleven minutes, so the job was always dead long
 * before anyone could act on the warning it had just sent. Escalate instead,
 * then settle into a daily knock so a session renewed on day three still gets
 * the entry processed.
 */
const AUTH_BACKOFF_MS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const AUTH_DAILY_MS = 24 * 3_600_000;
/** Roughly eight days of daily retries after the escalation. Then give up. */
const AUTH_MAX_ATTEMPTS = 10;

/**
 * Errors that mean "the session is no longer valid", from either side of the
 * sidecar: instaloader's own exception text (`challenge_required`,
 * `LoginRequiredException`) and the sidecar's rewritten replies
 * (`login required; seed session via ...`, a bare 401/403).
 */
const AUTH_ERROR_PATTERNS = [
  /challenge_required/i,
  /checkpoint_required/i,
  /login[ _]?required/i,
  /session.{0,24}expired/i,
  /\b401\b/,
  /\b403\b/,
];

export function isAuthFailure(error: string): boolean {
  return AUTH_ERROR_PATTERNS.some((re) => re.test(error));
}

export function computeAuthBackoffMs(attempts: number): number | null {
  if (attempts > AUTH_MAX_ATTEMPTS) return null;
  return AUTH_BACKOFF_MS[attempts - 1] ?? AUTH_DAILY_MS;
}

export interface WorkerState {
  igBusy: boolean;
  igNextAllowedAt: number; // epoch ms
  otherInFlight: number;
  /**
   * One re-analysis at a time, and no cooling-off window between them.
   *
   * These jobs reach no external service, so nothing here is rate limiting:
   * it is ollama that must be protected. It keeps a single model resident
   * (MAX_LOADED_MODELS=1, KEEP_ALIVE=90s), so running two passes at once would
   * swap the model in and out between every call — the queue teardown that
   * hangs this APU. Back to back and serial, the model is loaded once for the
   * whole batch.
   */
  reanalyzeBusy: boolean;
}

export function createInitialWorkerState(): WorkerState {
  return { igBusy: false, igNextAllowedAt: 0, otherInFlight: 0, reanalyzeBusy: false };
}

export function computeJitterDelayMs(rand: () => number = Math.random): number {
  return Math.floor(30_000 + rand() * 60_000);
}

export function computeBackoffMs(platform: JobPlatform, attempts: number): number | null {
  const table = platform === 'instagram' ? IG_BACKOFF_MS : OTHER_BACKOFF_MS;
  if (attempts > table.length) return null;
  return table[attempts - 1];
}

async function sendResultToTelegram(job: JobQueueRow, result: AnalyzeResult): Promise<void> {
  // Repair runs re-queue entries the user submitted days ago; staying silent is
  // the point of the flag, so bail before touching the Telegram API.
  if (!job.notify) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  if (!result.success || !result.entry) {
    await sendTelegramMessage(job.chatId, formatAnalysisError(result), token);
  } else {
    const text = await formatTelegramResponse(result, result.entryId || '');
    await sendTelegramMessage(job.chatId, text, token);
  }
}

/**
 * A Telegram send must never cost the caller its retry: the notification is a
 * courtesy, the `scheduleJobRetry` that follows it is what keeps the job
 * alive. Without this guard a Telegram outage left the row stuck at
 * `processing` until the next server boot.
 */
async function notifyQuietly(chatId: number, text: string, token: string, log: Logger): Promise<void> {
  try {
    await sendTelegramMessage(chatId, text, token);
  } catch (err) {
    log.error('Notifica Telegram fallita', err instanceof Error ? err : new Error(String(err)));
  }
}

async function handleFailure(job: JobQueueRow, err: unknown, log: Logger): Promise<void> {
  log.error(`Job ${job.id} (${job.platform}) failed`, err instanceof Error ? err : new Error(String(err)));
  const message = err instanceof Error ? err.message : String(err);
  // An expired Instagram session is not this URL's fault and is not fixed by
  // waiting a minute — it gets its own, far longer schedule.
  const auth = isAuthFailure(message);
  const attempts = job.attempts + 1;
  const backoff = auth ? computeAuthBackoffMs(attempts) : computeBackoffMs(job.platform, attempts);
  const token = job.notify ? process.env.TELEGRAM_BOT_TOKEN : null;

  if (backoff === null) {
    await markJobFailed(job.id);
    if (token) {
      const text = auth
        ? `❌ Rinuncio: la sessione Instagram non è stata rinnovata dopo ${attempts} tentativi.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`
        : `❌ Analisi fallita dopo ${attempts} tentativi.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`;
      await notifyQuietly(job.chatId, text, token, log);
    }
    return;
  }

  // Exactly one message, on the first auth failure: the retries after it are
  // hours apart, and repeating "renew the session" every few hours is noise.
  // The next thing the user hears is the entry going through.
  if (auth && job.attempts === 0 && token) {
    await notifyQuietly(
      job.chatId,
      formatAnalysisError({ success: false, entryId: job.entryId, error: message }, { willRetry: true }),
      token,
      log
    );
  }

  log.info(`Job ${job.id}: retry ${attempts} fra ${Math.round(backoff / 1000)}s`, { auth });
  await scheduleJobRetry(job.id, attempts, new Date(Date.now() + backoff));
}

/**
 * Whisper lives on a machine that is powered off most of the time, and we
 * deliberately do not wake it for transcription — that is what the Ollama wake
 * threshold exists to prevent. So an unreachable service is not a failure: the
 * job simply waits half an hour and asks again.
 */
export const TRANSCRIBE_RETRY_MS = 30 * 60 * 1000;

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';

export async function dispatchTranscribe(job: JobQueueRow): Promise<void> {
  const log = new Logger('jobQueueWorker');

  try {
    if (!(await isWhisperReachable())) {
      await scheduleJobRetry(job.id, job.attempts, new Date(Date.now() + TRANSCRIBE_RETRY_MS));
      log.info(`Job ${job.id}: whisper non raggiungibile, riprovo fra 30 minuti`);
      return;
    }

    const audioPath = path.join(MEDIA_ROOT, job.entryId, 'audio.wav');
    try {
      await fs.access(audioPath);
    } catch {
      // Retrying can't produce a file that isn't there — no scheduleJobRetry,
      // no attempt burned, just a terminal failure. Logged to the entry's
      // actionLog (not just container logs) because that's what the journal
      // UI shows the user to explain why transcription never happened.
      log.warn(`Job ${job.id}: audio mancante su disco (${audioPath})`);
      await markJobFailed(job.id);
      await appendActionLog(job.entryId, createActionLog('whisper_asr', {
        status: 'error',
        reason: 'audio file missing',
        path: audioPath,
      }));
      return;
    }

    const asr = await transcribeLocal(audioPath);
    await appendActionLog(job.entryId, createActionLog('whisper_asr', {
      status: asr.status,
      reason: asr.reason || null,
      language: asr.language,
      chars: asr.text?.length || 0,
      durationMs: asr.durationMs,
    }));

    if (asr.status === 'error' && asr.httpStatus === 503) {
      // WHISPER_URL points at gpu-router now, and a 503 from a *router* is not
      // a failure of this audio: it means "no transcription capacity right
      // now" — not enough memory to start the local container, or it did not
      // come up within the router's 60s budget. That is the same wait-and-retry
      // condition isWhisperReachable already handles, so it must not count as
      // an attempt: transcribe jobs are enqueued with platform 'other', whose
      // backoff table is a single 60s retry, so treating this as a failure
      // would destroy the entry's transcript within a minute.
      await scheduleJobRetry(job.id, job.attempts, new Date(Date.now() + TRANSCRIBE_RETRY_MS));
      log.info(`Job ${job.id}: whisper senza capacita' (503), riprovo fra 30 minuti`);
      return;
    }

    if (asr.status === 'error') {
      // A service that answered and then failed is a real failure: let the
      // existing backoff table count this attempt.
      await handleFailure(job, new Error(asr.reason || 'whisper error'), log);
      return;
    }

    if (asr.text) {
      // Two calls, not one with both dotted keys: updateEntry rewrites each
      // 'results.*' key into its own `results = jsonb_set(...)` SET clause,
      // and Postgres rejects an UPDATE that assigns the same column twice.
      await updateEntry(job.entryId, { 'results.transcript': asr.text });
      await updateEntry(job.entryId, { 'results.transcriptLanguage': asr.language });
      await enqueueJob({
        entryId: job.entryId,
        sourceUrl: job.sourceUrl,
        platform: job.platform,
        chatId: job.chatId,
        inputUser: job.inputUser,
        notify: false,
        kind: 'analyze',
        priority: job.priority,
        // The only place this is ever set. The media this pass needs is the
        // media the first pass downloaded, and it is still on disk — so the
        // pass must fetch nothing. Anything else queuing a silent analyze job
        // (a repair) leaves it false and keeps its download.
        reanalyze: true,
      });
    }

    await markJobDone(job.id);
  } catch (err) {
    // dispatchTranscribe is invoked fire-and-forget (`void dispatchTranscribe(...)`).
    // An uncaught throw here (e.g. appendActionLog/updateEntry/markJobDone hitting a
    // dead DB) must not just be logged: without a call to handleFailure the row is
    // stranded at status='processing', with no retry scheduled — recoverable only by
    // requeueStuckJobs() at the next server boot. Route it through the same failure
    // handling dispatch() uses, and guard that call too so a failure *there* still
    // cannot become an unhandled rejection.
    try {
      await handleFailure(job, err, log);
    } catch (failureErr) {
      log.error(
        `Job ${job.id} failure handling itself failed`,
        failureErr instanceof Error ? failureErr : new Error(String(failureErr))
      );
    }
  }
}

async function dispatch(job: JobQueueRow, onSettle: () => void): Promise<void> {
  const log = new Logger('jobQueueWorker');
  try {
    const internalUrl = `http://127.0.0.1:${process.env.PORT || 8080}/api/analyze`;
    const res = await fetch(internalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: job.sourceUrl,
        channel: 'telegram',
        user: job.inputUser,
        // Read only on a re-analysis, and the reason it is sent at all: the
        // route used to find the entry by re-normalising this URL, and 183 of
        // the 882 stored source_urls predate the current normaliser and do not
        // survive the round trip. Two of the 83 backfill candidates are among
        // them — their transcript was written (that path uses entryId) and the
        // second pass then 404'd. The id is what the job actually knows.
        entryId: job.entryId,
        // Read off the job, never inferred from notify. Inferring it conflated
        // "merge instead of replace" with "never fetch", which turned every
        // repair run into a no-op: a repair exists because the download failed,
        // so there is nothing on disk for it to work from. Merging is now
        // unconditional in the route, so this flag carries only the second
        // half of that meaning.
        reanalyze: job.reanalyze,
        // Download only: no vision pass, no AI analysis, no ollama at all.
        // A batched pass does that work later with the model already warm.
        skipAi: job.skipAi,
      }),
    });
    // The body is read even on a non-2xx. The route answers a failed Instagram
    // download with 502 *and* a JSON body naming the real cause
    // (`challenge_required`, `login required`, ...), and that string is what
    // decides between the ordinary backoff and the long auth one. Looking only
    // at res.status would flatten every failure into "analyze HTTP 502".
    const result = (await res.json().catch(() => null)) as AnalyzeResult | null;
    if (!res.ok || !result) throw new Error(result?.error || `analyze HTTP ${res.status}`);
    await markJobDone(job.id);
    // Isolated from the try/catch above it: a Telegram delivery failure here
    // must not re-trigger handleFailure and undo an already-successful job.
    try {
      await sendResultToTelegram(job, result);
    } catch (notifyErr) {
      log.error(
        `Job ${job.id} succeeded but Telegram notification failed`,
        notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr))
      );
    }
  } catch (err) {
    // dispatch() is invoked fire-and-forget (`void dispatch(...)`), so if
    // handleFailure itself throws (e.g. DB unreachable while recording the
    // failure), that must not become an unhandled promise rejection.
    try {
      await handleFailure(job, err, log);
    } catch (failureErr) {
      log.error(
        `Job ${job.id} failure handling itself failed`,
        failureErr instanceof Error ? failureErr : new Error(String(failureErr))
      );
    }
  } finally {
    onSettle();
  }
}

export async function tick(state: WorkerState): Promise<void> {
  const now = Date.now();

  if (!state.igBusy && now >= state.igNextAllowedAt) {
    // Set busy before awaiting the claim — otherwise an overlapping tick
    // (setInterval doesn't wait for this one to finish) could also see
    // igBusy===false and claim a second Instagram job concurrently.
    state.igBusy = true;
    const job = await claimNextInstagramJob();
    if (job) {
      void dispatch(job, () => {
        state.igBusy = false;
        state.igNextAllowedAt = Date.now() + computeJitterDelayMs();
      });
    } else {
      state.igBusy = false;
    }
  }

  while (state.otherInFlight < OTHER_CONCURRENCY_CAP) {
    // Same race guard as above: reserve the slot before awaiting the claim.
    state.otherInFlight++;
    const job = await claimNextOtherJob();
    if (!job) {
      state.otherInFlight--;
      break;
    }
    void dispatch(job, () => {
      state.otherInFlight--;
    });
  }

  if (!state.reanalyzeBusy) {
    // Reserved before the await for the same reason as the lane above: two
    // overlapping ticks must not both see it free.
    state.reanalyzeBusy = true;
    const job = await claimNextReanalyzeJob();
    if (job) {
      void dispatch(job, () => {
        state.reanalyzeBusy = false;
      });
    } else {
      state.reanalyzeBusy = false;
    }
  }

  while (state.otherInFlight < OTHER_CONCURRENCY_CAP) {
    state.otherInFlight++;
    const job = await claimNextTranscribeJob();
    if (!job) {
      state.otherInFlight--;
      break;
    }
    void dispatchTranscribe(job).finally(() => {
      state.otherInFlight--;
    });
  }
}

let workerState: WorkerState | null = null;

export function startJobQueueWorker(intervalMs = 2000): NodeJS.Timeout {
  workerState = createInitialWorkerState();
  return setInterval(() => void tick(workerState!), intervalMs);
}
