import { useCallback, useEffect, useState } from 'react';
import { interpolate, useLanguage } from '../../i18n';
import { browseMusicFolders } from '../../services/api';
import type { FolderBrowse } from '../../types';
import { parseApiError } from '../../utils/apiError';
import { folderError } from '../../utils/musicFolders';
import type { FolderError } from '../../utils/musicFolders';
import { DialogFrame } from '../manager/DialogFrame';
import '../../styles/library.css';

export interface FolderPickerProps {
  /** Folders already in the list: their "add" button is off. */
  taken: ReadonlySet<string>;
  /** Why the last attempt to add was refused (shown here, so the dialog stays open on a refusal). */
  error: FolderError | null;
  /** Adds the folder; resolves true when it was accepted (the dialog is then closed by the caller). */
  onPick: (path: string) => Promise<boolean>;
  onClose: () => void;
  /** Words for an error (shared with the section). */
  describe: (error: FolderError) => string;
}

/**
 * Add a folder by browsing instead of typing a path: the places the container allows (`MUSIC_EXTRA_ROOTS`) and,
 * from there, their subfolders. The server decides what may be listed; this only walks what it shows.
 */
export function FolderPicker({ taken, error, onPick, onClose, describe }: FolderPickerProps) {
  const { t } = useLanguage();
  const [view, setView] = useState<FolderBrowse | null>(null);
  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState<FolderError | null>(null);
  const [adding, setAdding] = useState(false);

  const open = useCallback((path: string | null) => {
    setLoading(true);
    setBrowseError(null);
    Promise.resolve()
      .then(() => browseMusicFolders(path))
      .then((next) => setView(next))
      .catch((err: unknown) => setBrowseError(folderError(parseApiError(err))))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { open(null); }, [open]);

  async function add(path: string) {
    setAdding(true);
    try {
      await onPick(path);
    } finally {
      setAdding(false);
    }
  }

  const shownError = browseError ?? error;
  const here = view?.path ?? null;

  return (
    <DialogFrame title={t.mfPickerTitle} onClose={onClose} className="mgr-dialog-wide">
      <p className="mf-picker-path" data-testid="picker-path">
        {here ? <><span className="sr-only">{t.mfPickerCurrent}: </span>{here}</> : t.mfPickerRoots}
      </p>

      <div className="mf-actions">
        {view && here !== null && (
          <>
            <button type="button" className="mf-btn" onClick={() => open(view.parent)} disabled={loading || adding}>
              ↑ {t.mfPickerUp}
            </button>
            <button
              type="button"
              className="mf-btn"
              onClick={() => void add(here)}
              disabled={loading || adding || taken.has(here)}
            >
              {t.mfPickerHere}
            </button>
          </>
        )}
      </div>

      {shownError && (
        <p className="mf-error" role="alert">
          {describe(shownError)}
        </p>
      )}

      {loading && <p className="mf-busy" role="status">{t.mfPickerLoading}</p>}

      {!loading && view && (
        view.dirs.length === 0 ? (
          <p className="mf-note">{here === null ? t.mfPickerNoRoots : t.mfPickerEmpty}</p>
        ) : (
          <ul className="mf-picker-list" aria-label={here ?? t.mfPickerRoots}>
            {view.dirs.map((dir) => (
              <li key={dir.path} className="mf-picker-row">
                <button
                  type="button"
                  className="mf-picker-open"
                  aria-label={interpolate(t.mfPickerOpen, { name: dir.name })}
                  onClick={() => open(dir.path)}
                  disabled={adding}
                >
                  📁 {dir.name}
                </button>
                <button
                  type="button"
                  className="mf-btn"
                  aria-label={interpolate(t.mfPickerAdd, { name: dir.name })}
                  onClick={() => void add(dir.path)}
                  disabled={adding || taken.has(dir.path)}
                >
                  {t.mfAdd}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </DialogFrame>
  );
}
