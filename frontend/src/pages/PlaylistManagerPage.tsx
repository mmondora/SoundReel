import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FnBar } from '../components/manager/FnBar';
import { HelpDialog } from '../components/manager/HelpDialog';
import { ConfirmDialog, PromptDialog } from '../components/manager/DialogFrame';
import { ManagerPane } from '../components/manager/ManagerPane';
import { ResultBar } from '../components/manager/ResultBar';
import { DynamicRuleDialog } from '../components/manager/DynamicRuleDialog';
import { ShareDialog } from '../components/manager/ShareDialog';
import { SongDetailsDialog } from '../components/manager/SongDetailsDialog';
import { OTHER_PANE, usePlaylistManager } from '../hooks/usePlaylistManager';
import type { LiveSongState, PaneId } from '../hooks/usePlaylistManager';
import { interpolate, useLanguage } from '../i18n';
import { usePlayer } from '../player/PlayerContext';
import { dispatchKey, keyTargetOf } from '../utils/managerKeys';
import type { ManagerAction } from '../utils/managerKeys';
import type { ActionId } from '../utils/managerPermissions';
import { EMPTY_FILTERS, facetCounts, isSongDownloaded, isSongPreparing } from '../utils/managerSongs';
import { locationOverridesFrom } from '../utils/songLocation';
import '../styles/manager.css';

type Dialog =
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'rename' }
  | { kind: 'remove'; count: number; name: string }
  | { kind: 'pattern'; mode: 'mark' | 'unmark'; initial: string }
  | { kind: 'details'; songKey: string }
  | { kind: 'rule'; mode: 'create' | 'edit' }
  | { kind: 'share' };

const PANE_IDS: PaneId[] = ['a', 'b'];

// "Mostra percorsi" (rule W8) is a per-pane choice that this browser remembers.
const PATHS_KEY = 'soundreel.manager.paths.v1';
type ShowPaths = Record<PaneId, boolean>;

function loadShowPaths(): ShowPaths {
  try {
    const raw = JSON.parse(localStorage.getItem(PATHS_KEY) ?? '{}') as Partial<Record<PaneId, unknown>> | null;
    return { a: raw?.a === true, b: raw?.b === true };
  } catch {
    return { a: false, b: false };
  }
}

function saveShowPaths(value: ShowPaths): void {
  try {
    localStorage.setItem(PATHS_KEY, JSON.stringify(value));
  } catch {
    // not remembered: it just starts off next time
  }
}

/**
 * Playlist manager in the spirit of Norton Commander: two panes (library or any playlist you own / that is
 * shared with you), filters per pane, marks, and F-key operations between them. See hooks/usePlaylistManager
 * for the state and utils/manager* for the (unit-tested) rules.
 */
