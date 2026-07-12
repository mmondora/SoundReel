import {
  claimNextInstagramJob,
  claimNextOtherJob,
  markJobDone,
  markJobFailed,
  scheduleJobRetry,
  type JobQueueRow,
  type JobPlatform,
} from '../utils/jobQueue';
import { sendTelegramMessage, formatAnalysisError, formatTelegramResponse, type AnalyzeResult } from '../routes/telegram';
import { Logger } from './debugLogger';

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
    const token = process.env.TELEGRAM_BOT_TOKEN;
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
}

let workerState: WorkerState | null = null;

export function startJobQueueWorker(intervalMs = 2000): NodeJS.Timeout {
  workerState = createInitialWorkerState();
  return setInterval(() => void tick(workerState!), intervalMs);
}
