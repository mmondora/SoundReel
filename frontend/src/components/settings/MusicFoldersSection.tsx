import { useEffect, useRef, useState } from 'react';
import { interpolate, useLanguage } from '../../i18n';
import { fetchMe } from '../../services/api';
import { useMusicFolders } from '../../hooks/useMusicFolders';
import type { MusicFolder } from '../../types';
import {
  STATUS_KEY,
  extraFolders,
  folderError,
  withAdded,
  withEnabled,
  withLabel,
  without,
} from '../../utils/musicFolders';
import type { FolderError } from '../../utils/musicFolders';
import { FolderPicker } from './FolderPicker';
import '../../styles/library.css';

/** Words for what the folder endpoints answer. */
function useFolderErrorText(): (error: FolderError) => string {
  const { t } = useLanguage();
  return (error) => {
    const base = interpolate(t[error.key] as string, { detail: error.detail });
    return error.path ? interpolate(t.mfErrAt, { path: error.path, message: base }) : base;
  };
}

function Label({ folder, disabled, onCommit }: { folder: MusicFolder; disabled: boolean; onCommit: (label: string) => void }) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(folder.label);
  const cancelled = useRef(false);
  // The server may normalise the label (or another tab changed it): follow it.
  useEffect(() => { setDraft(folder.label); }, [folder.label]);

  function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (next !== folder.label) onCommit(next);
    else setDraft(folder.label);
  }

  return (
    <input
      className="mf-label"
      type="text"
      value={draft}
      disabled={disabled}
      aria-label={interpolate(t.mfLabelOf, { path: folder.path })}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(folder.label);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function StatusLine({ folder }: { folder: MusicFolder }) {
  const { t, language } = useLanguage();
  const locale = language === 'it' ? 'it-IT' : 'en-GB';
  const when = folder.scannedAt ? new Date(folder.scannedAt) : null;
  const time = when && !Number.isNaN(when.getTime()) ? when.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : null;
  return (
    <div className="mf-status">
      <span className={`mf-chip mf-chip-${folder.status}`} data-status={folder.status}>{t[STATUS_KEY[folder.status]] as string}</span>
      {folder.status !== 'off' && (
        <span>{folder.files === 1 ? t.mfFileOne : interpolate(t.mfFiles, { n: folder.files })}</span>
      )}
      {folder.status !== 'off' && <span>{time ? interpolate(t.mfScannedAt, { time }) : t.mfNeverScanned}</span>}
      {folder.truncated && <span className="mf-warn">⚠ {t.mfTruncated}</span>}
    </div>
  );
}

/**
 * "Cartelle musica" in the web configuration (admin only): the folders the local-files search reads next to
 * Spooty's library. Anything but an admin sees nothing at all — the endpoints answer 403 to them anyway.
 */
export function MusicFoldersSection() {
  const { t } = useLanguage();
  const describe = useFolderErrorText();
  const [admin, setAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((me) => { if (!cancelled) setAdmin(me.isAdmin === true); })
      .catch(() => { if (!cancelled) setAdmin(false); });
    return () => { cancelled = true; };
  }, []);

  if (admin !== true) return null;
  return <AdminFolders t={t} describe={describe} />;
}

function AdminFolders({ t, describe }: { t: ReturnType<typeof useLanguage>['t']; describe: (e: FolderError) => string }) {
  const folders = useMusicFolders();
  const [picking, setPicking] = useState(false);
  const { status, payload, busy, opError } = folders;
  const list = payload?.folders ?? [];
  const extras = extraFolders(list);
  const taken = new Set(extras.map((f) => f.path));

  return (
    <section className="settings-section" aria-labelledby="mf-title" data-testid="music-folders">
      <h2 id="mf-title">{t.mfTitle}</h2>
      <p className="mf-intro">{t.mfIntro}</p>

      {status === 'loading' && <p className="mf-busy" role="status">{t.mfLoading}</p>}

      {status === 'error' && (
        <div className="mf-error" role="alert">
          <strong>{t.mfLoadError}</strong>{' '}
          <span>{folders.loadError ? describe(folderError(folders.loadError)) : ''}</span>{' '}
          <button type="button" className="mf-btn" onClick={folders.reload}>{t.mfRetry}</button>
        </div>
      )}

      {status === 'ready' && payload && (
        <>
          {payload.roots.length > 0 && (
            <p className="mf-roots">
              {t.mfRoots}:{' '}
              {payload.roots.map((r, i) => (
                <span key={r.path}>{i > 0 && ', '}<code>{r.path}</code> ({r.label})</span>
              ))}
            </p>
          )}

          <ul className="mf-list" aria-label={t.mfTitle}>
            {list.map((folder) => (
              <li
                key={folder.id}
                className={`mf-item${opError?.path === folder.path ? ' is-bad' : ''}`}
                data-folder={folder.builtIn ? 'builtin' : 'extra'}
              >
                <div className="mf-item-main">
                  {folder.builtIn ? (
                    <span className="mf-label-static">{folder.label} <span className="mf-pill">{t.mfBuiltIn}</span></span>
                  ) : (
                    <Label
                      folder={folder}
                      disabled={busy}
                      onCommit={(label) => void folders.save(withLabel(list, folder.id, label))}
                    />
                  )}
                  <span className="mf-path">{folder.path}</span>
                  {folder.builtIn && <span className="mf-note">{t.mfBuiltInNote}</span>}
                </div>
                {!folder.builtIn && (
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={folder.enabled}
                      disabled={busy}
                      aria-label={interpolate(t.mfSwitchOf, { label: folder.label })}
                      onChange={(e) => void folders.save(withEnabled(list, folder.id, e.target.checked))}
                    />
                    <span className="toggle-slider" />
                  </label>
                )}
                {!folder.builtIn && (
                  <button
                    type="button"
                    className="mf-btn mf-btn-danger"
                    disabled={busy}
                    title={t.mfRemoveHint}
                    aria-label={interpolate(t.mfRemoveOf, { label: folder.label })}
                    onClick={() => void folders.save(without(list, folder.id))}
                  >
                    {t.mfRemove}
                  </button>
                )}
                <StatusLine folder={folder} />
              </li>
            ))}
          </ul>

          {extras.length === 0 && <p className="mf-note">{t.mfNoExtra}</p>}

          {opError && !picking && <p className="mf-error" role="alert">{describe(opError)}</p>}

          <div className="mf-actions">
            <button type="button" className="mf-btn" disabled={busy} onClick={() => { folders.clearError(); setPicking(true); }}>
              + {t.mfAdd}
            </button>
            <button type="button" className="mf-btn" disabled={busy} onClick={() => void folders.rescan()}>
              ↻ {t.mfRescan}
            </button>
            {busy && <span className="mf-busy" role="status">{t.mfSaving}</span>}
          </div>

          <p className="mf-note">{t.mfMountNote}</p>
        </>
      )}

      {picking && (
        <FolderPicker
          taken={taken}
          error={opError}
          describe={describe}
          onClose={() => { folders.clearError(); setPicking(false); }}
          onPick={async (path) => {
            const ok = await folders.save(withAdded(list, path));
            if (ok) setPicking(false);
            return ok;
          }}
        />
      )}
    </section>
  );
}