export function PlaylistManagerPage() {
  const { t } = useLanguage();
  const player = usePlayer();

  // What the first-play downloads of this session changed: feeds the "scaricata / in preparazione" dots and filter.
  const live = useMemo<LiveSongState>(() => {
    const readyKeys = new Set<string>();
    const preparingKeys = new Set<string>();
    for (const state of Object.values(player.downloadStates)) {
      if (state.phase === 'ready') readyKeys.add(state.songKey);
      else if (state.phase === 'requesting' || state.phase === 'downloading') preparingKeys.add(state.songKey);
    }
    return { readyKeys, preparingKeys, locations: locationOverridesFrom(player.downloadStates) };
  }, [player.downloadStates]);

  const manager = usePlaylistManager(live);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [showPaths, setShowPaths] = useState<ShowPaths>(loadShowPaths);
  const togglePaths = useCallback((id: PaneId) => {
    setShowPaths((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveShowPaths(next);
      return next;
    });
  }, []);
  const listRefA = useRef<HTMLUListElement>(null);
  const listRefB = useRef<HTMLUListElement>(null);
  const listRefs = useMemo(() => ({ a: listRefA, b: listRefB }), []);
  const fnBarRef = useRef<HTMLDivElement>(null);
  const focusedOnce = useRef(false);

  // The latest manager/dialog for the document-level key handler.
  const managerRef = useRef(manager);
  managerRef.current = manager;
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;

  const playKey = useCallback((paneId: PaneId, songKey: string) => {
    const m = managerRef.current;
    const model = m.models[paneId];
    const song = model.rows.find((r) => r.songKey === songKey);
    if (!song || song.placeholder) {
      m.setNotice({ text: t.mgrCannotPlay, tone: 'info' });
      return;
    }
    const label = model.playlist ? model.playlist.name : t.mgrLibrary;
    player.playSong(songKey, model.rows.filter((r) => !r.placeholder), label);
  }, [player, t]);

  /** Same gate for keys and buttons: when an action is not allowed, say why instead of doing nothing. */
  const allowed = useCallback((action: ActionId): boolean => {
    const m = managerRef.current;
    const av = m.availability(action);
    if (!av.enabled) m.setNotice({ text: m.reasonText(av.reason), tone: 'info' });
    return av.enabled;
  }, []);

  const run = useCallback((action: ManagerAction) => {
    const m = managerRef.current;
    const model = m.models[m.active];
    switch (action.type) {
      case 'switchPane': {
        const next = OTHER_PANE[m.active];
        m.setActive(next);
        listRefs[next].current?.focus();
        return;
      }
      case 'cursor':
        m.moveCursor(m.active, action.move);
        return;
      case 'toggleMark':
        m.toggleMark(m.active, null, action.advance);
        return;
      case 'markPattern':
        setDialog({ kind: 'pattern', mode: 'mark', initial: model.state.filters.text });
        return;
      case 'unmarkPattern':
        setDialog({ kind: 'pattern', mode: 'unmark', initial: model.state.filters.text });
        return;
      case 'invertMarks':
        m.invert(m.active);
        return;
      case 'markAll':
        m.markAll(m.active);
        return;
      case 'escape':
        if (model.marked.size > 0) m.clearMarks(m.active);
        else fnBarRef.current?.querySelector<HTMLElement>('button')?.focus();
        return;
      case 'play':
        if (allowed('play') && model.cursor !== null) playKey(m.active, model.cursor);
        return;
      case 'details':
        if (allowed('details') && model.cursor !== null) setDialog({ kind: 'details', songKey: model.cursor });
        return;
      case 'rename':
        // A dynamic playlist cannot be renamed; F4 there edits its rule.
        if (model.perms.isDynamic) {
          if (allowed('editRule')) setDialog({ kind: 'rule', mode: 'edit' });
        } else if (allowed('rename')) {
          setDialog({ kind: 'rename' });
        }
        return;
      case 'editRule':
        if (allowed('editRule')) setDialog({ kind: 'rule', mode: 'edit' });
        return;
      case 'newDynamic':
        if (allowed('newDynamic')) setDialog({ kind: 'rule', mode: 'create' });
        return;
      case 'copy':
        m.copy();
        return;
      case 'move':
        m.move();
        return;
      case 'newPlaylist':
        if (allowed('newPlaylist')) setDialog({ kind: 'new' });
        return;
      case 'remove':
        if (allowed('remove')) {
          const count = model.marked.size > 0 ? model.marked.size : 1;
          setDialog({ kind: 'remove', count, name: model.playlist?.name ?? '' });
        }
        return;
      case 'share':
        if (allowed('share')) setDialog({ kind: 'share' });
        return;
      case 'help':
        setDialog({ kind: 'help' });
        return;
      case 'reorder':
        m.reorder(action.dir);
        return;
      case 'undo':
        if (allowed('undo')) void m.undo();
        return;
    }
  }, [allowed, listRefs, playKey]);

  const runRef = useRef(run);
  runRef.current = run;

  // One document-level handler: F-keys work anywhere on the page, the rest only on a pane list (see managerKeys).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (dialogRef.current) return;
      const action = dispatchKey({
        key: e.key,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        target: keyTargetOf(e.target),
      });
      if (!action) return;
      e.preventDefault();
      runRef.current(action);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Land on the active list so the arrows work right away.
  useEffect(() => {
    if (manager.loading || focusedOnce.current) return;
    focusedOnce.current = true;
    if (document.activeElement === document.body) listRefs[manager.active].current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, after the first load
  }, [manager.loading]);

  const active = manager.models[manager.active];
  const other = manager.models[OTHER_PANE[manager.active]];
  // Genres of the whole library with their counts: the "Tipo (genere)" choices of the rule editor.
  const genreChoices = useMemo(
    () => [...facetCounts(manager.songs, EMPTY_FILTERS).genres.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    [manager.songs],
  );
  const targetName = other.playlist && other.perms.canEdit ? other.playlist.name : null;
  const paneLabel = (id: PaneId): string => (id === 'a' ? t.mgrPaneA : t.mgrPaneB);

  function closeDialog() {
    setDialog(null);
  }

  function renderDialog() {
    if (!dialog) return null;
    switch (dialog.kind) {
      case 'help':
        return <HelpDialog onClose={closeDialog} />;
      case 'new':
        return (
          <PromptDialog
            title={t.mgrNewTitle}
            label={t.mgrNewPlaceholder}
            placeholder={t.playlistNamePlaceholder}
            confirmLabel={t.playlistCreate}
            onSubmit={(name) => manager.newPlaylist(name)}
            onClose={closeDialog}
          />
        );
      case 'rename':
        return (
          <PromptDialog
            title={t.mgrRenameTitle}
            label={t.mgrNewPlaceholder}
            initial={active.playlist?.name ?? ''}
            confirmLabel={t.playlistSave}
            onSubmit={(name) => manager.rename(name)}
            onClose={closeDialog}
          />
        );
      case 'remove':
        return (
          <ConfirmDialog
            title={t.mgrRemoveTitle}
            message={interpolate(t.mgrRemoveConfirm, { n: dialog.count, name: dialog.name })}
            confirmLabel={t.mgrFnRemove}
            danger
            onConfirm={() => manager.remove()}
            onClose={closeDialog}
          />
        );
      case 'pattern':
        return (
          <PromptDialog
            title={dialog.mode === 'mark' ? t.mgrMarkTitle : t.mgrUnmarkTitle}
            label={t.mgrFilterText}
            initial={dialog.initial}
            placeholder={t.mgrPatternPlaceholder}
            help={t.mgrPatternHelp}
            confirmLabel={t.mgrConfirm}
            onSubmit={(pattern) => {
              const n = manager.markPattern(manager.active, pattern, dialog.mode);
              manager.setNotice({ text: interpolate(t.mgrMarked, { n }), tone: 'info' });
            }}
            onClose={closeDialog}
          />
        );
      case 'details': {
        const song = [active, other]
          .flatMap((m) => m.allRows)
          .find((s) => s.songKey === dialog.songKey);
        if (!song) return null;
        const inPlaylists = manager.playlists
          .filter((p) => manager.models.a.detail?.id === p.id || manager.models.b.detail?.id === p.id)
          .filter((p) => [manager.models.a.detail, manager.models.b.detail].some((d) => d?.id === p.id && d.songKeys.includes(song.songKey)))
          .map((p) => p.name);
        return (
          <SongDetailsDialog
            song={song}
            downloaded={isSongDownloaded(song, live)}
            preparing={isSongPreparing(song, live)}
            locationOverride={live.locations?.[song.songKey] ?? null}
            inPlaylists={inPlaylists}
            onClose={closeDialog}
          />
        );
      }
      case 'rule':
        return (
          <DynamicRuleDialog
            mode={dialog.mode}
            initialName={dialog.mode === 'edit' ? (active.playlist?.name ?? '') : ''}
            initialRule={dialog.mode === 'edit' ? active.rule : null}
            genres={genreChoices}
            onSubmit={(name, rule) => (dialog.mode === 'edit' ? manager.updateRule(rule) : manager.createDynamic(name, rule))}
            onClose={closeDialog}
          />
        );
      case 'share':
        return active.playlist ? (
          <ShareDialog
            playlist={active.playlist}
            me={manager.me}
            onChanged={manager.applyShares}
            onClose={closeDialog}
          />
        ) : null;
    }
  }

  return (
    <div className="mgr-page">
      <main className="mgr-content">
        <div className="mgr-head">
          <div>
            <h1>{t.mgrTitle}</h1>
            <p className="mgr-hint">{t.mgrHint}</p>
          </div>
          <button type="button" className="mgr-btn" onClick={() => void manager.reload()} disabled={manager.loading}>
            ↻ {t.mgrReload}
          </button>
        </div>

        {manager.loading && manager.songs.length === 0 && (
          <div className="journal-loading" role="status">
            <span className="spinner" />
            <p>{t.loading}</p>
          </div>
        )}

        {manager.loadError && (
          <p className="mgr-error" role="alert">
            {t.mgrLoadError}: {manager.loadError}
          </p>
        )}

        {!(manager.loading && manager.songs.length === 0) && !manager.loadError && (
          <>
            <div className="mgr-switcher" role="tablist" aria-label={t.mgrPanes}>
              {PANE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={manager.active === id}
                  className={`mgr-tab${manager.active === id ? ' on' : ''}`}
                  onClick={() => manager.setActive(id)}
                >
                  {paneLabel(id)}: {manager.models[id].playlist?.name ?? t.mgrLibrary}
                </button>
              ))}
            </div>

            <div className="mgr-panes" data-active={manager.active}>
              {PANE_IDS.map((id) => (
                <ManagerPane
                  key={id}
                  manager={manager}
                  paneId={id}
                  paneLabel={paneLabel(id)}
                  live={live}
                  listRef={listRefs[id]}
                  onPlay={playKey}
                  showPaths={showPaths[id]}
                  onTogglePaths={() => togglePaths(id)}
                />
              ))}
            </div>

            <ResultBar manager={manager} />

            <div ref={fnBarRef}>
              <FnBar
                availability={manager.availability}
                reasonText={manager.reasonText}
                targetName={targetName}
                ruleMode={active.isDynamic}
                onAction={(action) => run({ type: action } as ManagerAction)}
              />
            </div>
          </>
        )}
      </main>
      {renderDialog()}
    </div>
  );
}
