import { describe, expect, it } from 'vitest';
import { actionAvailability, panePermissions, sameLocation } from './managerPermissions';
import type { ActionContext, PaneLocation, PanePermissions } from './managerPermissions';
import type { PlaylistSummary } from '../types';

const pl = (id: string, ownerUser?: string, kind?: 'static' | 'dynamic'): PlaylistSummary => ({
  id, name: id, songCount: 0, createdAt: '', updatedAt: '', ...(ownerUser ? { ownerUser } : {}), ...(kind ? { kind } : {}),
});

const PLAYLISTS = [
  pl('mine', 'mike'), pl('sara-mix', 'sara'), pl('orphan', 'anonymous'), pl('legacy'),
  pl('night', 'mike', 'dynamic'), pl('sara-dyn', 'sara', 'dynamic'),
];
const MIKE = { user: 'mike', authenticated: true };

describe('panePermissions', () => {
  it('the library is never editable', () => {
    expect(panePermissions({ kind: 'library' }, PLAYLISTS, MIKE)).toMatchObject({
      isLibrary: true, canEdit: false, canShare: false, canDelete: false, denyReason: 'library',
    });
  });

  it('the owner can edit, delete and (when logged in) share', () => {
    expect(panePermissions({ kind: 'playlist', id: 'mine' }, PLAYLISTS, MIKE)).toEqual({
      isLibrary: false, isOwner: true, isDynamic: false, canEdit: true, canEditRule: false, canDelete: true, canShare: true, denyReason: null,
    });
  });

  it('sharing needs a real login even for the owner (backend answers 401 otherwise)', () => {
    const p = panePermissions({ kind: 'playlist', id: 'mine' }, PLAYLISTS, { user: 'mike', authenticated: false });
    expect(p).toMatchObject({ canEdit: true, canShare: false });
  });

  it('a playlist shared with the viewer is read-only (the backend refuses every write with 404)', () => {
    expect(panePermissions({ kind: 'playlist', id: 'sara-mix' }, PLAYLISTS, MIKE)).toMatchObject({
      isOwner: false, canEdit: false, canShare: false, canDelete: false, denyReason: 'shared',
    });
  });

  it('anonymous-owned playlists are read-only even for an admin', () => {
    expect(panePermissions({ kind: 'playlist', id: 'orphan' }, PLAYLISTS, MIKE)).toMatchObject({
      canEdit: false, denyReason: 'anonymous',
    });
  });

  it('an unknown playlist or one without owner info', () => {
    expect(panePermissions({ kind: 'playlist', id: 'nope' }, PLAYLISTS, MIKE)).toMatchObject({ canEdit: false, denyReason: 'unknown' });
    expect(panePermissions({ kind: 'playlist', id: 'legacy' }, PLAYLISTS, MIKE)).toMatchObject({ isOwner: true, canEdit: true });
  });

  it('without a known viewer only owner-less playlists count as editable', () => {
    expect(panePermissions({ kind: 'playlist', id: 'legacy' }, PLAYLISTS, null).canEdit).toBe(true);
    expect(panePermissions({ kind: 'playlist', id: 'mine' }, PLAYLISTS, null).canEdit).toBe(false);
  });
});

describe('sameLocation', () => {
  it('compares kind and playlist id', () => {
    expect(sameLocation({ kind: 'library' }, { kind: 'library' })).toBe(true);
    expect(sameLocation({ kind: 'playlist', id: 'a' }, { kind: 'playlist', id: 'a' })).toBe(true);
    expect(sameLocation({ kind: 'playlist', id: 'a' }, { kind: 'playlist', id: 'b' })).toBe(false);
    expect(sameLocation({ kind: 'library' }, { kind: 'playlist', id: 'a' })).toBe(false);
  });
});

function ctx(active: PaneLocation, other: PaneLocation, patch: Partial<ActionContext> = {}): ActionContext {
  const perms = (loc: PaneLocation): PanePermissions => panePermissions(loc, PLAYLISTS, MIKE);
  return {
    active: perms(active), other: perms(other), activeLocation: active, otherLocation: other,
    targetCount: 2, busy: false, filtered: false, hasUndo: false, ...patch,
  };
}

const LIB: PaneLocation = { kind: 'library' };
const MINE: PaneLocation = { kind: 'playlist', id: 'mine' };
const SARA: PaneLocation = { kind: 'playlist', id: 'sara-mix' };
const SECOND: PaneLocation = { kind: 'playlist', id: 'legacy' };

