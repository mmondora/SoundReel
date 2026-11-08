/**
 * What the user may do with the playlist shown in a pane, mirroring the backend rules
 * (backend/src/routes/playlists.ts + services/playlists.ts):
 *   - the playlist list contains the playlists the user owns and the ones shared with them;
 *   - rename / delete / add / remove / reorder are OWNER ONLY (anybody else gets a 404);
 *   - share / unshare are owner only AND need a real Authelia login (`authenticated`).
 * A playlist shared with the viewer is therefore read-only.
 *
 * Dynamic playlists (a rule re-evaluated on every request) are read-only for their SONGS even for the owner: the
 * backend answers 409 playlist_is_dynamic to add / remove / reorder / rename. The owner can still change the
 * RULE (PATCH {rule}), share it, and copy FROM it into a static playlist.
 */
import type { PlaylistSummary } from '../types';

export type PaneLocation = { kind: 'library' } | { kind: 'playlist'; id: string };

export interface Viewer {
  user: string;
  authenticated: boolean;
}

export type DenyReason = 'library' | 'shared' | 'anonymous' | 'unknown' | 'dynamic';

export interface PanePermissions {
  isLibrary: boolean;
  isOwner: boolean;
  /** A dynamic playlist: its songs come from a rule. */
  isDynamic: boolean;
  /** add / remove / reorder / rename */
  canEdit: boolean;
  /** Dynamic playlist of the viewer: its rule can be edited. */
  canEditRule: boolean;
  canShare: boolean;
  canDelete: boolean;
  /** Why editing is refused (for tooltips); null when it is allowed. */
  denyReason: DenyReason | null;
}

const NONE: Omit<PanePermissions, 'isLibrary' | 'denyReason'> = {
  isOwner: false,
  isDynamic: false,
  canEdit: false,
  canEditRule: false,
  canShare: false,
  canDelete: false,
};

export function sameLocation(a: PaneLocation, b: PaneLocation): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'library' || (b.kind === 'playlist' && a.id === b.id);
}

export function panePermissions(
  location: PaneLocation,
  playlists: readonly PlaylistSummary[],
  viewer: Viewer | null,
): PanePermissions {
  if (location.kind === 'library') return { ...NONE, isLibrary: true, denyReason: 'library' };

  const playlist = playlists.find((p) => p.id === location.id);
  if (!playlist) return { ...NONE, isLibrary: false, denyReason: 'unknown' };

  // Older payloads carry no owner: those playlists predate multi-user and belong to the viewer.
  const owner = playlist.ownerUser;
  const isOwner = viewer ? (owner ?? viewer.user) === viewer.user : owner === undefined;
  const isDynamic = playlist.kind === 'dynamic';
  if (!isOwner) {
    return { ...NONE, isDynamic, isLibrary: false, denyReason: owner === 'anonymous' ? 'anonymous' : 'shared' };
  }
  return {
    isLibrary: false,
    isOwner: true,
    isDynamic,
    canEdit: !isDynamic,
    canEditRule: isDynamic,
    canDelete: true,
    canShare: viewer?.authenticated === true,
    denyReason: isDynamic ? 'dynamic' : null,
  };
}

export type ActionId =
  | 'play'
  | 'details'
  | 'rename'
  | 'editRule'
  | 'newDynamic'
  | 'copy'
  | 'move'
  | 'newPlaylist'
  | 'remove'
  | 'share'
  | 'reorder'
  | 'help'
  | 'undo';

export type ReasonKey =
  | 'busy'
  | 'nothing'
  | 'library'
  | 'readOnly'
  | 'noTarget'
  | 'samePlaylist'
  | 'notOwner'
  | 'filtered'
  | 'notAuth'
  | 'noUndo'
  | 'dynamic'
  | 'notDynamic';

export interface Availability {
  enabled: boolean;
  reason: ReasonKey | null;
}

export interface ActionContext {
  active: PanePermissions;
  other: PanePermissions;
  activeLocation: PaneLocation;
  otherLocation: PaneLocation;
  /** Songs the action would act on (marked rows, else the cursor row). */
  targetCount: number;
  busy: boolean;
  /** Any filter active in the pane: reordering a filtered view is ambiguous, so it is refused. */
  filtered: boolean;
  hasUndo: boolean;
}

const yes: Availability = { enabled: true, reason: null };
const no = (reason: ReasonKey): Availability => ({ enabled: false, reason });

/** Fn bar / key dispatcher gate: is this action allowed right now, and if not, why. */
export function actionAvailability(action: ActionId, ctx: ActionContext): Availability {
  if (action === 'help') return yes;
  if (ctx.busy) return no('busy');

  const { active, other } = ctx;
  switch (action) {
    case 'play':
    case 'details':
      return ctx.targetCount > 0 ? yes : no('nothing');
    case 'newPlaylist':
    case 'newDynamic':
      return yes;
    case 'undo':
      return ctx.hasUndo ? yes : no('noUndo');
    case 'rename':
      if (active.isLibrary) return no('library');
      // A dynamic playlist cannot be renamed (409); what the owner changes is its rule (editRule).
      if (active.isDynamic) return no('dynamic');
      return active.canEdit ? yes : no('readOnly');
    case 'editRule':
      if (active.isLibrary) return no('library');
      if (!active.isDynamic) return no('notDynamic');
      return active.canEditRule ? yes : no('notOwner');
    case 'share':
      if (active.isLibrary) return no('library');
      if (!active.isOwner) return no('notOwner');
      return active.canShare ? yes : no('notAuth');
    case 'remove':
      if (active.isLibrary) return no('library');
      if (active.isDynamic) return no('dynamic');
      if (!active.canEdit) return no('readOnly');
      return ctx.targetCount > 0 ? yes : no('nothing');
    case 'reorder':
      if (active.isLibrary) return no('library');
      if (active.isDynamic) return no('dynamic');
      if (!active.canEdit) return no('readOnly');
      if (ctx.filtered) return no('filtered');
      return ctx.targetCount > 0 ? yes : no('nothing');
    case 'copy':
    case 'move': {
      // Copying FROM a dynamic playlist is fine (it adds the songs it has right now); moving is not.
      if (action === 'move') {
        if (active.isLibrary) return no('library');
        if (active.isDynamic) return no('dynamic');
        if (!active.canEdit) return no('readOnly');
      }
      if (ctx.targetCount === 0) return no('nothing');
      if (other.isLibrary || other.denyReason === 'unknown') return no('noTarget');
      if (other.isDynamic) return no('dynamic');
      if (!other.canEdit) return no('readOnly');
      if (sameLocation(ctx.activeLocation, ctx.otherLocation)) return no('samePlaylist');
      return yes;
    }
  }
}
