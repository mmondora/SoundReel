import { promises as fs } from 'fs';
import path from 'path';
import {
  claimNextInstagramJob,
  claimNextOtherJob,
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

export interface WorkerState {
  igBusy: boolean;
  igNextAllowedAt: number; // epoch ms
  otherInFlight: number;
}

export function createInitialWorkerState(): WorkerState {
  return { igBusy: false, igNextAllowedAt: 0, otherInFlight: 0 };
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

async function handleFailure(job: JobQueueRow, err: unknown, log: Logger): Promise<void> {
  log.error(`Job ${job.id} (${job.platform}) failed`, err instanceof Error ? err : new Error(String(err)));
  const attempts = job.attempts + 1;
  const backoff = computeBackoffMs(job.platform, attempts);
  if (backoff === null) {
    await markJobFailed(job.id);
    const token = job.notify ? process.env.TELEGRAM_BOT_TOKEN : null;
    if (token) {
      await sendTelegramMessage(
        job.chatId,
        `❌ Analisi fallita dopo ${attempts} tentativi.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`,
        token
      );
    }
    return;
  }
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
      // no attempt burned, just a terminal failure.
      log.warn(`Job ${job.id}: audio mancante su disco (${audioPath})`);
      await markJobFailed(job.id);
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

    if (asr.status === 'error') {
      // A service that answered and then failed is a real failure: let the
      // existing backoff table count this attempt.
      await handleFailure(job, new Error(asr.reason || 'whisper error'), log);
      return;
    }

    if (asr.text) {
      await updateEntry(job.entryId, { 'results.transcript': asr.text });
      await enqueueJob({
        entryId: job.entryId,
        sourceUrl: job.sourceUrl,
        platform: job.platform,
        chatId: job.chatId,
        inputUser: job.inputUser,
        notify: false,
        kind: 'analyze',
        priority: job.priority,
      });
    }

    await markJobDone(job.id);
  } catch (err) {
    // dispatchTranscribe is invoked fire-and-forget (`void dispatchTranscribe(...)`),
    // so any unexpected failure here (e.g. DB unreachable while recording the
    // result) must not become an unhandled promise rejection.
    log.error(
      `Job ${job.id}: dispatchTranscribe unexpected failure`,
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

async function dispatch(job: JobQueueRow, onSettle: () => void): Promise<void> {
  const log = new Logger('jobQueueWorker');
  try {
    const internalUrl = `http://127.0.0.1:${process.env.PORT || 8080}/api/analyze`;
    const res = await fetch(internalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: job.sourceUrl, channel: 'telegram', user: job.inputUser }),
    });
    if (!res.ok) throw new Error(`analyze HTTP ${res.status}`);
    const result = (await res.json()) as AnalyzeResult;
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
