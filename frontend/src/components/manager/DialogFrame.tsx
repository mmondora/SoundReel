import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { useLanguage } from '../../i18n';
import '../../styles/manager.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogFrameProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** While an operation runs the dialog cannot be dismissed. */
  locked?: boolean;
  className?: string;
}

/**
 * Modal frame shared by every manager dialog: labelled, focus moves in and is restored on close, Tab stays
 * inside, Escape (or a click outside) closes it — so the modal is never a keyboard trap.
 */
export function DialogFrame({ title, onClose, children, footer, locked = false, className = '' }: DialogFrameProps) {
  const { t } = useLanguage();
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef.current;
    const first = root?.querySelector<HTMLElement>('[data-autofocus]') ?? root;
    first?.focus();
    return () => { previous?.focus?.(); };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!locked) onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = [...(rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="mgr-backdrop"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}
    >
      <div
        ref={rootRef}
        className={`mgr-dialog ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="mgr-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="mgr-dialog-x" aria-label={t.mgrClose} onClick={onClose} disabled={locked}>
            ×
          </button>
        </div>
        <div className="mgr-dialog-body">{children}</div>
        {footer && <div className="mgr-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface PromptDialogProps {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  help?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void | Promise<void> | boolean | Promise<boolean>;
  onClose: () => void;
}

/** One text field + confirm. Empty/blank input cannot be submitted. */
export function PromptDialog({ title, label, initial = '', placeholder, help, confirmLabel, onSubmit, onClose }: PromptDialogProps) {
  const { t } = useLanguage();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const helpId = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const ok = await onSubmit(text);
      if (ok !== false) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogFrame title={title} onClose={onClose} locked={busy}>
      <form onSubmit={(e) => void submit(e)} className="mgr-form">
        <label htmlFor={inputId} className="mgr-label">{label}</label>
        <input
          id={inputId}
          className="mgr-input"
          type="text"
          value={value}
          placeholder={placeholder}
          aria-describedby={help ? helpId : undefined}
          data-autofocus
          onChange={(e) => setValue(e.target.value)}
        />
        {help && <p id={helpId} className="mgr-help">{help}</p>}
        <div className="mgr-dialog-foot-inline">
          <button type="button" className="mgr-btn" onClick={onClose} disabled={busy}>{t.playlistCancel}</button>
          <button type="submit" className="mgr-btn mgr-btn-primary" disabled={busy || value.trim() === ''}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, danger = false, onConfirm, onClose }: ConfirmDialogProps) {
  const { t } = useLanguage();
  return (
    <DialogFrame
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="mgr-btn" onClick={onClose}>{t.playlistCancel}</button>
          <button
            type="button"
            className={`mgr-btn ${danger ? 'mgr-btn-danger' : 'mgr-btn-primary'}`}
            data-autofocus
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="mgr-message">{message}</p>
    </DialogFrame>
  );
}
