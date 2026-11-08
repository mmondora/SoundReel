import { useEffect, useRef, useState } from 'react';
import { fetchPlaylistShares, sharePlaylistWith, unsharePlaylistWith } from '../../services/api';
import { interpolate, useLanguage } from '../../i18n';
import type { MeResponse, PlaylistSummary } from '../../types';
import { errorMessage } from '../../utils/managerOps';
import { DialogFrame } from './DialogFrame';

export interface ShareDialogProps {
  playlist: PlaylistSummary;
  me: MeResponse | null;
  onChanged: (playlistId: string, sharedWith: string[]) => void;
  onClose: () => void;
}

/**
 * Owner-only sharing (backend: /api/playlists/:id/shares, /share). Every checkbox applies at once; a failed call
 * puts the checkbox back and shows why. The people who receive a playlist see it read-only.
 */
export function ShareDialog({ playlist, me, onChanged, onClose }: ShareDialogProps) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [family, setFamily] = useState<string[]>([]);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPlaylistShares(playlist.id)
      .then((r) => {
        if (cancelled) return;
        setSharedWith(r.sharedWith);
        setFamily(r.family);
      })
      .catch((err: unknown) => { if (!cancelled) setError(`${t.mgrShareError}: ${errorMessage(err)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per playlist
  }, [playlist.id]);

  // The list arrives after the dialog opened: put the focus on its first checkbox then.
  useEffect(() => {
    if (!loading) firstRef.current?.focus();
  }, [loading]);

  const nameOf = (id: string): string => me?.family.find((f) => f.id === id)?.displayName ?? id;

  async function toggle(userId: string, share: boolean) {
    if (busyUser) return;
    setBusyUser(userId);
    setError(null);
    try {
      const res = share ? await sharePlaylistWith(playlist.id, [userId]) : await unsharePlaylistWith(playlist.id, userId);
      setSharedWith(res.sharedWith);
      onChanged(playlist.id, res.sharedWith);
    } catch (err) {
      setError(`${t.mgrShareError}: ${errorMessage(err)}`);
    } finally {
      setBusyUser(null);
    }
  }

  const owner = playlist.ownerUser ?? me?.user ?? '';

  return (
    <DialogFrame title={interpolate(t.mgrShareTitle, { name: playlist.name })} onClose={onClose}>
      <p className="mgr-help">{interpolate(t.mgrShareOwner, { name: nameOf(owner) })}</p>
      <p className="mgr-help">{t.mgrShareHint}</p>

      {loading && <p className="mgr-help" role="status">{t.mgrShareLoading}</p>}
      {error && <p className="mgr-error" role="alert">{error}</p>}

      {!loading && family.length === 0 && !error && <p className="mgr-help">{t.mgrShareNobody}</p>}

      <ul className="mgr-share-list">
        {family.map((id) => {
          const checked = sharedWith.includes(id);
          return (
            <li key={id}>
              <label className="mgr-share-row">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busyUser !== null}
                  ref={id === family[0] ? firstRef : undefined}
                  onChange={() => void toggle(id, !checked)}
                />
                <span>{nameOf(id)}</span>
                <span className="mgr-share-id">{id}</span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="mgr-dialog-foot-inline">
        <button type="button" className="mgr-btn" onClick={onClose}>{t.mgrClose}</button>
      </div>
    </DialogFrame>
  );
}
