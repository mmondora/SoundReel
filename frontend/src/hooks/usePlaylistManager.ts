/**
 * State + actions of the playlist manager page ("Norton Commander"): two panes, each showing the library or
 * one playlist, with filters, a cursor and marks; copy / move / remove / reorder / rename / create / undo.
 *
 * Rules mirrored from the backend (see utils/managerPermissions.ts): only the owner edits a playlist, a
 * playlist shared with the user is read-only, the backend adds/removes one song per call.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addSongToPlaylist,
  createDynamicPlaylist,
  createPlaylist,
  fetchAllEntrySummaries,
  fetchMe,
  fetchPlaylist,
  fetchPlaylists,
  fetchPlaylistShares,
  fetchSongs,
  removeSongFromPlaylist,
  renamePlaylist,
  reorderPlaylist,
  updatePlaylistRule,
} from '../services/api';
import { interpolate, useLanguage } from '../i18n';
import type { AggregatedSong, DynamicRule, MeResponse, PlaylistDetail, PlaylistSummary, SongStateLocation } from '../types';
import {
  EMPTY_FILTERS,
  activeFilterCount,
  datasetFacets,
  extraDatasetFacets,
  enrichSongs,
  facetCounts,
  filterManagerSongs,
  placeholderSong,
  sortLibrary,
} from '../utils/managerSongs';
import type {
  DatasetFacets,
  ExtraDatasetFacets,
  EntryFact,
  FacetCounts,
  FilterContext,
  LibrarySortMode,
  ManagerFilters,
  ManagerSong,
} from '../utils/managerSongs';
import {
  invertMarks,
  keysMatching,
  markAllVisible,
  markMany,
  moveCursor as moveCursorKey,
  operationTargets,
  pruneMarks,
  rangeKeys,
  reconcileCursor,
  toggleMark as toggleMarkKey,
  unmarkMany,
} from '../utils/managerSelection';
import type { CursorMove } from '../utils/managerSelection';
import { actionAvailability, panePermissions, sameLocation } from '../utils/managerPermissions';
import type { ActionId, Availability, PaneLocation, PanePermissions, ReasonKey } from '../utils/managerPermissions';
import {
  errorMessage,
  executeCopy,
  executeMove,
  executeRemove,
  executeUndo,
  moveBlock,
} from '../utils/managerOps';
import type { OpOutcome, PlaylistApi, Progress, UndoPlan } from '../utils/managerOps';

export type PaneId = 'a' | 'b';
export const OTHER_PANE: Record<PaneId, PaneId> = { a: 'b', b: 'a' };
const LIBRARY: PaneLocation = { kind: 'library' };

export interface PaneState {
  location: PaneLocation;
  filters: ManagerFilters;
  sort: LibrarySortMode;
  filtersOpen: boolean;
  cursor: string | null;
  marked: Set<string>;
}

export interface PaneModel {
  id: PaneId;
  state: PaneState;
  playlist: PlaylistSummary | null;
  detail: PlaylistDetail | null;
  perms: PanePermissions;
  loadingDetail: boolean;
  /** Every row of the location, before filtering. */
  allRows: ManagerSong[];
  /** Rows after the filters (what the user sees). */
  rows: ManagerSong[];
  visibleKeys: string[];
  /** Cursor / marks as shown: always inside the visible rows. */
  cursor: string | null;
  marked: Set<string>;
  filtered: boolean;
  filterCount: number;
  facets: FacetCounts | null;
  dataset: DatasetFacets & ExtraDatasetFacets;
  /** The other pane shows a playlist (so "already / not yet in the other playlist" makes sense). */
  otherIsPlaylist: boolean;
  /** Users the playlist is shared with; null while unknown (or when the viewer is not the owner). */
  sharedWith: string[] | null;
  /** Dynamic playlist: its rule, the backend's readable summary and when it was last evaluated. */
  isDynamic: boolean;
  rule: DynamicRule | null;
  ruleSummary: string | null;
  evaluatedAt: string | null;
  /** Playlist keys the user has no journal entry for. */
  missingCount: number;
}

export interface BusyState {
  op: Progress['op'];
  done: number;
  total: number;
}

export interface RetryInfo {
  op: 'copy' | 'move' | 'remove';
  sourceId: string | null;
  targetId: string | null;
}

export interface OpResultView {
  id: number;
  outcome: OpOutcome;
  retry: RetryInfo;
  /** Songs left out because the user has no journal entry for them (copied from a shared playlist). */
  skippedPlaceholders: number;
  /** Set once the undo ran: all good, or with leftovers. */
  undone?: { failed: number };
}

export interface Notice {
  text: string;
  tone: 'info' | 'error';
}

