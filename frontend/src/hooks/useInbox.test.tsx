import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FACETS_REFRESH_MS, INBOX_PAGE_SIZE, STREAM_REFRESH_MS, useInbox } from './useInbox';
import * as api from '../services/api';
import type { EntryFacets, EntrySummary, InboxFilter } from '../types';

// The Inbox, a page of the whole library at a time (Michele, 10 November: «la paginazione con 30 o 40 per pagina», docs/entries-index.md): the server
// gives the page, the total and the facets; this keeps them, drops an answer that is out of date, and reads the page again when the library changes.

vi.mock('../services/api', () => ({
  listEntrySummaries: vi.fn(),
  fetchEntryFacets: vi.fn(),
  openEntryStream: vi.fn(),
}));

const ask = vi.mocked(api.listEntrySummaries);
const facets = vi.mocked(api.fetchEntryFacets);
const stream = vi.mocked(api.openEntryStream);

const row = (id: string): EntrySummary => ({
  id, sourceUrl: `https://instagram.com/reel/${id}`, sourcePlatform: 'instagram', caption: null, thumbnailUrl: null, status: 'completed',
  createdAt: '2026-11-10T10:00:00.000Z', summary: id, songCount: 0, filmCount: 0, noteCount: 0, tags: [],
});
const page = (ids: string[], total = ids.length, offset = 0) => ({ entries: ids.map(row), total, limit: INBOX_PAGE_SIZE, offset });
const EMPTY_FACETS: EntryFacets = { platforms: [], channels: [], users: [], categories: [], verdicts: [], tags: [] };

