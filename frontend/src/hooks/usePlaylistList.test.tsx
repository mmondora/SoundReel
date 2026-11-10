import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYLIST_PAGE_SIZE, SEARCH_DEBOUNCE_MS, naturalOrder, usePlaylistList } from './usePlaylistList';
import * as api from '../services/api';
import type { PlaylistPage, PlaylistSummary } from '../types';

vi.mock('../services/api', () => ({ fetchPlaylistsPage: vi.fn() }));

const pl = (id: string, name = id): PlaylistSummary => ({ id, name, songCount: 1, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' });
const page = (ids: string[], total = ids.length, offset = 0): PlaylistPage => ({ playlists: ids.map((i) => pl(i)), total, limit: PLAYLIST_PAGE_SIZE, offset });

const ask = vi.mocked(api.fetchPlaylistsPage);

beforeEach(() => {
  ask.mockReset();
  ask.mockResolvedValue(page(['a', 'b']));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the list of playlists, a page at a time', () => {
  it('asks for the first page by creation date, newest first', async () => {
    const { result } = renderHook(() => usePlaylistList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ask).toHaveBeenCalledWith({ q: undefined, filter: 'all', sort: 'created', order: 'desc', limit: PLAYLIST_PAGE_SIZE, offset: 0 });
    expect(result.current.items.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.total).toBe(2);
    expect(result.current.hasMore).toBe(false);
  });

  it('«show more» asks for the next page and adds it, never the same playlist twice', async () => {
    ask.mockResolvedValueOnce(page(['a', 'b'], 4));
    const { result } = renderHook(() => usePlaylistList(2));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.hasMore).toBe(true);
    // a playlist made meanwhile shifted the pages: «b» comes again
    ask.mockResolvedValueOnce(page(['b', 'c'], 4, 2));
    act(() => result.current.more());
    await waitFor(() => expect(result.current.items.map((p) => p.id)).toEqual(['a', 'b', 'c']));
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 2, limit: 2 }));
  });

  it('does not ask for more when there is no more', async () => {
    const { result } = renderHook(() => usePlaylistList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    ask.mockClear();
    act(() => result.current.more());
    expect(ask).not.toHaveBeenCalled();
  });

  it('a filter or a sort starts again from the first page; choosing a sort puts its natural direction, the arrow flips it', async () => {
    const { result } = renderHook(() => usePlaylistList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setFilter('auto'));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ filter: 'auto', offset: 0 })));
    act(() => result.current.setSort('name'));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'name', order: 'asc', offset: 0 })));
    act(() => result.current.toggleOrder());
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'name', order: 'desc' })));
    expect(naturalOrder('created')).toBe('desc');
    expect(naturalOrder('name')).toBe('asc');
  });

  it('the search waits for a pause in the typing before it asks the server', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePlaylistList());
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10); });
    ask.mockClear();
    act(() => result.current.setQ('ja'));
    act(() => result.current.setQ('jazz'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50); });
    expect(ask).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ q: 'jazz', offset: 0 }));
    expect(result.current.narrowed).toBe(true);
  });

  it('an answer that is already out of date is ignored', async () => {
    let releaseFirst: (p: PlaylistPage) => void = () => undefined;
    ask.mockReset();
    ask.mockImplementationOnce(() => new Promise<PlaylistPage>((resolve) => { releaseFirst = resolve; }));
    ask.mockResolvedValue(page(['jazz']));
    const { result } = renderHook(() => usePlaylistList());
    act(() => result.current.setFilter('auto'));
    await waitFor(() => expect(result.current.items.map((p) => p.id)).toEqual(['jazz']));
    // the first, slower answer arrives last and must not overwrite the newer one
    await act(async () => { releaseFirst(page(['stale'])); });
    expect(result.current.items.map((p) => p.id)).toEqual(['jazz']);
  });

  it('a failure shows an empty list and says so, and a retry can clear it', async () => {
    ask.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => usePlaylistList());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.items).toEqual([]);
    await act(async () => { await result.current.reload(); });
    expect(result.current.failed).toBe(false);
    expect(result.current.items).toHaveLength(2);
  });
});
