/**
 * Norton-Commander key model of the playlist manager, as a pure function:
 * (key event + where the focus is) → the action to run, or null to leave the key alone.
 *
 * F-keys work everywhere on the page (they type nothing); every other key only works while the focus is
 * on a pane list, so typing in a filter box or tabbing through buttons behaves natively.
 * `Tab` on a list switches pane; `Shift+Tab` stays native and is the way out of the lists (no keyboard trap).
 */
import type { CursorMove } from './managerSelection';

export type KeyTarget = 'list' | 'input' | 'button' | 'dialog' | 'other';

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  target: KeyTarget;
}

export type ManagerAction =
  | { type: 'switchPane' }
  | { type: 'cursor'; move: CursorMove }
  | { type: 'toggleMark'; advance: boolean }
  | { type: 'markPattern' }
  | { type: 'unmarkPattern' }
  | { type: 'invertMarks' }
  | { type: 'markAll' }
  | { type: 'escape' }
  | { type: 'play' }
  | { type: 'details' }
  | { type: 'rename' }
  | { type: 'newDynamic' }
  | { type: 'editRule' }
  | { type: 'copy' }
  | { type: 'move' }
  | { type: 'newPlaylist' }
  | { type: 'remove' }
  | { type: 'share' }
  | { type: 'help' }
  | { type: 'undo' }
  | { type: 'reorder'; dir: -1 | 1 };

const FN_ACTIONS: Record<string, ManagerAction> = {
  F1: { type: 'help' },
  F2: { type: 'newDynamic' },
  F3: { type: 'details' },
  F4: { type: 'rename' },
  F5: { type: 'copy' },
  F6: { type: 'move' },
  F7: { type: 'newPlaylist' },
  F8: { type: 'remove' },
  F9: { type: 'share' },
};

const CURSOR_KEYS: Record<string, CursorMove> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
};

export function dispatchKey(k: KeyInput): ManagerAction | null {
  if (k.target === 'dialog') return null;

  const plain = !k.ctrlKey && !k.altKey && !k.metaKey;
  const fn = FN_ACTIONS[k.key];
  if (fn) return plain && !k.shiftKey ? fn : null;

  if (k.target !== 'list') return null;

  // Ctrl+↑ / Ctrl+↓ reorder; Ctrl+A marks everything; Ctrl+Z undoes the last operation.
  if (k.ctrlKey && !k.altKey && !k.metaKey) {
    if (k.key === 'ArrowUp') return { type: 'reorder', dir: -1 };
    if (k.key === 'ArrowDown') return { type: 'reorder', dir: 1 };
    if (k.key === 'a' || k.key === 'A') return { type: 'markAll' };
    if (k.key === 'z' || k.key === 'Z') return { type: 'undo' };
    return null;
  }
  if (!plain) return null;

  if (k.key === 'Tab') return k.shiftKey ? null : { type: 'switchPane' };

  const move = CURSOR_KEYS[k.key];
  if (move && !k.shiftKey) return { type: 'cursor', move };

  switch (k.key) {
    case ' ':
    case 'Insert':
      return { type: 'toggleMark', advance: true };
    case '+':
      return { type: 'markPattern' };
    case '-':
      return { type: 'unmarkPattern' };
    case '*':
      return { type: 'invertMarks' };
    case 'Enter':
      return { type: 'play' };
    case 'Delete':
      return { type: 'remove' };
    case 'Escape':
      return { type: 'escape' };
    default:
      return null;
  }
}

/** Where is the focus? Decides which keys the manager may take. */
export function keyTargetOf(el: EventTarget | null): KeyTarget {
  if (!(el instanceof HTMLElement)) return 'other';
  if (el.closest('[role="dialog"], [data-mgr-dialog]')) return 'dialog';
  if (el.closest('[data-mgr-list]')) return 'list';
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return 'input';
  if (tag === 'BUTTON' || tag === 'A') return 'button';
  return 'other';
}
