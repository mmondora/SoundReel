import { useState } from 'react';
import { interpolate, useLanguage } from '../../i18n';
import type { PlaylistManager } from '../../hooks/usePlaylistManager';
import type { OpKind } from '../../utils/managerOps';
import { hasProblems } from '../../utils/managerOps';
import { countLabel } from '../../utils/managerSongs';

/**
 * Progress while a batch runs, then a summary that never hides a partial failure: counts, the songs that
 * failed with the backend's reason, undo, and "retry the failures".
 */
export function ResultBar({ manager }: { manager: PlaylistManager }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const { busy, result, notice } = manager;

  const opLabel = (op: OpKind): string =>
    op === 'copy' ? t.mgrOpCopy : op === 'move' ? t.mgrOpMove : op === 'remove' ? t.mgrOpRemove : t.mgrOpUndo;

  if (busy) {
    return (
      <div className="mgr-result" role="status" aria-live="polite">
        <progress className="mgr-progress" max={Math.max(busy.total, 1)} value={busy.done} />
        <span>{interpolate(t.mgrProgress, { op: opLabel(busy.op), done: busy.done, total: busy.total })}</span>
      </div>
    );
  }

  if (!result) {
    return notice ? (
      <div className={`mgr-result mgr-notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
        <span>{notice.text}</span>
      </div>
    ) : <div className="mgr-result mgr-result-empty" role="status" aria-live="polite" />;
  }

  const { outcome } = result;
  const parts: string[] = [];
  if (outcome.added.length > 0) parts.push(interpolate(t.mgrResAdded, { n: outcome.added.length }));
  if (outcome.alreadyThere.length > 0) parts.push(interpolate(t.mgrResAlready, { n: outcome.alreadyThere.length }));
  if (outcome.removed.length > 0) parts.push(interpolate(t.mgrResRemoved, { n: outcome.removed.length }));
  if (outcome.failed.length > 0) parts.push(interpolate(t.mgrResFailed, { n: outcome.failed.length }));
  if (outcome.notAttempted.length > 0) parts.push(interpolate(t.mgrResNotTried, { n: outcome.notAttempted.length }));
  if (result.skippedPlaceholders > 0) parts.push(`${countLabel(result.skippedPlaceholders, t.mgrItems, t.mgrItemOne)} ${t.mgrMissingSong}`);
  if (parts.length === 0) parts.push(t.mgrResNothing);

  const problems = hasProblems(outcome);
  const canUndo = outcome.undo !== null && result.undone === undefined;
  const stepLabel = (step: 'add' | 'remove' | 'reorder'): string =>
    step === 'add' ? t.mgrResStepAdd : step === 'remove' ? t.mgrResStepRemove : t.mgrResStepReorder;

  return (
    <div className={`mgr-result${problems ? ' has-problems' : ''}`} role="status" aria-live="polite">
      <div className="mgr-result-line">
        <strong>{opLabel(outcome.op)}:</strong>{' '}
        <span>{parts.join(' · ')}</span>
        <span className="mgr-result-actions">
          {problems && (
            <button type="button" className="mgr-btn mgr-btn-small" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? t.mgrResHide : t.mgrResDetails}
            </button>
          )}
          {problems && outcome.retryKeys.length > 0 && (
            <button type="button" className="mgr-btn mgr-btn-small" onClick={() => manager.retry()}>{t.mgrResRetry}</button>
          )}
          {canUndo && (
            <button type="button" className="mgr-btn mgr-btn-small" onClick={() => void manager.undo()}>{t.mgrResUndo}</button>
          )}
          <button type="button" className="mgr-btn mgr-btn-small" onClick={() => manager.dismissResult()}>{t.mgrResDismiss}</button>
        </span>
      </div>

      {notice && <p className={`mgr-notice-line mgr-notice-${notice.tone}`}>{notice.text}</p>}

      {problems && open && (
        <ul className="mgr-failures">
          {outcome.failed.map((f) => (
            <li key={`${f.step}:${f.key}`}>
              <span className="mgr-failure-song">{f.key === '(order)' ? t.mgrResStepReorder : manager.songLabel(f.key)}</span>
              <span className="mgr-failure-step"> · {stepLabel(f.step)}</span>
              <span className="mgr-failure-error"> — {manager.explainMessage(f.error)}</span>
            </li>
          ))}
          {outcome.notAttempted.map((key) => (
            <li key={`na:${key}`}>
              <span className="mgr-failure-song">{manager.songLabel(key)}</span>
              <span className="mgr-failure-error"> — {interpolate(t.mgrResNotTried, { n: 1 })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
