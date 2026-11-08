/**
 * Follows Spotify links handed to Spooty until their downloads end.
 *
 * Spooty only reports progress through its API, and SoundReel has no Spotify
 * credentials of its own, so this is the single source of truth for:
 *   - metadata (artist / title / cover) of the song(s) the link points at
 *   - "did the download finish or fail, and why" (status 4 Completed / 5 Error)
 *
 * State lives in `spooty_requests`, so a restart loses nothing.
 */
import { getEntry, updateEntry, appendActionLog, createActionLog } from '../utils/db';
import { onEntrySongsAvailable } from './shareFlow';
import { listDueSpootyRequests, patchSpootyRequest, type SpootyRequest } from './spootyRequests';
import {
  isFinalSpootyStatus,
  listSpootyPlaylists,
  listSpootyTracks,
  SpootyStatus,
  type SpootyPlaylist,
  type SpootyTrack,
} from './spootyClient';
import { captionFor, ensureAtSpooty, persistCovers, songsFromSpooty } from './linkIngest';
import { enqueueSongEnrichment } from './songEnrichmentHook';
import { parseSpotifyLink, type SpotifyRef } from './spotifyLink';
import { patchSongUserMeta, songKey } from './songMeta';
import type { Entry } from '../types';
import { logError, logInfo, logWarning } from '../utils/logger';

export type NotifyFn = (chatId: number, html: string) => Promise<void>;

export interface WatcherOptions {
  notify?: NotifyFn;
  now?: () => number;
  intervalMs?: number;
}

