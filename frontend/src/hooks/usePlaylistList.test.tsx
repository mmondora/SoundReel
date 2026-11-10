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

describe('the list of playlists in pages (the chooser of a playlist: a person who has a hundred does not scroll them all)', () => {
  const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => `p${from + i}`);

  it('asks the first page and says how many pages there are', async () => {
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ limit: 30, offset: 0 }));
    expect(result.current.page).toBe(1);
    expect(result.current.pageCount).toBe(3);
    expect(result.current.items).toHaveLength(30);
  });

  it('a page is asked by its offset and REPLACES the one before (it is not «show more»)', async () => {
    ask.mockResolvedValueOnce(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.items).toHaveLength(30));
    ask.mockResolvedValueOnce(page(ids(31, 30), 65, 30));
    act(() => result.current.goToPage(2));
    await waitFor(() => expect(result.current.page).toBe(2));
    await waitFor(() => expect(result.current.items[0]?.id).toBe('p31'));
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 30, limit: 30 }));
    expect(result.current.items).toHaveLength(30);
  });

  it('next and previous stop at the first and the last page; goToPage clamps what it is given', async () => {
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.prevPage());
    expect(result.current.page).toBe(1);
    act(() => result.current.goToPage(99));
    await waitFor(() => expect(result.current.page).toBe(3));
    act(() => result.current.nextPage());
    expect(result.current.page).toBe(3);
    act(() => result.current.goToPage(0));
    await waitFor(() => expect(result.current.page).toBe(1));
  });

  it('a new filter or sort goes back to the first page, with one request, not two', async () => {
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.goToPage(3));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 60 })));
    ask.mockClear();
    act(() => result.current.setFilter('auto'));
    await waitFor(() => expect(result.current.page).toBe(1));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ filter: 'auto', offset: 0 }));
  });

  it('a search, after its pause, goes back to the first page too', async () => {
    vi.useFakeTimers();
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10); });
    act(() => result.current.goToPage(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    ask.mockClear();
    act(() => result.current.setQ('jazz'));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ q: 'jazz', offset: 0 }));
    expect(result.current.page).toBe(1);
  });

  it('when the list got shorter and the page is beyond the last one, it goes to the last page', async () => {
    ask.mockResolvedValueOnce(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    ask.mockResolvedValueOnce(page(ids(61, 5), 65, 60));
    act(() => result.current.goToPage(3));
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    // now the list has only 40: page 3 does not exist any more
    ask.mockResolvedValueOnce({ playlists: [], total: 40, limit: 30, offset: 60 });
    ask.mockResolvedValueOnce(page(ids(31, 10), 40, 30));
    await act(async () => { await result.current.reload(); });
    await waitFor(() => expect(result.current.page).toBe(2));
    await waitFor(() => expect(result.current.items).toHaveLength(10));
  });

  it('«has more» means a next page exists; the default mode (show more) is unchanged', async () => {
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const paged = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(paged.result.current.loading).toBe(false));
    expect(paged.result.current.hasMore).toBe(true);
    const more = renderHook(() => usePlaylistList(30));
    await waitFor(() => expect(more.result.current.loading).toBe(false));
    expect(more.result.current.page).toBe(1);
    expect(more.result.current.hasMore).toBe(true);
    ask.mockClear();
    act(() => more.result.current.more());
    await waitFor(() => expect(ask).toHaveBeenCalledWith(expect.objectContaining({ offset: 30 })));
    // and in pages mode «show more» does nothing: a page replaces a page
    ask.mockClear();
    act(() => paged.result.current.more());
    expect(ask).not.toHaveBeenCalled();
  });

  it('a page that is out of range is never asked for, only the first or the last one', async () => {
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.goToPage(99));
    await waitFor(() => expect(result.current.page).toBe(3));
    expect(ask.mock.calls.every(([query]) => (query?.offset ?? 0) <= 60)).toBe(true);
  });

  it('a new sort, or the arrow that flips the order, also goes back to the first page with one request', async () => {
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.goToPage(3));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 60 })));
    ask.mockClear();
    act(() => result.current.setSort('name'));
    await waitFor(() => expect(result.current.page).toBe(1));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'name', offset: 0 }));
    act(() => result.current.goToPage(2));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 30 })));
    ask.mockClear();
    act(() => result.current.toggleOrder());
    await waitFor(() => expect(result.current.page).toBe(1));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ order: 'desc', offset: 0 }));
  });

  it('the pause of the search does not undo a page the person chose in the meantime (nothing was typed)', async () => {
    vi.useFakeTimers();
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => result.current.goToPage(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 50); });
    expect(result.current.page).toBe(2);
  });

  it('«has more» is false on the last page, whatever has been drawn so far', async () => {
    ask.mockResolvedValue(page(ids(1, 30), 65));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.goToPage(3));
    await waitFor(() => expect(result.current.page).toBe(3));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 60 })));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  it('«reload» asks again for the page that is open, not for the first', async () => {
    ask.mockResolvedValue(page(ids(31, 30), 65, 30));
    const { result } = renderHook(() => usePlaylistList(30, {}, 'pages'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.goToPage(2));
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 30 })));
    ask.mockClear();
    await act(async () => { await result.current.reload(); });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ offset: 30 }));
  });
});