describe('actionAvailability', () => {
  it('library → my playlist: copy yes, move/remove/rename/share no', () => {
    const c = ctx(LIB, MINE);
    expect(actionAvailability('copy', c)).toEqual({ enabled: true, reason: null });
    expect(actionAvailability('move', c)).toEqual({ enabled: false, reason: 'library' });
    expect(actionAvailability('remove', c)).toEqual({ enabled: false, reason: 'library' });
    expect(actionAvailability('rename', c)).toEqual({ enabled: false, reason: 'library' });
    expect(actionAvailability('share', c)).toEqual({ enabled: false, reason: 'library' });
    expect(actionAvailability('reorder', c)).toEqual({ enabled: false, reason: 'library' });
  });

  it('my playlist → another of mine: everything works', () => {
    const c = ctx(MINE, SECOND);
    for (const a of ['copy', 'move', 'remove', 'rename', 'share', 'reorder'] as const) {
      expect(actionAvailability(a, c)).toEqual({ enabled: true, reason: null });
    }
  });

  it('copy needs an editable playlist in the other pane', () => {
    expect(actionAvailability('copy', ctx(MINE, LIB))).toEqual({ enabled: false, reason: 'noTarget' });
    expect(actionAvailability('copy', ctx(LIB, SARA))).toEqual({ enabled: false, reason: 'readOnly' });
    expect(actionAvailability('copy', ctx(MINE, MINE))).toEqual({ enabled: false, reason: 'samePlaylist' });
  });

  it('a shared playlist can be read, copied FROM and played, but not edited', () => {
    const c = ctx(SARA, MINE);
    expect(actionAvailability('copy', c).enabled).toBe(true);
    expect(actionAvailability('play', c).enabled).toBe(true);
    expect(actionAvailability('move', c)).toEqual({ enabled: false, reason: 'readOnly' });
    expect(actionAvailability('remove', c)).toEqual({ enabled: false, reason: 'readOnly' });
    expect(actionAvailability('rename', c)).toEqual({ enabled: false, reason: 'readOnly' });
    expect(actionAvailability('share', c)).toEqual({ enabled: false, reason: 'notOwner' });
  });

  it('reorder is refused in a filtered view', () => {
    expect(actionAvailability('reorder', ctx(MINE, LIB, { filtered: true }))).toEqual({ enabled: false, reason: 'filtered' });
  });

  it('actions on songs need at least one target', () => {
    const c = ctx(MINE, SECOND, { targetCount: 0 });
    for (const a of ['copy', 'move', 'remove', 'play', 'details', 'reorder'] as const) {
      expect(actionAvailability(a, c)).toEqual({ enabled: false, reason: 'nothing' });
    }
    expect(actionAvailability('newPlaylist', c).enabled).toBe(true);
    expect(actionAvailability('rename', c).enabled).toBe(true);
  });

  it('while busy only help stays available', () => {
    const c = ctx(MINE, SECOND, { busy: true });
    expect(actionAvailability('copy', c)).toEqual({ enabled: false, reason: 'busy' });
    expect(actionAvailability('newPlaylist', c)).toEqual({ enabled: false, reason: 'busy' });
    expect(actionAvailability('help', c).enabled).toBe(true);
  });

  it('share needs a login, undo needs something to undo', () => {
    const noLogin = { ...ctx(MINE, SECOND), active: panePermissions(MINE, PLAYLISTS, { user: 'mike', authenticated: false }) };
    expect(actionAvailability('share', noLogin)).toEqual({ enabled: false, reason: 'notAuth' });
    expect(actionAvailability('undo', ctx(MINE, SECOND))).toEqual({ enabled: false, reason: 'noUndo' });
    expect(actionAvailability('undo', ctx(MINE, SECOND, { hasUndo: true })).enabled).toBe(true);
  });
});

describe('dynamic playlists', () => {
  const NIGHT: PaneLocation = { kind: 'playlist', id: 'night' };
  const SARA_DYN: PaneLocation = { kind: 'playlist', id: 'sara-dyn' };

  it('the owner cannot edit the songs (409 playlist_is_dynamic) but can edit the rule and share', () => {
    expect(panePermissions(NIGHT, PLAYLISTS, MIKE)).toEqual({
      isLibrary: false, isOwner: true, isDynamic: true, canEdit: false, canEditRule: true, canDelete: true, canShare: true, denyReason: 'dynamic',
    });
  });

  it('a dynamic playlist of somebody else is read-only and its rule is not mine to edit', () => {
    expect(panePermissions(SARA_DYN, PLAYLISTS, MIKE)).toMatchObject({
      isDynamic: true, canEdit: false, canEditRule: false, canShare: false, denyReason: 'shared',
    });
  });

  it('add / remove / reorder / move / rename are refused with the reason "dynamic"', () => {
    const c = ctx(NIGHT, MINE);
    for (const a of ['remove', 'reorder', 'move', 'rename'] as const) {
      expect(actionAvailability(a, c)).toEqual({ enabled: false, reason: 'dynamic' });
    }
  });

  it('copying FROM a dynamic playlist into a static one is allowed; copying INTO one is not', () => {
    expect(actionAvailability('copy', ctx(NIGHT, MINE))).toEqual({ enabled: true, reason: null });
    expect(actionAvailability('copy', ctx(MINE, NIGHT))).toEqual({ enabled: false, reason: 'dynamic' });
    expect(actionAvailability('copy', ctx(LIB, NIGHT))).toEqual({ enabled: false, reason: 'dynamic' });
    // a dynamic playlist of somebody else can still be copied from
    expect(actionAvailability('copy', ctx(SARA_DYN, MINE)).enabled).toBe(true);
  });

  it('editRule: only on my own dynamic playlist', () => {
    expect(actionAvailability('editRule', ctx(NIGHT, MINE))).toEqual({ enabled: true, reason: null });
    expect(actionAvailability('editRule', ctx(MINE, NIGHT))).toEqual({ enabled: false, reason: 'notDynamic' });
    expect(actionAvailability('editRule', ctx(LIB, MINE))).toEqual({ enabled: false, reason: 'library' });
    expect(actionAvailability('editRule', ctx(SARA_DYN, MINE))).toEqual({ enabled: false, reason: 'notOwner' });
  });

  it('creating a dynamic playlist is always possible (unless busy)', () => {
    expect(actionAvailability('newDynamic', ctx(LIB, LIB)).enabled).toBe(true);
    expect(actionAvailability('newDynamic', ctx(SARA, LIB, { busy: true }))).toEqual({ enabled: false, reason: 'busy' });
  });

  it('share works as for a static playlist', () => {
    expect(actionAvailability('share', ctx(NIGHT, MINE)).enabled).toBe(true);
    expect(actionAvailability('share', ctx(SARA_DYN, MINE))).toEqual({ enabled: false, reason: 'notOwner' });
  });
});
