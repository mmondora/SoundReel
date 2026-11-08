import { useEffect, useRef, useState } from 'react';
import { interpolate, useLanguage } from '../../i18n';
import '../../styles/manager.css';

type CopyStatus = 'idle' | 'copied' | 'failed';

/** The async clipboard needs a secure context; elsewhere (plain http on the LAN) a selected textarea does it. */
function legacyCopy(value: string): void {
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy refused');
  } finally {
    document.body.removeChild(area);
  }
}

/** "Copy" for one address. `what` names it for screen readers ("Copy geekom disk path"); the result is announced. */
export function CopyButton({ value, what }: { value: string; what: string }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<CopyStatus>('idle');
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else legacyCopy(value);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus('idle'), 2000);
  }

  const text = status === 'copied' ? t.mgrCopied : status === 'failed' ? t.mgrCopyFailed : t.mgrCopy;
  return (
    <>
      <button
        type="button"
        className={`mgr-btn mgr-btn-small mgr-copy${status === 'copied' ? ' is-done' : ''}`}
        aria-label={interpolate(t.mgrCopyWhat, { what })}
        onClick={() => void copy()}
      >
        {text}
      </button>
      <span className="sr-only" role="status">{status === 'idle' ? '' : text}</span>
    </>
  );
}
