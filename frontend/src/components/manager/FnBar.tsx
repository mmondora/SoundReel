import { useLanguage } from '../../i18n';
import type { ActionId, Availability } from '../../utils/managerPermissions';

export interface FnBarProps {
  availability: (action: ActionId) => Availability;
  reasonText: (reason: Availability['reason']) => string;
  onAction: (action: ActionId) => void;
  /** Name of the playlist F5/F6 write into (the other pane), shown in the button hint. */
  targetName: string | null;
  /** The active pane shows a dynamic playlist: F4 edits its rule instead of renaming. */
  ruleMode?: boolean;
}

interface Item {
  fkey: string;
  action: ActionId;
  label: string;
}

/**
 * The Norton-Commander function bar. A button that is not allowed right now stays focusable and clickable
 * (aria-disabled): pressing it explains WHY in the status line instead of silently doing nothing.
 */
export function FnBar({ availability, reasonText, onAction, targetName, ruleMode = false }: FnBarProps) {
  const { t } = useLanguage();
  const items: Item[] = [
    { fkey: 'F1', action: 'help', label: t.mgrFnHelp },
    { fkey: 'F2', action: 'newDynamic', label: t.mgrFnDynamic },
    { fkey: 'F3', action: 'details', label: t.mgrFnDetails },
    ruleMode
      ? { fkey: 'F4', action: 'editRule', label: t.mgrFnRule }
      : { fkey: 'F4', action: 'rename', label: t.mgrFnRename },
    { fkey: 'F5', action: 'copy', label: t.mgrFnCopy },
    { fkey: 'F6', action: 'move', label: t.mgrFnMove },
    { fkey: 'F7', action: 'newPlaylist', label: t.mgrFnNew },
    { fkey: 'F8', action: 'remove', label: t.mgrFnRemove },
    { fkey: 'F9', action: 'share', label: t.mgrFnShare },
    { fkey: '↵', action: 'play', label: t.mgrFnPlay },
    { fkey: '^Z', action: 'undo', label: t.mgrFnUndo },
  ];

  return (
    <div className="mgr-fnbar" role="toolbar" aria-label={t.mgrFnBar}>
      {items.map((item) => {
        const av = availability(item.action);
        const hint = av.enabled
          ? (item.action === 'copy' || item.action === 'move') && targetName ? `→ ${targetName}` : ''
          : reasonText(av.reason);
        return (
          <button
            key={item.action}
            type="button"
            className={`mgr-fn${av.enabled ? '' : ' is-disabled'}`}
            aria-disabled={!av.enabled}
            title={hint || undefined}
            onClick={() => onAction(item.action)}
          >
            <kbd className="mgr-fn-key">{item.fkey}</kbd>
            <span className="mgr-fn-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