let emit: () => void = () => undefined;
const closeStream = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  ask.mockResolvedValue(page(['a', 'b'], 1721));
  facets.mockResolvedValue({ ...EMPTY_FACETS, platforms: [{ platform: 'instagram', count: 900 }] });
  stream.mockImplementation((onEvent) => {
    emit = () => onEvent({} as never);
    return closeStream;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Inbox — the page', () => {
  it('asks the first page of the whole library, 40 posts, and says how many pages there are', async () => {
    const { result } = renderHook(() => useInbox(1, {}));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ask).toHaveBeenCalledWith(40, 0, {});
    expect(result.current.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.current.total).toBe(1721);
    expect(result.current.pageCount).toBe(44);
    expect(INBOX_PAGE_SIZE).toBe(40);
  });

  it('a later page is asked by its offset, and moving to another page asks again', async () => {
    const { result, rerender } = renderHook(({ p }) => useInbox(p, {}), { initialProps: { p: 3 } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ask).toHaveBeenLastCalledWith(40, 80, {});
    ask.mockResolvedValueOnce(page(['c'], 1721, 120));
    rerender({ p: 4 });
    await waitFor(() => expect(result.current.entries.map((e) => e.id)).toEqual(['c']));
    expect(ask).toHaveBeenLastCalledWith(40, 120, {});
  });

  it('a filter goes to the server, and the page and the total are those of the filtered library', async () => {
    const filter: InboxFilter = { platform: 'tiktok', tag: '#vino' };
    ask.mockResolvedValue(page(['t1'], 7));
    const { result } = renderHook(() => useInbox(1, filter));
    await waitFor(() => expect(result.current.total).toBe(7));
    expect(ask).toHaveBeenCalledWith(40, 0, { platform: 'tiktok', tag: '#vino' });
    expect(result.current.pageCount).toBe(1);
  });

  it('a different filter asks again (even with the same page)', async () => {
    const { result, rerender } = renderHook(({ f }) => useInbox(1, f), { initialProps: { f: {} as InboxFilter } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    ask.mockResolvedValueOnce(page(['x'], 3));
    rerender({ f: { platform: 'youtube' } });
    await waitFor(() => expect(result.current.total).toBe(3));
    expect(ask).toHaveBeenLastCalledWith(40, 0, { platform: 'youtube' });
  });

  it.each(['platform', 'channel', 'user', 'category', 'verdict', 'tag'] as const)('a different «%s» asks again', async (key) => {
    const { result, rerender } = renderHook(({ f }) => useInbox(1, f), { initialProps: { f: {} as InboxFilter } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    ask.mockClear();
    rerender({ f: { [key]: 'x' } });
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith(40, 0, { [key]: 'x' });
  });

  it('the same filter written again (a new object with the same values) does not ask again', async () => {
    const { result, rerender } = renderHook(({ f }) => useInbox(1, f), { initialProps: { f: { platform: 'youtube' } as InboxFilter } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    ask.mockClear();
    rerender({ f: { platform: 'youtube' } });
    await new Promise((r) => { setTimeout(r, 30); });
    expect(ask).not.toHaveBeenCalled();
  });

  it('an answer that is already out of date is ignored', async () => {
    let releaseFirst: (p: ReturnType<typeof page>) => void = () => undefined;
    ask.mockReset();
    ask.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));
    ask.mockResolvedValue(page(['fresh'], 1));
    const { result, rerender } = renderHook(({ p }) => useInbox(p, {}), { initialProps: { p: 1 } });
    rerender({ p: 2 });
    await waitFor(() => expect(result.current.entries.map((e) => e.id)).toEqual(['fresh']));
    await act(async () => { releaseFirst(page(['stale'], 1)); });
    expect(result.current.entries.map((e) => e.id)).toEqual(['fresh']);
  });

  it('a failure says so, with no posts, and «reload» tries again', async () => {
    ask.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useInbox(1, {}));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.entries).toEqual([]);
    ask.mockResolvedValue(page(['a'], 1));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.error).toBe(false);
  });
});

describe('the Inbox — it follows the library', () => {
  it('a change of the library reads the page again after a short pause, once however many changes there are, without a flash of «loading»', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInbox(1, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.loading).toBe(false);
    ask.mockClear();
    ask.mockResolvedValue(page(['new', 'a', 'b'], 1722));
    act(() => { emit(); emit(); emit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REFRESH_MS - 50); });
    expect(ask).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.entries.map((e) => e.id)).toEqual(['new', 'a', 'b']);
    expect(result.current.total).toBe(1722);
  });

  it('`version` goes up with every change, so the post that is open is read again', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInbox(1, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const before = result.current.version;
    act(() => emit());
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REFRESH_MS + 50); });
    expect(result.current.version).toBeGreaterThan(before);
  });

  it('a page that cannot be read again leaves the posts that are on the screen', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInbox(1, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    ask.mockRejectedValueOnce(new Error('down'));
    act(() => emit());
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REFRESH_MS + 50); });
    expect(result.current.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.current.error).toBe(false);
  });

  it('closes the stream when the page goes away, and a late change does nothing', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useInbox(1, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => emit());
    unmount();
    expect(closeStream).toHaveBeenCalledTimes(1);
    ask.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REFRESH_MS + 50); });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('the Inbox — the facets', () => {
  it('are asked once, over the whole library (they do not follow the page or the filter)', async () => {
    const { result, rerender } = renderHook(({ p, f }) => useInbox(p, f), { initialProps: { p: 1, f: {} as InboxFilter } });
    await waitFor(() => expect(result.current.facets?.platforms).toHaveLength(1));
    rerender({ p: 2, f: { platform: 'tiktok' } });
    await waitFor(() => expect(ask).toHaveBeenLastCalledWith(40, 40, { platform: 'tiktok' }));
    expect(facets).toHaveBeenCalledTimes(1);
  });

  it('are read again after a change of the library, but not at every change (at most once in a while)', async () => {
    vi.useFakeTimers();
    renderHook(() => useInbox(1, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(facets).toHaveBeenCalledTimes(1);
    act(() => emit());
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REFRESH_MS + 50); });
    expect(facets).toHaveBeenCalledTimes(1);        // too soon
    await act(async () => { await vi.advanceTimersByTimeAsync(FACETS_REFRESH_MS); });
    act(() => emit());
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REFRESH_MS + 50); });
    expect(facets).toHaveBeenCalledTimes(2);
  });

  it('facets that were read stay when a later read of them fails', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInbox(1, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.facets?.platforms).toHaveLength(1);
    facets.mockRejectedValue(new Error('down'));
    await act(async () => { await vi.advanceTimersByTimeAsync(FACETS_REFRESH_MS); });
    act(() => emit());
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_REFRESH_MS + 50); });
    expect(facets).toHaveBeenCalledTimes(2);
    expect(result.current.facets?.platforms).toHaveLength(1);
  });

  it('a failure to read them does not touch the list: there are just no facets', async () => {
    facets.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useInbox(1, {}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.facets).toBeNull();
  });
});
