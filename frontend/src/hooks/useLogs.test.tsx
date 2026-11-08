import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useLogs } from './useLogs';
import * as api from '../services/api';
import type { LogFilters } from '../types';

vi.mock('../services/api', () => ({
  getLogs: vi.fn(),
  clearLogs: vi.fn(),
}));

const row = (id: number, category: string, extra: Record<string, unknown> = {}) => ({
  id, ts: '2026-11-08T07:00:00.000Z', level: 'info', category, entryId: null, message: `${category} ${id}`,
  data: { function: category, durationMs: null, data: extra.data ?? null, error: null },
});

const FILTERS: LogFilters = { level: 'all', function: 'all', entryId: null, search: '' };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

const lastCall = () => vi.mocked(api.getLogs).mock.calls[vi.mocked(api.getLogs).mock.calls.length - 1][0];

describe('useLogs: the function filter goes to the server as `category`', () => {
  it('"all" sends no category and still asks for 200 lines', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([row(1, 'jobQueueWorker')]);
    const { result } = renderHook(() => useLogs(FILTERS));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lastCall()).toMatchObject({ category: undefined, limit: 200 });
  });

  it('one function = that category', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([row(1, 'sync')]);
    const { result } = renderHook(() => useLogs({ ...FILTERS, function: 'sync' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lastCall()).toMatchObject({ category: 'sync' });
  });

  it('"Attività" sends the four activity categories', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([row(1, 'playlist'), row(2, 'download')]);
    const { result } = renderHook(() => useLogs({ ...FILTERS, function: '@activity' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lastCall()).toMatchObject({ category: 'playlist,sync,download,device' });
    expect(result.current.logs.map((l) => l.function)).toEqual(['playlist', 'download']);
  });

  it('level and entry id are still sent next to it', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([]);
    const { result } = renderHook(() => useLogs({ ...FILTERS, level: 'error', entryId: 'abc', function: 'device' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(lastCall()).toEqual({ level: 'error', entryId: 'abc', category: 'device', limit: 200 });
  });

  it('changing the function fetches again with the new category', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([]);
    const { result, rerender } = renderHook(({ f }: { f: LogFilters }) => useLogs(f), { initialProps: { f: FILTERS } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ f: { ...FILTERS, function: 'download' } });
    await waitFor(() => expect(lastCall()).toMatchObject({ category: 'download' }));
  });
});

describe('useLogs: what the client keeps doing', () => {
  it('an old backend that ignores `category` still gets filtered client-side', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([row(1, 'jobQueueWorker'), row(2, 'sync'), row(3, 'contentExtractor'), row(4, 'playlist')]);
    const { result } = renderHook(() => useLogs({ ...FILTERS, function: '@activity' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.logs.map((l) => l.function)).toEqual(['sync', 'playlist']);
  });

  it('the function list keeps everything ever seen: filtering by one category must not collapse the select', async () => {
    vi.mocked(api.getLogs).mockResolvedValueOnce([row(1, 'jobQueueWorker'), row(2, 'share')]);
    const { result, rerender } = renderHook(({ f }: { f: LogFilters }) => useLogs(f), { initialProps: { f: FILTERS } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.availableFunctions).toEqual(expect.arrayContaining(['jobQueueWorker', 'share']));

    vi.mocked(api.getLogs).mockResolvedValue([row(3, 'sync')]);
    rerender({ f: { ...FILTERS, function: 'sync' } });
    await waitFor(() => expect(result.current.logs.map((l) => l.function)).toEqual(['sync']));
    expect(result.current.availableFunctions).toEqual(expect.arrayContaining(['jobQueueWorker', 'share', 'sync']));
  });

  it('always offers the activity categories, even before any such line exists', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([]);
    const { result } = renderHook(() => useLogs(FILTERS));
    expect(result.current.availableFunctions).toEqual(expect.arrayContaining(['playlist', 'sync', 'download', 'device']));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('exposes the activity data (action + actor) of a line', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([
      row(1, 'sync', { data: { action: 'prepare', actor: { user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' } } }),
    ]);
    const { result } = renderHook(() => useLogs({ ...FILTERS, function: '@activity' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.logs[0].data).toEqual({ action: 'prepare', actor: { user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' } });
  });

  it('the text search still filters client-side', async () => {
    vi.mocked(api.getLogs).mockResolvedValue([row(1, 'playlist'), row(2, 'sync')]);
    const { result } = renderHook(() => useLogs({ ...FILTERS, search: 'sync 2' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.logs.map((l) => l.id)).toEqual(['2']);
  });

  it('a failing request shows the error and keeps working', async () => {
    vi.mocked(api.getLogs).mockRejectedValue(new Error('HTTP 500'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useLogs(FILTERS));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await act(async () => { await result.current.clearLogs(); });
    expect(api.clearLogs).toHaveBeenCalled();
  });
});