export interface LiveSongState {
  readyKeys: ReadonlySet<string>;
  preparingKeys: ReadonlySet<string>;
  /** Where files turned out to be during this session (finished first-play downloads), by songKey. */
  locations?: Readonly<Record<string, Partial<SongStateLocation>>>;
}

const STORAGE_KEY = 'soundreel.manager.v1';

interface SavedLayout {
  a: PaneLocation;
  b: PaneLocation;
  active: PaneId;
}

function isLocation(value: unknown): value is PaneLocation {
  if (!value || typeof value !== 'object') return false;
  const v = value as { kind?: unknown; id?: unknown };
  return v.kind === 'library' || (v.kind === 'playlist' && typeof v.id === 'string');
}

function loadLayout(): SavedLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedLayout>;
    if (!isLocation(parsed.a) || !isLocation(parsed.b)) return null;
    return { a: parsed.a, b: parsed.b, active: parsed.active === 'b' ? 'b' : 'a' };
  } catch {
    return null;
  }
}

function saveLayout(layout: SavedLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* private mode / quota: the layout is a convenience only */
  }
}

const newPane = (location: PaneLocation): PaneState => ({
  location,
  filters: EMPTY_FILTERS,
  sort: 'date',
  filtersOpen: false,
  cursor: null,
  marked: new Set(),
});

const playlistApi: PlaylistApi = {
  add: addSongToPlaylist,
  remove: removeSongFromPlaylist,
  reorder: reorderPlaylist,
};

// Journal summaries (platform + tags per entry) are only needed to derive the "fonte"/"tag" facets when the
// backend does not send them with the songs. Cached for the session: it is a couple of MB.
const FACTS_TTL_MS = 5 * 60 * 1000;
let factsCache: { at: number; facts: Map<string, EntryFact> } | null = null;

export function resetEntryFactsCache(): void {
  factsCache = null;
}

async function loadEntryFacts(): Promise<Map<string, EntryFact>> {
  if (factsCache && Date.now() - factsCache.at < FACTS_TTL_MS) return factsCache.facts;
  const summaries = await fetchAllEntrySummaries();
  const facts = new Map<string, EntryFact>();
  for (const e of summaries) facts.set(e.id, { platform: e.sourcePlatform, tags: e.tags ?? [] });
  factsCache = { at: Date.now(), facts };
  return facts;
}

function summaryOf(detail: PlaylistDetail, previous?: PlaylistSummary): PlaylistSummary {
  return {
    id: detail.id,
    name: detail.name,
    songCount: detail.songKeys.length,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    ownerUser: detail.ownerUser ?? previous?.ownerUser,
    kind: detail.kind ?? previous?.kind,
    rule: detail.rule ?? previous?.rule,
    ruleSummary: detail.ruleSummary ?? previous?.ruleSummary,
    generatedAt: detail.generatedAt ?? previous?.generatedAt,
  };
}

