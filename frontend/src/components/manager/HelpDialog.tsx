import { useLanguage } from '../../i18n';
import { DialogFrame } from './DialogFrame';

/** F1: the key model, as plain lines (the same strings the page hint is built from). */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  return (
    <DialogFrame title={t.mgrHelpTitle} onClose={onClose}>
      <ul className="mgr-help-list">
        {t.mgrHelpLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="mgr-dialog-foot-inline">
        <button type="button" className="mgr-btn mgr-btn-primary" data-autofocus onClick={onClose}>
          {t.mgrClose}
        </button>
      </div>
    </DialogFrame>
  );
}
