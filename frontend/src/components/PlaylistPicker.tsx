import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { interpolate, useLanguage } from '../i18n';
import { PLAYLIST_PAGE_SIZE, usePlaylistList } from '../hooks/usePlaylistList';
import { countLabel } from '../utils/managerSongs';
import { formatPlaylistDate } from '../utils/playlistDate';
import { DialogFrame } from './manager/DialogFrame';
import { PlaylistListControls } from './PlaylistListControls';
import { Pagination } from './Pagination';
import type { PlaylistSummary } from '../types';
import '../styles/picker.css';

// The choice of a playlist (Michele, 10 November: «la scelta della playlist non può essere un box - quando sono 100 che facciamo ?», spec
// 2026-11-10-web-look-and-feel-rethink-design.md §3.6). Not a drop-down with all of them inside: a button that says what is chosen and opens a
// dialog with search, «show», sort and pages of 30, all asked to the SERVER (`GET /api/playlists?q&filter&sort&order&limit&offset`, ADR-0023: rule P).
// «All songs» is always the first thing in the dialog. The keyboard: Up/Down between the search and the rows, Home/End, Enter chooses, Escape closes.

export interface PlaylistPickerProps {
  /** The chosen playlist, or null for «all songs». */
  value: string | null;
  onChange: (playlistId: string | null) => void;
  /** The first thing in the dialog, always: «All songs (45)». */
  allLabel: string;
  /** What the button says about the chosen one: the page already holds the playlist, so it words it (name, number of songs…). */
  valueLabel: string;
  /** The name of the button for a screen reader («Content of the pane (A)»); it is read together with `valueLabel`. */
  ariaLabel: string;
  /** Whose a playlist is, to say it on the shared ones («of Sara»); null or omitted says nothing. */
  ownerLabel?: (playlist: PlaylistSummary) => string | null;
  /** The class of the button (the page decides how a button of its own looks). */
  className?: string;
}

const DYNAMIC_GLYPH = '◷';

interface DialogProps {
  value: string | null;
  allLabel: string;
  ownerLabel?: (playlist: PlaylistSummary) => string | null;
  onSelect: (playlistId: string | null) => void;
  onClose: () => void;
}

function PickerDialog({ value, allLabel, ownerLabel, onSelect, onClose }: DialogProps) {
  const { t, language } = useLanguage();
  // asked only now that the dialog is open, and by pages: a person with a hundred playlists never has them all in front
  const list = usePlaylistList(PLAYLIST_PAGE_SIZE, {}, 'pages');
  const listRef = useRef<HTMLUListElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  const options = (): HTMLElement[] => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-pl-option]') ?? [])];
  const search = (): HTMLElement | null => controlsRef.current?.querySelector<HTMLElement>('input[type="search"]') ?? null;

  /** From the search, Down goes to the first row. */
  const onControlsKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown' && (e.target as HTMLElement).matches('input[type="search"]')) {
      e.preventDefault();
      options()[0]?.focus();
    }
  };

  /** Between the rows: Up and Down, Home and End; Up from the first row comes back to the search. */
  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const nodes = options();
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (e.key === 'ArrowDown') nodes[Math.min(at + 1, nodes.length - 1)]?.focus();
    else if (e.key === 'ArrowUp') (at === 0 ? search() : nodes[at - 1])?.focus();
    else if (e.key === 'Home') nodes[0]?.focus();
    else if (e.key === 'End') nodes[nodes.length - 1]?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <DialogFrame title={t.playlistPickerTitle} onClose={onClose} className="pl-pick-dialog">
      <button
        type="button"
        className="pl-pick-all"
        data-pl-all=""
        aria-current={value === null ? 'true' : undefined}
        onClick={() => onSelect(null)}
      >
        {allLabel}
      </button>

      <div ref={controlsRef} onKeyDown={onControlsKeyDown}>
        <PlaylistListControls
          controls={list.controls}
          onQ={list.setQ}
          onFilter={list.setFilter}
          onSort={list.setSort}
          onToggleOrder={list.toggleOrder}
          autoFocusSearch
        />
      </div>

      {list.failed ? (
        <div className="pl-pick-failed" role="alert">
          <p>{t.playlistPickerFailed}</p>
          <button type="button" className="mgr-btn" onClick={() => void list.reload()}>{t.libRetry}</button>
        </div>
      ) : list.loading && list.items.length === 0 ? (
        <p className="pl-pick-status" role="status">{t.loading}</p>
      ) : list.items.length === 0 ? (
        <p className="pl-pick-status">{list.narrowed ? t.playlistNoMatch : t.playlistEmpty}</p>
      ) : (
        <>
          <p className="pl-pick-total">{interpolate(t.playlistPickerTotal, { count: list.total })}</p>
          <ul className="pl-pick-list" ref={listRef} onKeyDown={onListKeyDown}>
            {list.items.map((p) => {
              const date = formatPlaylistDate(p.createdAt, language, t);
              const owner = ownerLabel?.(p) ?? null;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className="pl-pick-row"
                    data-pl-option=""
                    aria-current={p.id === value ? 'true' : undefined}
                    onClick={() => onSelect(p.id)}
                  >
                    <span className="pl-pick-name">
                      {p.kind === 'dynamic' && <span className="pl-pick-glyph" aria-hidden="true">{DYNAMIC_GLYPH} </span>}
                      {p.name}
                    </span>
                    {' '}
                    <span className="pl-pick-meta">
                      {countLabel(p.songCount, t.mgrItems, t.mgrItemOne)}
                      {date ? ` · ${date}` : ''}
                      {owner ? ` · ${owner}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <Pagination currentPage={list.page} totalPages={list.pageCount} onPrev={list.prevPage} onNext={list.nextPage} />
    </DialogFrame>
  );
}

export function PlaylistPicker({ value, onChange, allLabel, valueLabel, ariaLabel, ownerLabel, className = 'pl-picker-btn' }: PlaylistPickerProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  /** Closing gives the focus back to the button (Safari does not focus a button when it is clicked, so the frame's own memory is not enough). */
  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${valueLabel}`}
        onClick={() => setOpen(true)}
      >
        <span className="pl-picker-value">{valueLabel}</span>
        <span className="pl-picker-caret" aria-hidden="true">▾</span>
      </button>
      {open && createPortal(
        // a portal still bubbles its events to the components that hold the button in the React tree (a sheet that traps Tab, a page with
        // shortcuts): the keys typed in a dialog are the dialog's
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div className="pl-pick-root" onKeyDown={(e) => e.stopPropagation()}>
          <PickerDialog
            value={value}
            allLabel={allLabel}
            ownerLabel={ownerLabel}
            onSelect={(id) => { onChange(id); close(); }}
            onClose={close}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
