import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEntryById } from './useEntryById';
import * as api from '../services/api';
import type { Entry } from '../types';

vi.mock('../services/api', () => ({ getEntry: vi.fn() }));

// The Link page lists summaries; the post a user opens is read by its id (once), and a slow answer for the post that was open before never
// replaces the one open now.

const entry = (id: string): Entry => ({
  id, sourceUrl: `https://x/${id}`, sourcePlatform: 'instagram', inputChannel: 'web', inputUser: null, caption: null, thumbnailUrl: null, mediaUrl: null,
  status: 'completed', results: { songs: [], films: [], notes: [], links: [], tags: [] }, actionLog: [], createdAt: '2026-11-10T10:00:00Z',
});
const getEntry = vi.mocked(api.getEntry);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => { getEntry.mockReset(); });   // braces: a returned function would be run by vitest as the cleanup of the test

describe('useEntryById', () => {
  it('no id: nothing is read', () => {
    const { result } = renderHook(() => useEntryById(null));
    expect(result.current).toEqual({ entry: null, loading: false });
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('an id is read once; the post is there when the answer comes', async () => {
    const answer = deferred<Entry>();
    getEntry.mockReturnValue(answer.promise);
    const { result, rerender } = renderHook(({ id }) => useEntryById(id), { initialProps: { id: 'a' as string | null } });
    expect(result.current).toEqual({ entry: null, loading: true });
    await act(async () => { answer.resolve(entry('a')); });
    expect(result.current.entry?.id).toBe('a');
    expect(result.current.loading).toBe(false);
    rerender({ id: 'a' });
    expect(getEntry).toHaveBeenCalledTimes(1);
    expect(getEntry).toHaveBeenCalledWith('a');
  });

  it('a post that is already known is not read again', () => {
    const known = [entry('k')];
    const { result } = renderHook(() => useEntryById('k', known));
    expect(result.current.entry).toBe(known[0]);
    expect(getEntry).not.toHaveBeenCalled();
  });

  it('closing (no id) drops the post', async () => {
    getEntry.mockResolvedValue(entry('a'));
    const { result, rerender } = renderHook(({ id }) => useEntryById(id), { initialProps: { id: 'a' as string | null } });
    await waitFor(() => expect(result.current.entry?.id).toBe('a'));
    rerender({ id: null });
    expect(result.current).toEqual({ entry: null, loading: false });
  });

  it('a slow answer for the post open before does not replace the one open now', async () => {
    const first = deferred<Entry>();
    const second = deferred<Entry>();
    getEntry.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ id }) => useEntryById(id), { initialProps: { id: 'a' as string | null } });
    rerender({ id: 'b' });
    await act(async () => { second.resolve(entry('b')); });
    await act(async () => { first.resolve(entry('a')); });
    expect(result.current.entry?.id).toBe('b');
  });

  it('while the next post is being read the one before is not shown in its place', async () => {
    const second = deferred<Entry>();
    getEntry.mockResolvedValueOnce(entry('a')).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ id }) => useEntryById(id), { initialProps: { id: 'a' as string | null } });
    await waitFor(() => expect(result.current.entry?.id).toBe('a'));
    rerender({ id: 'b' });
    expect(result.current).toEqual({ entry: null, loading: true });
    await act(async () => { second.resolve(entry('b')); });
    expect(result.current.entry?.id).toBe('b');
  });

  it('a post that cannot be read is no post, not a crash, and not a spinner for ever', async () => {
    getEntry.mockRejectedValue(new Error('HTTP 404'));
    const { result } = renderHook(() => useEntryById('gone'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entry).toBeNull();
  });

  describe('a version (the library changed: an analysis moved)', () => {
    const open = (id: string, version: number) => useEntryById(id, undefined, version);

    it('a new version reads the same post again, and the post that is on the screen stays until the new answer comes', async () => {
      const again = deferred<Entry>();
      getEntry.mockResolvedValueOnce({ ...entry('a'), status: 'processing' }).mockReturnValueOnce(again.promise);
      const { result, rerender } = renderHook(({ version }) => open('a', version), { initialProps: { version: 0 } });
      await waitFor(() => expect(result.current.entry?.status).toBe('processing'));
      rerender({ version: 1 });
      expect(result.current.entry?.status).toBe('processing');
      expect(result.current.loading).toBe(false);
      await act(async () => { again.resolve(entry('a')); });
      expect(result.current.entry?.status).toBe('completed');
      expect(getEntry).toHaveBeenCalledTimes(2);
    });

    it('the same version does not read again', async () => {
      getEntry.mockResolvedValue(entry('a'));
      const { result, rerender } = renderHook(({ version }) => open('a', version), { initialProps: { version: 3 } });
      await waitFor(() => expect(result.current.entry?.id).toBe('a'));
      rerender({ version: 3 });
      expect(getEntry).toHaveBeenCalledTimes(1);
    });

    it('a re-read that fails keeps the post that is on the screen', async () => {
      getEntry.mockResolvedValueOnce(entry('a')).mockRejectedValueOnce(new Error('HTTP 500'));
      const { result, rerender } = renderHook(({ version }) => open('a', version), { initialProps: { version: 0 } });
      await waitFor(() => expect(result.current.entry?.id).toBe('a'));
      rerender({ version: 1 });
      await waitFor(() => expect(getEntry).toHaveBeenCalledTimes(2));
      await act(async () => { await Promise.resolve(); });
      expect(result.current.entry?.id).toBe('a');
    });

    it('a post that is not there any more after a re-read is no post at the first read, but a first read that fails is still no post', async () => {
      getEntry.mockRejectedValue(new Error('HTTP 404'));
      const { result } = renderHook(() => open('gone', 0));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.entry).toBeNull();
    });
  });
});
