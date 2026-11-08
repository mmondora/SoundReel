import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Focus handling of a full-height sheet (a modal on a phone): focus moves into it when it opens and goes back to
 * where it was when it closes, Tab stays inside, Escape closes it. `active` is false for a panel that is just part
 * of the page (desktop): then nothing is moved or trapped. Returns the `onKeyDown` for the sheet's root.
 */
export function useSheetFocus(root: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!active) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    return () => { previous?.focus?.(); };
  }, [active, root]);

  return useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const here = document.activeElement;
    const atRoot = here === root.current; // where focus lands when the sheet opens
    const outside = !(root.current?.contains(here) ?? false);
    if (e.shiftKey && (atRoot || here === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (atRoot || here === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  }, [root]);
}
