import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useLanguage } from '../../i18n';

// The detail of a post next to the wall (look and feel P3, board B): a panel that closes. The × and Escape (with the focus inside) close it;
// when it opens the focus goes to its close button, and when it closes the focus goes back to the card that opened it (if it is still there).

export interface DetailPanelProps {
  onClose: () => void;
  children: ReactNode;
}

export function DetailPanel({ onClose, children }: DetailPanelProps) {
  const { t } = useLanguage();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <aside className="detail-panel" aria-label={t.detailLabel} onKeyDown={onKeyDown}>
      <button type="button" ref={closeRef} className="detail-close" aria-label={t.detailClose} onClick={onClose}>×</button>
      <div className="detail-body">{children}</div>
    </aside>
  );
}
