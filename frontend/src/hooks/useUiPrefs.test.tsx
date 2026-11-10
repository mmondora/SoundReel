import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiPrefsProvider, usePageView, useUiPrefs } from './useUiPrefs';
import { readCachedPrefs, writeCachedPrefs } from '../utils/uiPrefs';
import * as api from '../services/api';
import type { UiPrefs } from '../types';

vi.mock('../services/api', async (original) => ({
  ...(await original<typeof import('../services/api')>()),
  fetchUiPrefs: vi.fn(),
  saveUiPrefs: vi.fn(),
  resetUiPrefs: vi.fn(),
}));

// ADR-0026 / docs/ui-prefs.md: the configuration lives on the server, per user. The provider reads it once, draws the copy of the session
// while the answer is on its way, applies a change at once and puts it back if the server refuses. No default is decided here.

const SECTIONS: UiPrefs['home']['sections'] = [
  { id: 'resume', visible: true }, { id: 'songs', visible: true }, { id: 'playlists', visible: true },
  { id: 'collections', visible: true }, { id: 'films', visible: true },
];
const BASE: UiPrefs = { v: 1, views: { inbox: 'studio', links: 'studio' }, home: { sections: SECTIONS }, player: { dock: 'bottom', float: { x: 1, y: 1 } } };
const WALL: UiPrefs = { ...BASE, views: { inbox: 'wall', links: 'studio' } };
const LINKS_ONLY: UiPrefs = { ...BASE, views: { inbox: 'studio', links: 'wall' } };
const BOTH: UiPrefs = { ...BASE, views: { inbox: 'wall', links: 'wall' } };

const fetchPrefs = vi.mocked(api.fetchUiPrefs);
const savePrefs = vi.mocked(api.saveUiPrefs);
const resetPrefs = vi.mocked(api.resetUiPrefs);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const wrapper = ({ children }: { children: ReactNode }) => <UiPrefsProvider>{children}</UiPrefsProvider>;

/** A provider whose first answer has already come. */
async function settled() {
  const hook = renderHook(() => useUiPrefs(), { wrapper });
  await waitFor(() => expect(hook.result.current.prefs).toEqual(BASE));
  return hook;
}

beforeEach(() => {
  sessionStorage.clear();
  fetchPrefs.mockReset();
  savePrefs.mockReset();
  resetPrefs.mockReset();
  fetchPrefs.mockResolvedValue(BASE);
});
afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('reading the configuration', () => {
  it('asks the server once, even with two readers, and shows its answer', async () => {
    const { result } = renderHook(() => [useUiPrefs(), useUiPrefs()] as const, { wrapper });
    expect(result.current[0].loading).toBe(true);
    expect(result.current[0].prefs).toBeNull();
    await waitFor(() => expect(result.current[0].prefs).toEqual(BASE));
    expect(result.current[1].prefs).toEqual(BASE);
    expect(result.current[0].loading).toBe(false);
    expect(fetchPrefs).toHaveBeenCalledTimes(1);
  });

  it('draws the first frame from the copy kept in the session; the answer of the server wins and renews the copy', async () => {
    writeCachedPrefs(WALL);
    const answer = deferred<UiPrefs>();
    fetchPrefs.mockReturnValue(answer.promise);
    const { result } = renderHook(() => useUiPrefs(), { wrapper });
    expect(result.current.prefs).toEqual(WALL);
    expect(result.current.loading).toBe(true);
    await act(async () => { answer.resolve(BASE); });
    expect(result.current.prefs).toEqual(BASE);
    expect(result.current.loading).toBe(false);
    expect(readCachedPrefs()).toEqual(BASE);
  });

  it('with no answer and no copy the page is told so: no document and not loading (the page draws the Studio, the layout every page had before the views)', async () => {
    fetchPrefs.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useUiPrefs(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.prefs).toBeNull();
  });

  it('with no answer the copy of the session stays on the page', async () => {
    writeCachedPrefs(WALL);
    fetchPrefs.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useUiPrefs(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.prefs).toEqual(WALL);
  });

  it('a storage that refuses (private window) breaks nothing: the page waits for the server', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(() => useUiPrefs(), { wrapper });
    await waitFor(() => expect(result.current.prefs).toEqual(BASE));
  });

  it('outside a provider the hook answers «no document, not loading», and a change is quietly ignored', async () => {
    const { result } = renderHook(() => useUiPrefs());
    expect(result.current.prefs).toBeNull();
    expect(result.current.loading).toBe(false);
    await expect(result.current.update({ views: { inbox: 'wall' } })).resolves.toBeUndefined();
    await expect(result.current.reset()).resolves.toBeUndefined();
    expect(savePrefs).not.toHaveBeenCalled();
    expect(resetPrefs).not.toHaveBeenCalled();
  });
});

