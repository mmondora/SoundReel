import { describe, expect, it } from 'vitest';
import {
  extraFolders,
  folderError,
  needsPolling,
  normalizeMusicFolders,
  toInputs,
  withAdded,
  withEnabled,
  withLabel,
  without,
} from './musicFolders';
import type { MusicFolder } from '../types';

const folder = (id: string, extra: Partial<MusicFolder> = {}): MusicFolder => ({
  id, path: `/music-extra/${id}`, label: id.toUpperCase(), enabled: true, builtIn: false, status: 'ok', files: 10, truncated: false, scannedAt: '2026-11-08T10:00:00Z', ...extra,
});
const LIBRARY = folder('library', { path: '/music', label: 'Libreria (Spooty)', builtIn: true });
const LIST = [LIBRARY, folder('a'), folder('b', { enabled: false, status: 'off' })];

describe('the list of extra folders', () => {
  it('never contains the built-in library (it is not editable and not sent)', () => {
    expect(extraFolders(LIST).map((f) => f.id)).toEqual(['a', 'b']);
    expect(toInputs(LIST)).toEqual([
      { path: '/music-extra/a', label: 'A', enabled: true },
      { path: '/music-extra/b', label: 'B', enabled: false },
    ]);
  });

  it('changes ONE folder and sends the whole list (the server replaces it)', () => {
    expect(withLabel(LIST, 'a', 'Rock')).toEqual([
      { path: '/music-extra/a', label: 'Rock', enabled: true },
      { path: '/music-extra/b', label: 'B', enabled: false },
    ]);
    expect(withEnabled(LIST, 'b', true).map((f) => f.enabled)).toEqual([true, true]);
    expect(withEnabled(LIST, 'a', false).map((f) => f.enabled)).toEqual([false, false]);
    expect(without(LIST, 'a')).toEqual([{ path: '/music-extra/b', label: 'B', enabled: false }]);
    expect(without(LIST, 'nope')).toHaveLength(2);
  });

  it('adds at the end, enabled, leaving the label to the server (it uses the folder name)', () => {
    const added = withAdded(LIST, '/music-extra/new');
    expect(added).toHaveLength(3);
    expect(added[2]).toEqual({ path: '/music-extra/new', enabled: true });
    expect(added[2]).not.toHaveProperty('label');
  });
});

describe('needsPolling', () => {
  it('while an enabled folder is scanning or waiting to be scanned', () => {
    expect(needsPolling([LIBRARY, folder('a', { status: 'scanning' })])).toBe(true);
    expect(needsPolling([LIBRARY, folder('a', { status: 'pending' })])).toBe(true);
  });

  it('not when everything is settled (ok, missing, off)', () => {
    expect(needsPolling(LIST)).toBe(false);
    expect(needsPolling([folder('a', { status: 'missing' })])).toBe(false);
    expect(needsPolling([folder('a', { enabled: false, status: 'pending' })])).toBe(false);
    expect(needsPolling([])).toBe(false);
  });
});

describe('folderError: what the server said, in terms of a message and the folder at fault', () => {
  const sent = [{ path: '/music-extra/a' }, { path: '/etc' }];
  const info = (code: string | null, index: number | null = null, status: number | null = null) => ({ code, index, status, message: `m-${code}` });

  it.each([
    ['folder_outside_roots', 'mfErrOutside'],
    ['folder_missing', 'mfErrMissing'],
    ['folder_not_directory', 'mfErrNotDir'],
    ['already_included', 'mfErrIncluded'],
    ['too_many_folders', 'mfErrTooMany'],
    ['invalid_folder', 'mfErrInvalid'],
    ['forbidden', 'mfErrForbidden'],
    ['network', 'mfErrNetwork'],
  ])('%s → %s', (code, key) => {
    expect(folderError(info(code), sent).key).toBe(key);
  });

  it('names the folder the index points at; a list-level error (-1) or no index names none', () => {
    expect(folderError(info('folder_outside_roots', 1), sent).path).toBe('/etc');
    expect(folderError(info('too_many_folders', -1), sent).path).toBeNull();
    expect(folderError(info('folder_missing'), sent).path).toBeNull();
    expect(folderError(info('folder_missing', 7), sent).path).toBeNull(); // index beyond what was sent
  });

  it('403 without a body is "forbidden"; an unknown code is "unknown" and keeps what the server said', () => {
    expect(folderError(info(null, null, 403)).key).toBe('mfErrForbidden');
    expect(folderError(info(null, null, 401)).key).toBe('mfErrForbidden');
    expect(folderError(info('disk on fire')).key).toBe('mfErrUnknown');
    expect(folderError(info('disk on fire')).detail).toBe('disk on fire');
  });
});

describe('normalizeMusicFolders (tolerant reading)', () => {
  it('reads the documented shape', () => {
    const out = normalizeMusicFolders({
      roots: [{ path: '/music', label: 'Libreria', builtIn: true }, { path: '/music-extra', label: 'Extra', builtIn: false }],
      folders: [
        { id: 'x', path: '/music-extra/x', label: 'X', enabled: true, builtIn: false, status: 'scanning', files: 3, truncated: false, scannedAt: null },
        { id: 'library', path: '/music', label: 'Libreria', enabled: true, builtIn: true, status: 'ok', files: 9, truncated: true, scannedAt: '2026-11-08T09:00:00Z' },
      ],
    });
    expect(out.roots).toHaveLength(2);
    expect(out.folders.map((f) => f.id)).toEqual(['library', 'x']); // the built-in first
    expect(out.folders[0]).toMatchObject({ builtIn: true, truncated: true, files: 9 });
  });

  it('a missing field is a default; junk entries are dropped; an unknown status is "pending"', () => {
    const out = normalizeMusicFolders({ folders: [{ path: '/m/a' }, { nope: 1 }, 'x', { path: '/m/b', status: 'weird', enabled: false }] });
    expect(out.folders).toHaveLength(2);
    expect(out.folders[0]).toEqual({ id: '/m/a', path: '/m/a', label: '/m/a', enabled: true, builtIn: false, status: 'pending', files: 0, truncated: false, scannedAt: null });
    expect(out.folders[1]).toMatchObject({ status: 'pending', enabled: false });
    expect(normalizeMusicFolders(null)).toEqual({ roots: [], folders: [] });
    expect(normalizeMusicFolders('x')).toEqual({ roots: [], folders: [] });
  });
});
