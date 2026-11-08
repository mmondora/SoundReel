/**
 * The download worker. It drains the queue held in `song_files` (highest priority first, two at a time):
 * every job first tries to REUSE a file (library; the media server's own file, ADOPTED, never copied — ADR-0010),
 * and only then asks the instaloader sidecar to fetch the song from YouTube. A downloaded file lands in the
 * library (<library>/SoundReel/), the library cache is invalidated, the song is flagged as downloaded and a push
 * of the store to the media server is requested (the web "puts it on the media server", spec W6).
 */
import { promises as fs } from 'node:fs';
import { invalidateLibraryTracks } from './libraryCache';
import { logActivity, songLabel, SYSTEM_ACTOR } from './activityLog';
import { adoptMediaServerFile, findLibraryMatch, findMediaServerMatch, MediaVolumeMissingError } from './fileResolver';
import { requestMediaPublish } from './mediaPublish';
import { checkMp3, libraryRoot, placeIntoStore, storeDir, sweepStaleFiles } from './musicStore';
import { retireMediaServerCopies } from './retireCopies';
import { patchSongUserMeta } from './songMeta';
import {
  claimNextDownloads,
  deferJob,
  markAttemptFailed,
  markReady,
  releaseStaleDownloads,
  type FailureOutcome,
  type SongFile,
  type SongFileSource,
} from './songFiles';
import { requestYtAudio, stagingDir, type YtAudioCode, type YtAudioResult } from './ytAudioClient';
import path from 'node:path';
import { logError, logInfo, logWarning } from '../utils/logger';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type JobOutcome = 'ready' | 'retry' | 'failed' | 'no_source';

/** How long a song that is on the box waits when the box's USB drive is away (no attempt is counted). */
export const VOLUME_WAIT_MS = 10 * 60_000;

const RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
const MAX_ATTEMPTS = 5;
const BLOCKED_RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
const MAX_BLOCKED_ATTEMPTS = 4;

const HUMAN: Partial<Record<YtAudioCode, string>> = {
  age_restricted: "Video con restrizione d'età: serve un altro link YouTube",
  unavailable: 'Video non disponibile: serve un altro link YouTube',
  no_source: 'Nessun video adatto trovato: serve un link YouTube',
};

/** What to do after a failed attempt. `failures` counts this one. */
export function failurePlan(code: YtAudioCode, error: string, failures: number): FailureOutcome {
  const message = HUMAN[code] ?? error;
  if (code === 'no_source' || code === 'age_restricted' || code === 'unavailable') {
    return { error: message, terminal: 'no_source' };
  }
  if (code === 'bad_request') return { error: message, terminal: 'failed' };
  if (code === 'blocked') {
    return failures >= MAX_BLOCKED_ATTEMPTS
      ? { error: message, terminal: 'failed' }
      : { error: message, retryInMs: BLOCKED_RETRY_MS[Math.min(failures, BLOCKED_RETRY_MS.length) - 1] };
  }
  return failures >= MAX_ATTEMPTS
    ? { error: message, terminal: 'failed' }
    : { error: message, retryInMs: RETRY_MS[Math.min(failures, RETRY_MS.length) - 1] };
}

const SOURCE_TEXT: Record<SongFileSource, string> = {
  library: 'già nella libreria su disco (riusata)',
  mediaserver: 'già sul media server (adottata, nessuna copia)',
  ytdlp: 'scaricata da YouTube',
  existing: 'riusata',
};

async function finish(
  job: SongFile,
  placed: { relPath: string | null; bytes: number; mtimeMs: number },
  source: SongFileSource,
  match: string,
  extra: { durationS?: number | null; videoId?: string | null; original?: { relPath: string; url: string } | null } = {},
): Promise<void> {
  await markReady(
    job.songKey,
    { source, relPath: placed.relPath, bytes: placed.bytes, mtimeMs: placed.mtimeMs, match, ...extra },
    { artist: job.artist, title: job.title, album: job.album, coverUrl: job.coverUrl },
  );
  invalidateLibraryTracks();
  try {
    await patchSongUserMeta(job.songKey, { downloaded: true });
  } catch (err) {
    logWarning('song downloaded flag not set', { songKey: job.songKey, err: errMsg(err) });
  }
  logActivity('download', 'done', `«${songLabel(job, job.songKey)}» pronta: ${SOURCE_TEXT[source]}`, SYSTEM_ACTOR, {
    songKey: job.songKey, source, bytes: placed.bytes, requestedBy: job.requestedBy, priority: job.priority,
  });
}