/** After this long without a verdict we give up and say so. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Poll fast while a download is young, slow down as it ages. */
export function nextDelayMs(ageMs: number): number {
  if (ageMs < 60_000) return 5_000;
  if (ageMs < 5 * 60_000) return 15_000;
  if (ageMs < 30 * 60_000) return 60_000;
  return 5 * 60_000;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "Error: yt-dlp exited with code 1: unable to download video data: HTTP Error 403" → readable. */
export function shortSpootyError(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(/^Error:\s*/i, '').replace(/^yt-dlp exited with code \d+:\s*/i, '').trim();
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

function entryLink(entryId: string): string {
  return `${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}/?entry=${entryId}`;
}

function label(ref: SpotifyRef, playlist: SpootyPlaylist, tracks: SpootyTrack[]): string {
  if (ref.kind === 'track' && tracks[0]) {
    return tracks[0].artist ? `${tracks[0].artist} – ${tracks[0].name}` : tracks[0].name;
  }
  return playlist.name || ref.url;
}

async function syncEntry(entry: Entry, ref: SpotifyRef, playlist: SpootyPlaylist, tracks: SpootyTrack[]): Promise<void> {
  const songs = songsFromSpooty(tracks, playlist, ref);
  if (songs.length === 0) return;
  const current = (entry.results.songs ?? []).filter((s) => s.source === 'spotify_link');
  const sig = (list: Array<{ title: string; artist: string; album: string | null }>): string =>
    JSON.stringify(list.map((s) => [s.title, s.artist, s.album]));
  const caption = captionFor(ref, playlist, songs);
  const cover = playlist.coverUrl ?? tracks[0]?.coverUrl ?? null;
  const unchanged = sig(current) === sig(songs) && entry.caption === caption && (!cover || entry.thumbnailUrl === cover);
  if (unchanged) return;
  const keep = (entry.results.songs ?? []).filter((s) => s.source !== 'spotify_link');
  await updateEntry(entry.id, {
    results: { ...entry.results, songs: [...keep, ...songs] },
    caption,
    ...(cover ? { thumbnailUrl: cover } : {}),
  });
  await persistCovers(tracks, playlist, ref);
  // the track list just changed (names arrive while Spooty works): genres and cover for the new songs too
  enqueueSongEnrichment(songs.map((s) => ({ artist: s.artist, title: s.title })));
  // A Mondrop share of this link that was waiting for its songs (playlist, recipients' notice) completes now.
  await onEntrySongsAvailable(entry.id);
}

async function finalize(
  r: SpootyRequest,
  entry: Entry,
  ref: SpotifyRef,
  playlist: SpootyPlaylist | null,
  tracks: SpootyTrack[],
  notify: NotifyFn | undefined,
  timeout = false,
): Promise<void> {
  const completed = tracks.filter((t) => t.status === SpootyStatus.Completed);
  const failed = tracks.filter((t) => t.status === SpootyStatus.Error);
  const ok = completed.length > 0;
  const reason = timeout
    ? 'timeout: Spooty non ha concluso entro 6 ore'
    : failed[0]?.error ?? playlist?.error ?? 'download fallito';

  await appendActionLog(
    entry.id,
    createActionLog('spooty_finished', {
      playlistId: playlist?.id ?? null,
      total: tracks.length,
      completed: completed.length,
      failed: failed.length,
      errors: failed.slice(0, 10).map((t) => ({ track: `${t.artist} - ${t.name}`, error: (t.error ?? '').slice(0, 300) })),
      playlistError: playlist?.error ?? null,
      timeout,
    }),
  );
  await updateEntry(entry.id, { status: ok ? 'completed' : 'error' });

  for (const t of completed) {
    try {
      await patchSongUserMeta(songKey(t.artist.trim(), t.name.trim()), { downloaded: true });
    } catch (err) {
      logWarning('spooty watcher: downloaded flag failed', { err: errMsg(err) });
    }
  }

  await patchSpootyRequest(r.id, { status: ok ? 'completed' : 'failed', lastError: ok ? null : reason });
  logInfo('spooty request finished', { entryId: entry.id, ok, completed: completed.length, failed: failed.length });

  if (r.chatId && notify) {
    const name = esc(playlist ? label(ref, playlist, tracks) : ref.url);
    const link = `🌐 <a href="${entryLink(entry.id)}">Apri in SoundReel</a>`;
    let html: string;
    if (ok && ref.kind === 'track') {
      html = `🎵 <b>Pronto</b>: ${name}\n${link}`;
    } else if (ok) {
      html = `🎵 <b>${name}</b>: scaricati ${completed.length}/${tracks.length} brani${failed.length ? ` (${failed.length} falliti)` : ''}\n${link}`;
    } else {
      html = `❌ <b>${name}</b> non scaricato da Spooty.\n${esc(shortSpootyError(reason))}\n🔁 Rimanda il link per riprovare.\n${link}`;
    }
    try {
      await notify(r.chatId, html);
    } catch (err) {
      logWarning('spooty watcher: notify failed', { err: errMsg(err) });
    }
  }
}

async function processRequest(
  r: SpootyRequest,
  getPlaylists: () => Promise<SpootyPlaylist[]>,
  opts: WatcherOptions,
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const entry = await getEntry(r.entryId);
  if (!entry) {
    await patchSpootyRequest(r.id, { status: 'failed', lastError: 'entry non trovata' });
    return true;
  }
  const ref = parseSpotifyLink(r.spotifyUrl);
  if (!ref) {
    await patchSpootyRequest(r.id, { status: 'failed', lastError: 'link Spotify non valido' });
    return true;
  }
  const ageMs = now() - r.createdAt.getTime();

  let playlist: SpootyPlaylist | null = null;
  let tracks: SpootyTrack[] = [];
  try {
    if (r.spootyPlaylistId !== null) {
      playlist = (await getPlaylists()).find((p) => p.id === r.spootyPlaylistId) ?? null;
    }
    if (playlist) {
      tracks = await listSpootyTracks(playlist.id);
    } else {
      // Not known yet, or deleted from the Spooty UI: find-before-add, never duplicate.
      const sp = await ensureAtSpooty(ref);
      if (!sp.accepted) throw new Error(sp.error ?? 'Spooty non raggiungibile');
      playlist = sp.playlist;
      tracks = sp.tracks;
      if (playlist) {
        await patchSpootyRequest(r.id, { spootyPlaylistId: playlist.id, status: 'tracking' });
        if (r.spootyPlaylistId === null) {
          await appendActionLog(entry.id, createActionLog('spooty_enqueued', { playlistId: playlist.id, tracks: tracks.length }));
        }
      }
    }
  } catch (err) {
    const msg = errMsg(err);
    if (ageMs > MAX_AGE_MS) {
      await finalize(r, entry, ref, null, [], opts.notify, true);
      return true;
    }
    await patchSpootyRequest(r.id, { attempts: r.attempts + 1, lastError: msg, nextCheckInMs: nextDelayMs(ageMs) });
    return false;
  }

  if (!playlist) {
    await patchSpootyRequest(r.id, { nextCheckInMs: 5_000 });
    return false;
  }

  await syncEntry(entry, ref, playlist, tracks);

  const settled = tracks.length > 0 && tracks.every((t) => isFinalSpootyStatus(t.status));
  const unreadable = playlist.error !== null && tracks.length === 0;
  if (settled || unreadable) {
    await finalize(r, entry, ref, playlist, tracks, opts.notify);
    return true;
  }
  if (ageMs > MAX_AGE_MS) {
    await finalize(r, entry, ref, playlist, tracks, opts.notify, true);
    return true;
  }
  await patchSpootyRequest(r.id, { lastError: null, nextCheckInMs: nextDelayMs(ageMs) });
  return false;
}

/** One pass over the due requests. Exported for tests and for an on-demand kick. */
export async function pollSpootyRequests(opts: WatcherOptions = {}): Promise<{ checked: number; finalized: number }> {
  const due = await listDueSpootyRequests();
  if (due.length === 0) return { checked: 0, finalized: 0 };

  let playlists: SpootyPlaylist[] | null = null;
  const getPlaylists = async (): Promise<SpootyPlaylist[]> => {
    playlists ??= await listSpootyPlaylists();
    return playlists;
  };

  let finalized = 0;
  for (const r of due) {
    try {
      if (await processRequest(r, getPlaylists, opts)) finalized += 1;
    } catch (err) {
      logError('spooty watcher: request failed', err);
      try {
        await patchSpootyRequest(r.id, { attempts: r.attempts + 1, lastError: errMsg(err), nextCheckInMs: 60_000 });
      } catch {
        /* nothing more we can do for this row; the next tick tries again */
      }
    }
  }
  return { checked: due.length, finalized };
}

export function startSpootyWatcher(opts: WatcherOptions = {}): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await pollSpootyRequests(opts);
    } catch (err) {
      logError('spooty watcher tick failed', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 5_000);
  void tick();
  return () => clearInterval(timer);
}