describe('changing it', () => {
  it('a change shows at once; the server is told only the part that changes; its answer is then the truth', async () => {
    const { result } = await settled();
    const save = deferred<UiPrefs>();
    savePrefs.mockReturnValue(save.promise);
    let done!: Promise<void>;
    act(() => { done = result.current.update({ views: { inbox: 'wall' } }); });
    expect(result.current.prefs?.views.inbox).toBe('wall');
    expect(savePrefs).toHaveBeenCalledWith({ views: { inbox: 'wall' } });
    await act(async () => { save.resolve(WALL); await done; });
    expect(result.current.prefs).toEqual(WALL);
    expect(readCachedPrefs()).toEqual(WALL);
  });

  it('a refusal of the server puts the page back as it was and says so; the message can be dismissed', async () => {
    const { result } = await settled();
    savePrefs.mockRejectedValue(new Error('{"error":"invalid_prefs:views.inbox"}'));
    await act(async () => { await result.current.update({ views: { inbox: 'wall' } }); });
    expect(result.current.prefs).toEqual(BASE);
    expect(result.current.saveError).toMatch(/invalid_prefs/);
    act(() => result.current.clearSaveError());
    expect(result.current.saveError).toBeNull();
  });

  it('without a user (401) the choice stays for this visit, no error is shown, and nothing more is sent', async () => {
    const { result } = await settled();
    savePrefs.mockRejectedValue(new api.UiPrefsAnonymousError());
    await act(async () => { await result.current.update({ views: { inbox: 'wall' } }); });
    expect(result.current.prefs?.views.inbox).toBe('wall');
    expect(result.current.saveError).toBeNull();
    await act(async () => { await result.current.update({ views: { links: 'wall' } }); });
    expect(result.current.prefs?.views).toEqual({ inbox: 'wall', links: 'wall' });
    expect(savePrefs).toHaveBeenCalledTimes(1);
  });

  it('changes go to the server one at a time, in the order they were made (a late answer can never undo a newer choice)', async () => {
    const { result } = await settled();
    const first = deferred<UiPrefs>();
    const second = deferred<UiPrefs>();
    savePrefs.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.update({ views: { inbox: 'wall' } });
      p2 = result.current.update({ views: { links: 'wall' } });
    });
    expect(result.current.prefs?.views).toEqual({ inbox: 'wall', links: 'wall' });   // both show at once
    expect(savePrefs).toHaveBeenCalledTimes(1);                                          // but the second waits for the first
    expect(savePrefs).toHaveBeenLastCalledWith({ views: { inbox: 'wall' } });
    await act(async () => { first.resolve(WALL); await p1; });
    expect(savePrefs).toHaveBeenCalledTimes(2);
    expect(savePrefs).toHaveBeenLastCalledWith({ views: { links: 'wall' } });
    expect(result.current.prefs?.views).toEqual({ inbox: 'wall', links: 'wall' });   // the answer of the first does not hide the second
    await act(async () => { second.resolve(BOTH); await p2; });
    expect(result.current.prefs).toEqual(BOTH);
  });

  it('with nothing in flight a change is sent at once, also after an earlier one has finished', async () => {
    const { result } = await settled();
    savePrefs.mockResolvedValueOnce(WALL).mockResolvedValueOnce(BOTH);
    await act(async () => { await result.current.update({ views: { inbox: 'wall' } }); });
    expect(savePrefs).toHaveBeenCalledTimes(1);
    act(() => { void result.current.update({ views: { links: 'wall' } }); });
    expect(savePrefs).toHaveBeenCalledTimes(2);                                          // no waiting for a turn that is not coming
    await act(async () => { await Promise.resolve(); });
  });

  it('a refusal of one change does not undo the change made after it, which is then sent', async () => {
    const { result } = await settled();
    const first = deferred<UiPrefs>();
    savePrefs.mockReturnValueOnce(first.promise).mockResolvedValueOnce(LINKS_ONLY);
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.update({ views: { inbox: 'wall' } });
      p2 = result.current.update({ views: { links: 'wall' } });
    });
    await act(async () => { first.reject(new Error('invalid_prefs:views.inbox')); await p1; });
    expect(result.current.prefs?.views).toEqual({ inbox: 'studio', links: 'wall' });
    await act(async () => { await p2; });
    expect(savePrefs).toHaveBeenCalledTimes(2);
    expect(result.current.prefs?.views).toEqual({ inbox: 'studio', links: 'wall' });
  });

  it('a 401 on the first of two changes keeps both for this visit, and the second is never sent', async () => {
    const { result } = await settled();
    const first = deferred<UiPrefs>();
    savePrefs.mockReturnValueOnce(first.promise);
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.update({ views: { inbox: 'wall' } });
      p2 = result.current.update({ views: { links: 'wall' } });
    });
    await act(async () => { first.reject(new api.UiPrefsAnonymousError()); await p1; await p2; });
    expect(savePrefs).toHaveBeenCalledTimes(1);
    expect(result.current.prefs?.views).toEqual({ inbox: 'wall', links: 'wall' });
    expect(result.current.saveError).toBeNull();
  });

  it('a reset waits for the changes made before it, and the changes made after it stay on top of its answer', async () => {
    const { result } = await settled();
    const first = deferred<UiPrefs>();
    savePrefs.mockReturnValueOnce(first.promise);
    resetPrefs.mockResolvedValue(BASE);
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    let p3!: Promise<void>;
    savePrefs.mockResolvedValueOnce(LINKS_ONLY);
    act(() => {
      p1 = result.current.update({ views: { inbox: 'wall' } });
      p2 = result.current.reset();
      p3 = result.current.update({ views: { links: 'wall' } });
    });
    expect(resetPrefs).not.toHaveBeenCalled();                                           // after the first change, not before it
    await act(async () => { first.resolve(WALL); await p1; await p2; await p3; });
    expect(resetPrefs).toHaveBeenCalledTimes(1);
    expect(result.current.prefs).toEqual(LINKS_ONLY);                                  // the reset forgot the inbox choice, not the later one
  });

  it('a change made before the first answer is sent, and the answer of the server is then the page', async () => {
    const first = deferred<UiPrefs>();
    fetchPrefs.mockReturnValue(first.promise);
    const { result } = renderHook(() => useUiPrefs(), { wrapper });
    savePrefs.mockResolvedValue(WALL);
    await act(async () => { await result.current.update({ views: { inbox: 'wall' } }); });
    expect(savePrefs).toHaveBeenCalledWith({ views: { inbox: 'wall' } });
    expect(result.current.prefs).toEqual(WALL);
    await act(async () => { first.resolve(BASE); });                            // the read that was already on its way is older than the save
    expect(result.current.prefs).toEqual(WALL);
  });

  it('reset asks the server to forget the choices and shows the starting values it answers', async () => {
    fetchPrefs.mockResolvedValue(WALL);
    const { result } = renderHook(() => useUiPrefs(), { wrapper });
    await waitFor(() => expect(result.current.prefs).toEqual(WALL));
    resetPrefs.mockResolvedValue(BASE);
    await act(async () => { await result.current.reset(); });
    expect(resetPrefs).toHaveBeenCalledTimes(1);
    expect(result.current.prefs).toEqual(BASE);
    expect(readCachedPrefs()).toEqual(BASE);
  });

  it('once the server has said there is no user (401), a reset is not even sent', async () => {
    const { result } = await settled();
    savePrefs.mockRejectedValue(new api.UiPrefsAnonymousError());
    await act(async () => { await result.current.update({ views: { inbox: 'wall' } }); });
    await act(async () => { await result.current.reset(); });
    expect(resetPrefs).not.toHaveBeenCalled();
    expect(result.current.saveError).toBeNull();
  });

  it('a reset the server refuses leaves the page as it was and says so', async () => {
    fetchPrefs.mockResolvedValue(WALL);
    const { result } = renderHook(() => useUiPrefs(), { wrapper });
    await waitFor(() => expect(result.current.prefs).toEqual(WALL));
    resetPrefs.mockRejectedValue(new Error('prefs_unavailable'));
    await act(async () => { await result.current.reset(); });
    expect(result.current.prefs).toEqual(WALL);
    expect(result.current.saveError).toMatch(/prefs_unavailable/);
  });
});