async function fail(job: SongFile, code: YtAudioCode, error: string): Promise<JobOutcome> {
  const plan = failurePlan(code, error, job.attempts + 1);
  await markAttemptFailed(job.songKey, plan);
  logInfo('song download failed', { songKey: job.songKey, code, terminal: plan.terminal ?? null, retryInMs: plan.retryInMs ?? null, error });
  if (plan.terminal) {
    // only the end of the road is worth a line in the activity trail; retries would drown it
    logActivity('download', 'failed', `«${songLabel(job, job.songKey)}» non scaricata: ${plan.error}`, SYSTEM_ACTOR, {
      songKey: job.songKey, code, terminal: plan.terminal, attempts: job.attempts + 1, requestedBy: job.requestedBy,
    });
  }
  return plan.terminal ?? 'retry';
}

/** One job, start to finish. Never throws. */
export async function processDownload(job: SongFile): Promise<JobOutcome> {
  try {
    // A person picked this video: that version is wanted, so nothing is "reused".
    if (!job.videoUrlOverride) {
      const lib = await findLibraryMatch(job.artist, job.title);
      if (lib) {
        await finish(job, { relPath: lib.relPath, ...lib.facts }, 'library', 'name');
        logInfo('song reused from library', { songKey: job.songKey, relPath: lib.relPath });
        return 'ready';
      }
      const hit = await findMediaServerMatch(job.artist, job.title);
      if (hit) {
        try {
          // The song IS the box's file: nothing is copied, clients are pointed at it (ADR-0010).
          const adopted = await adoptMediaServerFile(hit);
          if (adopted) {
            await finish(job, { relPath: null, bytes: adopted.bytes, mtimeMs: adopted.mtimeMs }, 'mediaserver', 'index', {
              durationS: adopted.durationS,
              original: adopted.original,
            });
            logInfo('song adopted from media server (no copy)', { songKey: job.songKey, from: hit.relPath });
            return 'ready';
          }
        } catch (err) {
          if (err instanceof MediaVolumeMissingError) {
            // The song IS on the box, whose drive is unplugged: wait for it instead of downloading a duplicate.
            await deferJob(job.songKey, VOLUME_WAIT_MS, err.message);
            logInfo('song waits for the media server volume', { songKey: job.songKey, retryInMs: VOLUME_WAIT_MS });
            return 'retry';
          }
          // Adopting is an optimisation: YouTube is still there.
          logWarning('adopting the media server file failed, falling back to YouTube', { songKey: job.songKey, err: errMsg(err) });
        }
      }
    }

    const res: YtAudioResult = await requestYtAudio({
      songKey: job.songKey,
      artist: job.artist,
      title: job.title,
      album: job.album,
      coverUrl: job.coverUrl,
      expectedDurationS: job.expectedDurationS,
      videoUrl: job.videoUrlOverride,
    });
    if (!res.ok) return await fail(job, res.code, res.error);

    const check = await checkMp3(res.path);
    if (!check.ok) {
      await fs.rm(res.path, { force: true }).catch(() => undefined);
      return await fail(job, 'error', `download non valido: ${check.reason ?? 'sconosciuto'}`);
    }
    const placed = await placeIntoStore(res.path, job.artist, job.title, { replaceRelPath: job.relPath });
    await finish(job, placed, 'ytdlp', job.videoUrlOverride ? 'override' : 'search', {
      durationS: res.durationS,
      videoId: res.videoId || null,
    });
    logInfo('song downloaded', { songKey: job.songKey, videoId: res.videoId, bytes: placed.bytes, score: res.score });
    requestMediaPublish(); // the web "puts it on the media server": push the store to the box now, not at 04:00
    return 'ready';
  } catch (err) {
    logError('song download crashed', { songKey: job.songKey, err: errMsg(err) });
    try {
      return await fail(job, 'error', errMsg(err));
    } catch (inner) {
      logError('song download failure could not be recorded', { songKey: job.songKey, err: errMsg(inner) });
      return 'retry';
    }
  }
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60_000;

/** Drop what interrupted work left behind: half-copied `*.part` files and old staging downloads. */
export async function sweepLeftovers(): Promise<number> {
  const root = libraryRoot();
  const parts = root
    ? await sweepStaleFiles(path.join(root, storeDir()), { maxAgeMs: HOUR_MS, match: (n) => n.endsWith('.part') })
    : [];
  const staged = await sweepStaleFiles(stagingDir(), {
    maxAgeMs: 24 * HOUR_MS,
    match: (n) => n.startsWith('sf-') || n.startsWith('ms-') || n.startsWith('.work-'),
  });
  if (parts.length + staged.length > 0) logInfo('swept leftovers', { parts: parts.length, staging: staged.length });
  return parts.length + staged.length;
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

let wake: () => void = () => undefined;

/** Start the queue now instead of at the next poll (a person is waiting for a song). */
export function wakeSongDownloader(): void {
  wake();
}

export function startSongDownloader(options: { concurrency?: number; pollMs?: number; staleAfterMs?: number } = {}): () => void {
  if (['0', 'false', 'off'].includes((process.env.SONG_DOWNLOADER_ENABLED ?? '').toLowerCase())) {
    logInfo('song downloader disabled (SONG_DOWNLOADER_ENABLED=0)');
    return () => undefined;
  }
  if (!libraryRoot()) {
    logWarning('song downloader not started: MUSIC_LIBRARY_PATH is not set');
    return () => undefined;
  }
  const concurrency = options.concurrency ?? (Number(process.env.SONG_DOWNLOAD_CONCURRENCY) || 2);
  const pollMs = options.pollMs ?? 3_000;
  const staleAfterMs = options.staleAfterMs ?? 20 * 60_000;
  const running = new Set<string>();
  let stopped = false;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const free = concurrency - running.size;
      if (free <= 0) return;
      for (const job of await claimNextDownloads(free)) {
        running.add(job.songKey);
        void processDownload(job).finally(() => {
          running.delete(job.songKey);
          wake();
        });
      }
    } catch (err) {
      logWarning('song download poll failed', { err: errMsg(err) });
    } finally {
      ticking = false;
    }
  };

  wake = () => {
    if (!stopped) setImmediate(() => void tick());
  };

  // Nothing of ours is running right after a start: whatever is "downloading" belongs to a dead process.
  void releaseStaleDownloads(0)
    .then((n) => {
      if (n > 0) logInfo('requeued interrupted song downloads', { count: n });
    })
    .catch((err) => logWarning('stale downloads not released', { err: errMsg(err) }))
    .finally(() => void tick());

  void sweepLeftovers().catch((err) => logWarning('leftover sweep failed', { err: errMsg(err) }));

  // Copies 2.7.0 made from the box's files: retire them once the box vouches for the original (ADR-0010), then now and then.
  const retire = (): void => {
    void retireMediaServerCopies().catch((err) => logWarning('retiring media server copies failed', { err: errMsg(err) }));
  };
  const retireFirst = setTimeout(retire, 90_000);
  const retireLoop = setInterval(retire, 6 * HOUR_MS);
  retireFirst.unref();
  retireLoop.unref();

  const poll = setInterval(() => void tick(), pollMs);
  const sweep = setInterval(() => {
    void releaseStaleDownloads(staleAfterMs).catch(() => undefined);
  }, 60_000);
  const housekeeping = setInterval(() => {
    void sweepLeftovers().catch(() => undefined);
  }, 6 * HOUR_MS);
  poll.unref();
  sweep.unref();
  housekeeping.unref();

  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(sweep);
    clearInterval(housekeeping);
    clearTimeout(retireFirst);
    clearInterval(retireLoop);
    wake = () => undefined;
  };
}
