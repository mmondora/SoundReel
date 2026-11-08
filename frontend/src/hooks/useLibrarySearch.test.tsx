import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLibrarySearch } from './useLibrarySearch';
import * as api from '../services/api';
import type { LibrarySearchResponse } from '../types';

vi.mock('../services/api', () => ({ searchLibrary: vi.fn() }));

const answer = (q: string, counts = { songs: 0, media: 2, local: 41 }): LibrarySearchResponse => ({ q, scope: 'all', counts, results: [] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(api.searchLibrary).mockImplementation(async (q) => answer(q));
});

afterEach(() => vi.useRealTimers());

const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useLibrarySearch', () => {
  it('does nothing under 2 characters', async () => {
    const { result, rerender } = renderHook(({ text }) => useLibrarySearch(text), { initialProps: { text: '' } });
    await settle(1000);
    expect(result.current.status).toBe('idle');
    rerender({ text: 'a' });
    await settle(1000);
    expect(api.searchLibrary).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeNull();
  });

  it('waits for a pause of 300 ms, then asks ONCE, always for every scope with the cap of 100', async () => {
    const { result } = renderHook(() => useLibrarySearch('maestro bassi'));
    expect(result.current.status).toBe('waiting');
    await settle(299);
    expect(api.searchLibrary).not.toHaveBeenCalled();
    await settle(1);
    expect(api.searchLibrary).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.searchLibrary).mock.calls[0].slice(0, 3)).toEqual(['maestro bassi', 'all', 100]);
    await settle(0);
    expect(result.current.status).toBe('ready');
    expect(result.current.data?.counts).toEqual({ songs: 0, media: 2, local: 41 });
    expect(result.current.stale).toBe(false);
  });

  it('typing keeps resetting the pause: one request for the final text', async () => {
    const { rerender } = renderHook(({ text }) => useLibrarySearch(text), { initialProps: { text: 'ma' } });
    await settle(200);
    rerender({ text: 'mae' });
    await settle(200);
    rerender({ text: 'maestro' });
    await settle(299);
    expect(api.searchLibrary).not.toHaveBeenCalled();
    await settle(1);
    expect(api.searchLibrary).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.searchLibrary).mock.calls[0][0]).toBe('maestro');
  });

  it('the text is trimmed and spaces collapsed before it is sent; the same text again is not a new search', async () => {
    const { rerender } = renderHook(({ text }) => useLibrarySearch(text), { initialProps: { text: '  maestro   bassi ' } });
    await settle(400);
    expect(vi.mocked(api.searchLibrary).mock.calls[0][0]).toBe('maestro bassi');
    rerender({ text: 'maestro bassi' });
    await settle(1000);
    expect(api.searchLibrary).toHaveBeenCalledTimes(1);
  });

  it('keeps the last answer (flagged stale) while a newer text is loading', async () => {
    const { result, rerender } = renderHook(({ text }) => useLibrarySearch(text), { initialProps: { text: 'bassi' } });
    await settle(400);
    expect(result.current.data?.q).toBe('bassi');
    vi.mocked(api.searchLibrary).mockReturnValue(new Promise(() => undefined));
    rerender({ text: 'bassi maestro' });
    expect(result.current.stale).toBe(true);
    expect(result.current.data?.q).toBe('bassi');
    await settle(400);
    expect(result.current.status).toBe('loading');
  });

  it('a slow answer for an older text can never overwrite the newer one', async () => {
    let finishOld: (r: LibrarySearchResponse) => void = () => undefined;
    vi.mocked(api.searchLibrary)
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementation(async (q) => answer(q, { songs: 1, media: 1, local: 1 }));
    const { result, rerender } = renderHook(({ text }) => useLibrarySearch(text), { initialProps: { text: 'old' } });
    await settle(300); // the first request is in flight
    rerender({ text: 'new' });
    await settle(300);
    expect(result.current.data?.q).toBe('new');
    await act(async () => { finishOld(answer('old')); });
    expect(result.current.data?.q).toBe('new');
  });

  it('a newer text aborts the request in flight', async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(api.searchLibrary).mockImplementation((_q, _s, _l, signal) => {
      if (signal) signals.push(signal);
      return new Promise(() => undefined);
    });
    const { rerender } = renderHook(({ text }) => useLibrarySearch(text), { initialProps: { text: 'first' } });
    await settle(300);
    expect(signals[0].aborted).toBe(false);
    rerender({ text: 'second' });
    expect(signals[0].aborted).toBe(true);
  });

  it('going back under 2 characters clears the answer', async () => {
    const { result, rerender } = renderHook(({ text }) => useLibrarySearch(text), { initialProps: { text: 'bassi' } });
    await settle(400);
    expect(result.current.data).not.toBeNull();
    rerender({ text: 'b' });
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeNull();
  });

  it('a failure is reported with the server’s code, and retry asks again', async () => {
    vi.mocked(api.searchLibrary).mockRejectedValueOnce(new Error('{"error":"library search failed"}'));
    const { result } = renderHook(() => useLibrarySearch('bassi'));
    await settle(400);
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('library search failed');
    expect(result.current.data).toBeNull();
    await act(async () => { result.current.retry(); });
    await settle(400);
    expect(api.searchLibrary).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ready');
  });

  it('leaves no timer behind when the page goes away', async () => {
    const { unmount } = renderHook(() => useLibrarySearch('bassi'));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await settle(1000);
    expect(api.searchLibrary).not.toHaveBeenCalled();
  });
});