describe('usePageView', () => {
  it('is the view the server answered, and choosing one saves only that page', async () => {
    fetchPrefs.mockResolvedValue(WALL);
    savePrefs.mockResolvedValue(BOTH);
    const { result } = renderHook(() => usePageView('inbox'), { wrapper });
    await waitFor(() => expect(result.current.view).toBe('wall'));
    expect(result.current.ready).toBe(true);
    act(() => result.current.setView('home'));
    expect(result.current.view).toBe('home');
    expect(savePrefs).toHaveBeenCalledWith({ views: { inbox: 'home' } });
  });

  it('the Link page saves its own page: `{ views: { links } }`', async () => {
    savePrefs.mockResolvedValue(LINKS_ONLY);
    const { result } = renderHook(() => usePageView('links'), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setView('wall'));
    expect(savePrefs).toHaveBeenCalledWith({ views: { links: 'wall' } });
    expect(result.current.view).toBe('wall');
  });

  it('is not ready while the first answer is on its way (a page must not flash the wrong view)', async () => {
    const answer = deferred<UiPrefs>();
    fetchPrefs.mockReturnValue(answer.promise);
    const { result } = renderHook(() => usePageView('links'), { wrapper });
    expect(result.current.ready).toBe(false);
    await act(async () => { answer.resolve(BASE); });
    expect(result.current.ready).toBe(true);
    expect(result.current.view).toBe('studio');
  });

  it('is the Studio, and ready, when the server cannot answer and there is no copy (never a blank page)', async () => {
    fetchPrefs.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => usePageView('inbox'), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.view).toBe('studio');
  });

  it('a view this build does not know (a newer server, an old bundle) or that the page does not have is drawn as the Studio', async () => {
    fetchPrefs.mockResolvedValue({ ...BASE, views: { inbox: 'timeline', links: 'home' } } as unknown as UiPrefs);
    const inbox = renderHook(() => usePageView('inbox'), { wrapper });
    const links = renderHook(() => usePageView('links'), { wrapper });
    await waitFor(() => expect(inbox.result.current.ready).toBe(true));
    await waitFor(() => expect(links.result.current.ready).toBe(true));
    expect(inbox.result.current.view).toBe('studio');
    expect(links.result.current.view).toBe('studio');
  });

  it('outside a provider it is the Studio and ready', () => {
    const { result } = renderHook(() => usePageView('links'));
    expect(result.current).toMatchObject({ view: 'studio', ready: true });
  });
});
