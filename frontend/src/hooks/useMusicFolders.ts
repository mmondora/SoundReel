import { useCallback, useEffect, useRef, useState } from 'react';
import { getMusicFolders, rescanMusicFolders, saveMusicFolders } from '../services/api';
import type { MusicFolderInput, MusicFoldersPayload } from '../types';
import { parseApiError } from '../utils/apiError';
import type { ApiErrorInfo } from '../utils/apiError';
import { folderError, needsPolling, normalizeMusicFolders } from '../utils/musicFolders';
import type { FolderError } from '../utils/musicFolders';

/** While a scan runs the list is asked again this often. */
export const FOLDERS_POLL_MS = 3000;
/** … for at most this many times (10 minutes): a server stuck on "pending" must not be polled forever. */
export const FOLDERS_POLL_MAX = 200;

export type FoldersStatus = 'loading' | 'ready' | 'error';

export interface MusicFolders {
  status: FoldersStatus;
  payload: MusicFoldersPayload | null;
  /** Why the list could not be loaded. */
  loadError: ApiErrorInfo | null;
  /** True while a change is being saved (the controls wait for it). */
  busy: boolean;
  /** Why the last change was refused, in terms of the folder the server blamed. */
  opError: FolderError | null;
  reload: () => void;
  /** Replaces the list of extra folders. Resolves true when the server accepted it. */
  save: (folders: MusicFolderInput[]) => Promise<boolean>;
  rescan: () => Promise<void>;
  clearError: () => void;
}

/**
 * The music folders of the web configuration (admin only). Loads the list, asks again every few seconds while any
 * folder is being scanned, and applies each change by sending the WHOLE list (the server replaces it) and
 * showing what it answers.
 */
export function useMusicFolders(): MusicFolders {
  const [status, setStatus] = useState<FoldersStatus>('loading');
  const [payload, setPayload] = useState<MusicFoldersPayload | null>(null);
  const [loadError, setLoadError] = useState<ApiErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<FolderError | null>(null);
  const [round, setRound] = useState(0);
  const polls = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async (silent: boolean) => {
    try {
      const next = normalizeMusicFolders(await getMusicFolders());
      if (!alive.current) return;
      setPayload(next);
      setStatus('ready');
      setLoadError(null);
    } catch (err) {
      if (!alive.current) return;
      // A failed poll leaves what is on screen; only the first load shows the failure.
      if (!silent) {
        setStatus('error');
        setLoadError(parseApiError(err));
      }
    }
  }, []);

  useEffect(() => {
    polls.current = 0;
    setStatus('loading');
    void load(false);
  }, [load, round]);

  // Keep asking while a scan runs or waits. One chain of timers per scanning period (it does not depend on the
  // renders in between), so an answer that fails changes nothing on screen and the next ask still happens.
  const scanning = payload !== null && needsPolling(payload.folders);
  useEffect(() => {
    if (!scanning) {
      polls.current = 0;
      return undefined;
    }
    let timer: number | undefined;
    let stopped = false;
    const schedule = () => {
      if (stopped || polls.current >= FOLDERS_POLL_MAX) return;
      timer = window.setTimeout(async () => {
        polls.current += 1;
        await load(true); // never rejects: it keeps what is on screen on failure
        schedule();
      }, FOLDERS_POLL_MS);
    };
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [scanning, load]);

  const save = useCallback(async (folders: MusicFolderInput[]): Promise<boolean> => {
    setBusy(true);
    setOpError(null);
    try {
      const next = normalizeMusicFolders(await saveMusicFolders(folders));
      if (!alive.current) return true;
      polls.current = 0;
      setPayload(next);
      setStatus('ready');
      return true;
    } catch (err) {
      if (alive.current) setOpError(folderError(parseApiError(err), folders));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const rescan = useCallback(async () => {
    setBusy(true);
    setOpError(null);
    try {
      await rescanMusicFolders();
      polls.current = 0;
      await load(true);
    } catch (err) {
      if (alive.current) setOpError(folderError(parseApiError(err)));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [load]);

  return {
    status,
    payload,
    loadError,
    busy,
    opError,
    reload: () => setRound((n) => n + 1),
    save,
    rescan,
    clearError: () => setOpError(null),
  };
}