export function usePlaylistManager(live: LiveSongState) {
  const { t } = useLanguage();

  /** Backend error → text for the user (the 409 of a dynamic playlist has a reason of its own). */
  const explainMessage = useCallback((message: string): string => (message === 'playlist_is_dynamic' ? t.mgrWhyDynamic : message), [t]);
  const explain = useCallback((err: unknown): string => explainMessage(errorMessage(err)), [explainMessage]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rawSongs, setRawSongs] = useState<AggregatedSong[]>([]);
  const [facts, setFacts] = useState<Map<string, EntryFact> | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [details, setDetails] = useState<Record<string, PlaylistDetail>>({});
  const [shares, setShares] = useState<Record<string, string[] | null>>({});
  // When each dynamic playlist was last evaluated (backend `generatedAt`, else the moment we fetched it).
  const [evaluatedAt, setEvaluatedAt] = useState<Record<string, string>>({});
  const [me, setMe] = useState<MeResponse | null>(null);
  const [panes, setPanes] = useState<Record<PaneId, PaneState>>(() => {
    const saved = loadLayout();
    return { a: newPane(saved?.a ?? LIBRARY), b: newPane(saved?.b ?? LIBRARY) };
  });
  const [active, setActive] = useState<PaneId>(() => loadLayout()?.active ?? 'a');
  const [busy, setBusy] = useState<BusyState | null>(null);
  const [result, setResult] = useState<OpResultView | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const hadSavedLayout = useRef(loadLayout() !== null);
  const bootstrapped = useRef(false);
  const resultSeq = useRef(0);
  const busyRef = useRef(false);
  const detailsInFlight = useRef(new Set<string>());
  const sharesAttempted = useRef(new Set<string>());
  const reorderChain = useRef<Promise<unknown>>(Promise.resolve());

  const songs = useMemo(() => enrichSongs(rawSongs, facts), [rawSongs, facts]);
  const songsByKey = useMemo(() => new Map(songs.map((s) => [s.songKey, s])), [songs]);
  const dataset = useMemo(() => ({ ...datasetFacets(songs), ...extraDatasetFacets(songs) }), [songs]);
  const viewer = useMemo(() => (me ? { user: me.user, authenticated: me.authenticated } : null), [me]);

  // ---------------------------------------------------------------- loading

  const load = useCallback(async (isReload: boolean) => {
    setLoading(true);
    setLoadError(null);
    const [songsRes, playlistsRes, meRes] = await Promise.allSettled([fetchSongs(), fetchPlaylists(), fetchMe()]);
    if (songsRes.status === 'rejected' && playlistsRes.status === 'rejected') {
      setLoadError(errorMessage(songsRes.reason));
      setLoading(false);
      return;
    }
    if (songsRes.status === 'fulfilled') setRawSongs(songsRes.value);
    if (playlistsRes.status === 'fulfilled') setPlaylists(playlistsRes.value);
    if (meRes.status === 'fulfilled') setMe(meRes.value);
    if (songsRes.status === 'rejected' || playlistsRes.status === 'rejected') {
      setNotice({ text: t.mgrLoadError, tone: 'error' });
    }
    if (isReload) {
      detailsInFlight.current.clear();
      sharesAttempted.current.clear();
      setDetails({});
      setShares({});
      setEvaluatedAt({});
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first load only
  }, []);

  // "Fonte" / "tag" facets: derive them from the journal when the backend does not send them.
  const needsFacts = rawSongs.length > 0 && rawSongs.some((s) => s.platforms === undefined || s.tags === undefined);
  useEffect(() => {
    if (!needsFacts) return;
    let cancelled = false;
    loadEntryFacts()
      .then((f) => { if (!cancelled) setFacts(f); })
      .catch(() => { /* facets stay hidden; everything else works */ });
    return () => { cancelled = true; };
  }, [needsFacts]);

  // Once the playlists are known: drop locations that no longer exist; a first visit gets a sensible right pane.
  useEffect(() => {
    if (loading || bootstrapped.current) return;
    bootstrapped.current = true;
    setPanes((prev) => {
      const exists = (loc: PaneLocation) => loc.kind === 'library' || playlists.some((p) => p.id === loc.id);
      const next = { ...prev };
      for (const id of ['a', 'b'] as const) {
        if (!exists(prev[id].location)) next[id] = newPane(LIBRARY);
      }
      if (!hadSavedLayout.current) {
        const first = playlists.find((p) => panePermissions({ kind: 'playlist', id: p.id }, playlists, viewer).isOwner);
        if (first) next.b = newPane({ kind: 'playlist', id: first.id });
      }
      return next;
    });
  }, [loading, playlists, viewer]);

  useEffect(() => {
    saveLayout({ a: panes.a.location, b: panes.b.location, active });
  }, [panes.a.location, panes.b.location, active]);

  // Playlist contents and (for owned playlists) the share list are fetched when a pane first shows them.
  useEffect(() => {
    for (const id of ['a', 'b'] as const) {
      const loc = panes[id].location;
      if (loc.kind !== 'playlist') continue;
      const playlistId = loc.id;
      if (!playlists.some((p) => p.id === playlistId)) continue;

      if (!details[playlistId] && !detailsInFlight.current.has(playlistId)) {
        detailsInFlight.current.add(playlistId);
        fetchPlaylist(playlistId)
          .then((d) => {
            setDetails((prev) => ({ ...prev, [d.id]: d }));
            if (d.kind === 'dynamic') setEvaluatedAt((prev) => ({ ...prev, [d.id]: d.generatedAt ?? new Date().toISOString() }));
          })
          .catch((err: unknown) => {
            setNotice({ text: `${t.mgrLoadError}: ${explain(err)}`, tone: 'error' });
            setPanes((prev) => {
              const next = { ...prev };
              for (const pid of ['a', 'b'] as const) {
                const l = prev[pid].location;
                if (l.kind === 'playlist' && l.id === playlistId) next[pid] = newPane(LIBRARY);
              }
              return next;
            });
          })
          .finally(() => detailsInFlight.current.delete(playlistId));
      }

      const perms = panePermissions(loc, playlists, viewer);
      if (perms.isOwner && shares[playlistId] === undefined && !sharesAttempted.current.has(playlistId)) {
        sharesAttempted.current.add(playlistId);
        fetchPlaylistShares(playlistId)
          .then((r) => setShares((prev) => ({ ...prev, [playlistId]: r.sharedWith })))
          .catch(() => setShares((prev) => ({ ...prev, [playlistId]: null })));
      }
    }
  }, [panes, playlists, details, shares, viewer, t]);

  // ---------------------------------------------------------------- derived models

  const libraryA = useMemo(() => sortLibrary(songs, panes.a.sort), [songs, panes.a.sort]);
  const libraryB = useMemo(() => sortLibrary(songs, panes.b.sort), [songs, panes.b.sort]);

  const models = useMemo<Record<PaneId, PaneModel>>(() => {
    const build = (id: PaneId): PaneModel => {
      const state = panes[id];
      const otherState = panes[OTHER_PANE[id]];
      const loc = state.location;
      const playlist = loc.kind === 'playlist' ? (playlists.find((p) => p.id === loc.id) ?? null) : null;
      const detail = loc.kind === 'playlist' ? (details[loc.id] ?? null) : null;

      let allRows: ManagerSong[];
      if (loc.kind === 'library') allRows = id === 'a' ? libraryA : libraryB;
      else allRows = detail ? detail.songKeys.map((k) => songsByKey.get(k) ?? placeholderSong(k)) : [];

      const otherDetail = otherState.location.kind === 'playlist' ? (details[otherState.location.id] ?? null) : null;
      const ctx: FilterContext = {
        readyKeys: live.readyKeys,
        preparingKeys: live.preparingKeys,
        otherKeys: otherDetail ? new Set(otherDetail.songKeys) : null,
      };
      const rows = filterManagerSongs(allRows, state.filters, ctx);
      const visibleKeys = rows.map((r) => r.songKey);
      const cursor = state.cursor !== null && visibleKeys.includes(state.cursor) ? state.cursor : (visibleKeys[0] ?? null);
      const filterCount = activeFilterCount(state.filters);

      return {
        id,
        state,
        playlist,
        detail,
        perms: panePermissions(loc, playlists, viewer),
        loadingDetail: loc.kind === 'playlist' && !detail,
        allRows,
        rows,
        visibleKeys,
        cursor,
        marked: pruneMarks(state.marked, visibleKeys),
        filtered: filterCount > 0 || state.filters.text.trim() !== '',
        filterCount,
        facets: state.filtersOpen ? facetCounts(allRows, state.filters, ctx) : null,
        dataset,
        otherIsPlaylist: otherState.location.kind === 'playlist',
        sharedWith: loc.kind === 'playlist' ? (shares[loc.id] ?? null) : null,
        isDynamic: playlist?.kind === 'dynamic',
        rule: playlist?.rule ?? detail?.rule ?? null,
        ruleSummary: playlist?.ruleSummary ?? detail?.ruleSummary ?? null,
        evaluatedAt: loc.kind === 'playlist' ? (evaluatedAt[loc.id] ?? null) : null,
        missingCount: allRows.filter((r) => r.placeholder).length,
      };
    };
    return { a: build('a'), b: build('b') };
  }, [panes, playlists, details, shares, evaluatedAt, songsByKey, libraryA, libraryB, viewer, live, dataset]);

  // Latest values for the (stable) action callbacks and the document key handler.
  const latest = useRef({ models, details, playlists, songsByKey, active, result, busy });
  latest.current = { models, details, playlists, songsByKey, active, result, busy };

  const patchPane = useCallback((id: PaneId, patch: Partial<PaneState>) => {
    setPanes((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  // ---------------------------------------------------------------- availability

  const reasonText = useCallback((reason: ReasonKey | null): string => {
    switch (reason) {
      case 'busy': return t.mgrWhyBusy;
      case 'nothing': return t.mgrWhyNothing;
      case 'library': return t.mgrWhyLibrary;
      case 'readOnly': return t.mgrWhyReadOnly;
      case 'noTarget': return t.mgrWhyNoTarget;
      case 'samePlaylist': return t.mgrWhySamePlaylist;
      case 'notOwner': return t.mgrWhyNotOwner;
      case 'filtered': return t.mgrWhyFiltered;
      case 'notAuth': return t.mgrWhyNotAuth;
      case 'noUndo': return t.mgrWhyNoUndo;
      case 'dynamic': return t.mgrWhyDynamic;
      case 'notDynamic': return t.mgrWhyNotDynamic;
      default: return '';
    }
  }, [t]);

  const availabilityIn = useCallback((action: ActionId, snap = latest.current): Availability => {
    const a = snap.models[snap.active];
    const b = snap.models[OTHER_PANE[snap.active]];
    return actionAvailability(action, {
      active: a.perms,
      other: b.perms,
      activeLocation: a.state.location,
      otherLocation: b.state.location,
      targetCount: operationTargets(a.marked, a.visibleKeys, a.cursor).length,
      busy: snap.busy !== null,
      filtered: a.filtered,
      hasUndo: snap.result?.outcome.undo != null && snap.result.undone === undefined,
    });
  }, []);

  /** Refuses with a visible reason; returns true when the action may run. */
  const gate = useCallback((action: ActionId): boolean => {
    const av = availabilityIn(action);
    if (!av.enabled) {
      setNotice({ text: reasonText(av.reason), tone: 'info' });
      return false;
    }
    return true;
  }, [availabilityIn, reasonText]);

  // ---------------------------------------------------------------- pane interaction

  const selectLocation = useCallback((id: PaneId, location: PaneLocation) => {
    // "True right now": showing a dynamic playlist again re-evaluates it instead of reusing an old answer.
    if (location.kind === 'playlist' && latest.current.playlists.find((p) => p.id === location.id)?.kind === 'dynamic') {
      setDetails((prev) => {
        const { [location.id]: _stale, ...rest } = prev;
        void _stale;
        return rest;
      });
    }
    setPanes((prev) => {
      if (sameLocation(prev[id].location, location)) return prev;
      return { ...prev, [id]: { ...newPane(location), sort: prev[id].sort } };
    });
    setNotice(null);
  }, []);

  const setFilters = useCallback((id: PaneId, patch: Partial<ManagerFilters>) => {
    setPanes((prev) => ({ ...prev, [id]: { ...prev[id], filters: { ...prev[id].filters, ...patch } } }));
  }, []);

  const resetFilters = useCallback((id: PaneId) => {
    setPanes((prev) => ({ ...prev, [id]: { ...prev[id], filters: { ...EMPTY_FILTERS, text: prev[id].filters.text } } }));
  }, []);

  const toggleFilters = useCallback((id: PaneId) => {
    setPanes((prev) => ({ ...prev, [id]: { ...prev[id], filtersOpen: !prev[id].filtersOpen } }));
  }, []);

  const setSort = useCallback((id: PaneId, sort: LibrarySortMode) => patchPane(id, { sort }), [patchPane]);

  const setCursor = useCallback((id: PaneId, key: string | null) => patchPane(id, { cursor: key }), [patchPane]);

  const moveCursor = useCallback((id: PaneId, move: CursorMove) => {
    const m = latest.current.models[id];
    patchPane(id, { cursor: moveCursorKey(m.visibleKeys, m.cursor, move) });
  }, [patchPane]);

  /** Space / Insert / click on the mark glyph. `advance` moves the cursor down afterwards (Norton Commander). */
  const toggleMark = useCallback((id: PaneId, key: string | null, advance: boolean) => {
    const m = latest.current.models[id];
    const target = key ?? m.cursor;
    if (target === null) return;
    const marked = toggleMarkKey(m.marked, target);
    const cursor = advance ? moveCursorKey(m.visibleKeys, target, 'down') : target;
    patchPane(id, { marked, cursor });
  }, [patchPane]);

  /** Shift+click: mark the range between the cursor and `key`. */
  const markRange = useCallback((id: PaneId, key: string) => {
    const m = latest.current.models[id];
    patchPane(id, { marked: markMany(m.marked, rangeKeys(m.visibleKeys, m.cursor, key)), cursor: key });
  }, [patchPane]);

  const markAll = useCallback((id: PaneId) => {
    patchPane(id, { marked: markAllVisible(latest.current.models[id].visibleKeys) });
  }, [patchPane]);

  const invert = useCallback((id: PaneId) => {
    const m = latest.current.models[id];
    patchPane(id, { marked: invertMarks(m.marked, m.visibleKeys) });
  }, [patchPane]);

  const clearMarks = useCallback((id: PaneId) => patchPane(id, { marked: new Set() }), [patchPane]);

  /** `+` / `-`: mark or unmark the visible rows matching a text or wildcard mask. Returns how many matched. */
  const markPattern = useCallback((id: PaneId, pattern: string, mode: 'mark' | 'unmark'): number => {
    const m = latest.current.models[id];
    const keys = keysMatching(m.rows, pattern);
    patchPane(id, { marked: mode === 'mark' ? markMany(m.marked, keys) : unmarkMany(m.marked, keys) });
    return keys.length;
  }, [patchPane]);

  // ---------------------------------------------------------------- operations

  const progressTo = useCallback((p: Progress) => setBusy({ op: p.op, done: p.done, total: p.total }), []);

  const refreshFromOutcome = useCallback((outcome: OpOutcome) => {
    const touched = [outcome.source, outcome.target].filter((d): d is PlaylistDetail => d !== null);
    if (touched.length === 0) return;
    setDetails((prev) => {
      const next = { ...prev };
      for (const d of touched) next[d.id] = d;
      return next;
    });
    setPlaylists((prev) => prev.map((p) => {
      const d = touched.find((x) => x.id === p.id);
      return d ? summaryOf(d, p) : p;
    }));
  }, []);

  const finishOp = useCallback((outcome: OpOutcome, retry: RetryInfo, id: PaneId, skippedPlaceholders: number) => {
    refreshFromOutcome(outcome);
    const done = new Set([...outcome.added, ...outcome.alreadyThere, ...outcome.removed]);
    const before = latest.current.models[id];
    const removed = new Set(outcome.removed);
    setPanes((prev) => {
      const pane = prev[id];
      const remaining = before.visibleKeys.filter((k) => !removed.has(k));
      return {
        ...prev,
        [id]: {
          ...pane,
          marked: new Set([...pane.marked].filter((k) => !done.has(k))),
          cursor: removed.size > 0 ? reconcileCursor(before.visibleKeys, remaining, before.cursor) : pane.cursor,
        },
      };
    });
    resultSeq.current += 1;
    setResult({ id: resultSeq.current, outcome, retry, skippedPlaceholders });
    setNotice(null);
  }, [refreshFromOutcome]);

  /** Songs the user can actually act on: placeholders (no journal entry) cannot be copied. */
  const copyableKeys = (keys: string[]): { keys: string[]; skipped: number } => {
    const own = keys.filter((k) => latest.current.songsByKey.has(k));
    return { keys: own, skipped: keys.length - own.length };
  };

  const runCopyOrMove = useCallback(async (op: 'copy' | 'move', onlyKeys?: string[], pane?: PaneId, targetPane?: PaneId) => {
    if (busyRef.current) return;
    const id = pane ?? latest.current.active;
    const otherId = targetPane ?? OTHER_PANE[id];
    const a = latest.current.models[id];
    const b = latest.current.models[otherId];
    const sourceId = a.state.location.kind === 'playlist' ? a.state.location.id : null;
    if (op === 'move' && (sourceId === null || !a.perms.canEdit)) return;
    if (b.state.location.kind !== 'playlist' || !b.perms.canEdit) return;
    if (!b.detail) {
      // The target playlist is still loading: say so instead of doing nothing.
      setNotice({ text: t.loading, tone: 'info' });
      return;
    }
    const picked = onlyKeys ?? operationTargets(a.marked, a.visibleKeys, a.cursor);
    const { keys, skipped } = copyableKeys(picked);
    if (keys.length === 0) {
      setNotice({ text: skipped > 0 ? t.mgrCannotPlay : t.mgrWhyNothing, tone: 'info' });
      return;
    }
    busyRef.current = true;
    setBusy({ op, done: 0, total: keys.length });
    try {
      const targetId = b.state.location.id;
      const outcome = op === 'copy'
        ? await executeCopy(playlistApi, { targetId, keys, targetKeys: b.detail.songKeys, onProgress: progressTo })
        : await executeMove(playlistApi, {
            sourceId: sourceId as string,
            targetId,
            keys,
            sourceKeys: a.detail?.songKeys ?? [],
            targetKeys: b.detail.songKeys,
            onProgress: progressTo,
          });
      finishOp(outcome, { op, sourceId: outcome.sourceId, targetId }, id, skipped);
    } catch (err) {
      setNotice({ text: explain(err), tone: 'error' });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [finishOp, progressTo, t]);

  const copy = useCallback(() => { if (gate('copy')) void runCopyOrMove('copy'); }, [gate, runCopyOrMove]);
  const move = useCallback(() => { if (gate('move')) void runCopyOrMove('move'); }, [gate, runCopyOrMove]);

  const runRemove = useCallback(async (onlyKeys?: string[], pane?: PaneId) => {
    if (busyRef.current) return;
    const id = pane ?? latest.current.active;
    const a = latest.current.models[id];
    if (a.state.location.kind !== 'playlist' || !a.perms.canEdit) return;
    const keys = onlyKeys ?? operationTargets(a.marked, a.visibleKeys, a.cursor);
    if (keys.length === 0) return;
    busyRef.current = true;
    setBusy({ op: 'remove', done: 0, total: keys.length });
    try {
      const playlistId = a.state.location.id;
      const outcome = await executeRemove(playlistApi, {
        playlistId,
        keys,
        sourceKeys: a.detail?.songKeys ?? [],
        onProgress: progressTo,
      });
      finishOp(outcome, { op: 'remove', sourceId: playlistId, targetId: null }, id, 0);
    } catch (err) {
      setNotice({ text: explain(err), tone: 'error' });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [finishOp, progressTo]);

  /** Called after the page confirmed the removal. */
  const remove = useCallback(() => { if (gate('remove')) void runRemove(); }, [gate, runRemove]);

  const retry = useCallback(() => {
    const view = latest.current.result;
    if (!view || view.outcome.retryKeys.length === 0 || busyRef.current) return;
    const keys = view.outcome.retryKeys;
    const { op, sourceId, targetId } = view.retry;
    const paneFor = (playlistId: string | null): PaneId | null =>
      (['a', 'b'] as const).find((p) => {
        const l = latest.current.models[p].state.location;
        return playlistId !== null && l.kind === 'playlist' && l.id === playlistId;
      }) ?? null;
    if (op === 'remove') {
      const p = paneFor(sourceId);
      if (p) void runRemove(keys, p);
      return;
    }
    const target = paneFor(targetId);
    const source = op === 'move' ? paneFor(sourceId) : (target ? OTHER_PANE[target] : null);
    if (target && source) void runCopyOrMove(op, keys, source, target);
  }, [runCopyOrMove, runRemove]);

  const undo = useCallback(async () => {
    const view = latest.current.result;
    const plan: UndoPlan | null = view?.outcome.undo ?? null;
    if (!view || !plan || view.undone !== undefined || busyRef.current) return;
    busyRef.current = true;
    setBusy({ op: 'undo', done: 0, total: plan.steps.reduce((n, s) => n + s.keys.length, 0) });
    try {
      const out = await executeUndo(playlistApi, plan, progressTo);
      const touched = Object.values(out.details);
      if (touched.length > 0) {
        setDetails((prev) => {
          const next = { ...prev };
          for (const d of touched) next[d.id] = d;
          return next;
        });
        setPlaylists((prev) => prev.map((p) => {
          const d = touched.find((x) => x.id === p.id);
          return d ? summaryOf(d, p) : p;
        }));
      }
      setResult({ ...view, undone: { failed: out.failed.length + out.notAttempted.length } });
      setNotice({ text: out.failed.length > 0 ? `${t.mgrResUndone} · ${interpolate(t.mgrResFailed, { n: out.failed.length })}` : t.mgrResUndone, tone: out.failed.length > 0 ? 'error' : 'info' });
    } catch (err) {
      setNotice({ text: explain(err), tone: 'error' });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [progressTo, t]);

  /** Ctrl+↑/↓: moves the marked (or cursor) songs inside the playlist; optimistic, calls are serialised. */
  const reorder = useCallback((dir: -1 | 1) => {
    if (!gate('reorder')) return;
    const id = latest.current.active;
    const a = latest.current.models[id];
    if (a.state.location.kind !== 'playlist' || !a.detail) return;
    const playlistId = a.state.location.id;
    const before = a.detail.songKeys;
    const next = moveBlock(before, new Set(operationTargets(a.marked, a.visibleKeys, a.cursor)), dir);
    if (next.every((k, i) => k === before[i])) return;
    setDetails((prev) => ({ ...prev, [playlistId]: { ...prev[playlistId], songKeys: next } }));
    reorderChain.current = reorderChain.current.then(async () => {
      try {
        await reorderPlaylist(playlistId, next);
      } catch (err) {
        setNotice({ text: interpolate(t.mgrReorderFailed, { error: explain(err) }), tone: 'error' });
        try {
          const fresh = await fetchPlaylist(playlistId);
          setDetails((prev) => ({ ...prev, [fresh.id]: fresh }));
        } catch {
          /* keep the optimistic order; the notice already says it failed */
        }
      }
    });
  }, [gate, t]);

  const rename = useCallback(async (name: string): Promise<boolean> => {
    const a = latest.current.models[latest.current.active];
    if (a.state.location.kind !== 'playlist' || !a.perms.canEdit) return false;
    try {
      const updated = await renamePlaylist(a.state.location.id, name);
      setDetails((prev) => ({ ...prev, [updated.id]: { ...(prev[updated.id] ?? updated), name: updated.name } }));
      setPlaylists((prev) => prev.map((p) => (p.id === updated.id ? { ...p, name: updated.name, updatedAt: updated.updatedAt } : p)));
      setNotice({ text: t.mgrRenameDone, tone: 'info' });
      return true;
    } catch (err) {
      setNotice({ text: explain(err), tone: 'error' });
      return false;
    }
  }, [t]);

  /** Keep the library where it is: a new playlist replaces the pane that is NOT showing the library. */
  const openNewPlaylist = useCallback((playlistId: string) => {
    const snap = latest.current;
    const libraryPane = (['a', 'b'] as const).find((p) => snap.models[p].state.location.kind === 'library');
    const into: PaneId = libraryPane ? OTHER_PANE[libraryPane] : snap.active;
    selectLocation(into, { kind: 'playlist', id: playlistId });
  }, [selectLocation]);

  /** F7: creates an EMPTY playlist (the "new playlists start empty" rule) and shows it where it is most useful. */
  const newPlaylist = useCallback(async (name: string): Promise<boolean> => {
    try {
      const created = await createPlaylist(name);
      setDetails((prev) => ({ ...prev, [created.id]: created }));
      setPlaylists((prev) => [summaryOf(created), ...prev]);
      openNewPlaylist(created.id);
      setNotice({ text: interpolate(t.mgrNewDone, { name: created.name }), tone: 'info' });
      return true;
    } catch (err) {
      setNotice({ text: explain(err), tone: 'error' });
      return false;
    }
  }, [explain, openNewPlaylist, t]);

  /** Records a (re-)evaluated dynamic playlist: its songs, its summary and when it was evaluated. */
  const applyDynamic = useCallback((detail: PlaylistDetail) => {
    setDetails((prev) => ({ ...prev, [detail.id]: detail }));
    setEvaluatedAt((prev) => ({ ...prev, [detail.id]: detail.generatedAt ?? new Date().toISOString() }));
    setPlaylists((prev) => (prev.some((p) => p.id === detail.id)
      ? prev.map((p) => (p.id === detail.id ? summaryOf(detail, p) : p))
      : [summaryOf(detail), ...prev]));
  }, []);

  /** F2: creates a dynamic playlist from a rule (`POST /api/playlists {name, kind: 'dynamic', rule}`). */
  const createDynamic = useCallback(async (name: string, rule: DynamicRule): Promise<boolean> => {
    try {
      const created = await createDynamicPlaylist(name, rule);
      applyDynamic({ ...created, kind: 'dynamic' });
      openNewPlaylist(created.id);
      setNotice({ text: interpolate(t.mgrRuleCreated, { name: created.name, n: created.songKeys.length }), tone: 'info' });
      return true;
    } catch (err) {
      setNotice({ text: explain(err), tone: 'error' });
      return false;
    }
  }, [applyDynamic, explain, openNewPlaylist, t]);

  /** F4 on a dynamic playlist: changes its RULE (`PATCH /api/playlists/:id {rule}`); the name cannot change. */
  const updateRule = useCallback(async (rule: DynamicRule): Promise<boolean> => {
    const a = latest.current.models[latest.current.active];
    if (a.state.location.kind !== 'playlist' || !a.perms.canEditRule) return false;
    try {
      const updated = await updatePlaylistRule(a.state.location.id, rule);
      applyDynamic({ ...updated, kind: 'dynamic' });
      setNotice({ text: interpolate(t.mgrRuleUpdated, { n: updated.songKeys.length }), tone: 'info' });
      return true;
    } catch (err) {
      setNotice({ text: explain(err), tone: 'error' });
      return false;
    }
  }, [applyDynamic, explain, t]);

  /** "Recalculate": evaluates the dynamic playlist of a pane again. */
  const refreshDynamic = useCallback(async (paneId: PaneId): Promise<void> => {
    const m = latest.current.models[paneId];
    if (m.state.location.kind !== 'playlist' || !m.isDynamic) return;
    try {
      applyDynamic(await fetchPlaylist(m.state.location.id));
    } catch (err) {
      setNotice({ text: explain(err), tone: 'error' });
    }
  }, [applyDynamic, explain]);

  /** The share dialog reports the new list so the pane header stays in sync. */
  const applyShares = useCallback((playlistId: string, sharedWith: string[]) => {
    setShares((prev) => ({ ...prev, [playlistId]: sharedWith }));
  }, []);

  const familyName = useCallback((userId: string): string => {
    const found = me?.family.find((f) => f.id === userId);
    return found?.displayName ?? userId;
  }, [me]);

  const songLabel = useCallback((key: string): string => {
    const s = latest.current.songsByKey.get(key);
    const base = s ?? placeholderSong(key);
    return base.artist ? `${base.artist} — ${base.title}` : base.title;
  }, []);

  const dismissResult = useCallback(() => { setResult(null); setNotice(null); }, []);

  return {
    loading,
    loadError,
    reload: () => load(true),
    songs,
    playlists,
    me,
    viewer,
    models,
    active,
    setActive,
    busy,
    result,
    notice,
    setNotice,
    dismissResult,
    reasonText,
    explain,
    explainMessage,
    availability: (action: ActionId) => availabilityIn(action, { models, details, playlists, songsByKey, active, result, busy }),
    familyName,
    songLabel,
    selectLocation,
    setFilters,
    resetFilters,
    toggleFilters,
    setSort,
    setCursor,
    moveCursor,
    toggleMark,
    markRange,
    markAll,
    invert,
    clearMarks,
    markPattern,
    copy,
    move,
    remove,
    reorder,
    rename,
    newPlaylist,
    createDynamic,
    updateRule,
    refreshDynamic,
    undo,
    retry,
    applyShares,
  };
}

export type PlaylistManager = ReturnType<typeof usePlaylistManager>;
